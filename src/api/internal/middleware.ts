// /api/internal/middleware.ts
// Transport-boundary middleware. WORK-001 middleware (correlationMiddleware,
// errorMiddleware) is preserved. WORK-003 adds:
//   - authMiddleware: extract+verify credential IF present, build the
//     Principal (auth verifies identity → userId; orgs loads memberships
//     → /auth.buildPrincipal assembles), extend ExecutionContext with
//     userId. Never fails on missing credential — route handlers /
//     orgContext enforce presence. Fails (401) on malformed/expired/
//     revoked credential.
//   - orgContextMiddleware: require a Principal (401), resolve the
//     server-side tenant context from the :orgId path param via
//     OrganizationsService.resolveOrgContext (403 POLICY_BLOCKED if not an
//     active member). The org_id in the path is a REQUESTED TARGET; the
//     Principal's active membership is what grants access (WORK-003 §7).
//   - requirePrincipal: thin gate for protected non-tenant routes
//     (GET /v1/auth/me) — 401 if no principal.
//
// Request lifecycle (architecture WORK-003 §11):
//   HTTP → request ID → authentication → principal → organization context
//         → authorization → domain operation

import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  newRequestId,
  runInContextAsync,
  withContext,
  type Runtime,
  type ExecutionContext,
} from "@cp/platform";
import { AppError } from "@cp/platform";
import type { AuthService, Principal } from "@cp/auth";
import type { OrganizationsService, OrgContext } from "@cp/organizations";
import type { ProjectsService, ProjectContext } from "@cp/projects";

// The Hono app-wide variables. Extended from WORK-001's { requestId } to
// carry the resolved Principal, OrgContext (WORK-003), and ProjectContext
// (WORK-004) through the request.
export interface AuthVars {
  requestId: string;
  principal?: Principal;
  orgContext?: OrgContext;
  projectContext?: ProjectContext;
}

/** Backwards-compatible alias for the WORK-001 variables shape. */
export type Vars = AuthVars;

export type ApiContext = Context<{ Variables: AuthVars }>;

// ---- WORK-001 middleware (preserved) ---------------------------------

export function correlationMiddleware(
  runtime: Runtime,
): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && incoming.length > 0
      ? incoming
      : newRequestId();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    const start = performance.now();
    const method = c.req.method;
    const path = c.req.path;
    runtime.logger.info("api: request.start", { method, path });
    // Run the rest of the chain in an execution context that carries the
    // request id; authMiddleware will extend it with userId/organizationId.
    await runInContextAsync({ requestId } as ExecutionContext, async () => {
      await next();
    });
    const elapsedMs = Math.round(performance.now() - start);
    runtime.logger.info("api: request.end", {
      method,
      path,
      status: c.res.status,
      elapsed_ms: elapsedMs,
    });
  };
}

const STATUS_BY_CATEGORY: Record<string, ContentfulStatusCode> = {
  PROVIDER_FAILURE: 502,
  NETWORK_FAILURE: 502,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  POLICY_BLOCKED: 403,
  INELIGIBLE: 422,
  CREDENTIAL_FAILURE: 401,
  EXECUTION_FAILURE: 500,
  OUTCOME_FAILURE: 500,
  PLATFORM_FAILURE: 500,
  EXPERIMENT_FAILURE: 500,
};

export function errorMiddleware(): MiddlewareHandler<{
  Variables: AuthVars;
}> {
  // Hono v4 does NOT propagate thrown errors from route handlers/middleware
  // up to upstream `app.use` middleware try/catch — throws are intercepted
  // by Hono's internal error handling and returned as a default 500. To
  // catch throws and translate them to structured JSON responses, use
  // `app.onError(errorHandler())`. This middleware is kept as a pass-through
  // for backwards compatibility (WORK-001 registered it) and to preserve a
  // single middleware chain shape, but it does not need a try/catch.
  return async (_c, next) => {
    await next();
  };
}

/**
 * The actual error handler — register via `app.onError(errorHandler())`.
 * Catches every thrown error from any middleware or route handler and
 * translates it into a structured JSON response using the AppError failure
 * model (architecture §31). Authentication failures (CREDENTIAL_FAILURE)
 * → 401; authorization failures (POLICY_BLOCKED) → 403; etc.
 */
export function errorHandler(): (
  err: unknown,
  c: Context<{ Variables: AuthVars }>,
) => Response {
  return (err, c) => {
    const requestId = c.get("requestId");
    if (err instanceof AppError) {
      const status: ContentfulStatusCode =
        STATUS_BY_CATEGORY[err.category] ?? 500;
      // Expose `details` for non-credential failures so clients can see
      // the rejection reason (e.g. "insufficient_permission"). For
      // CREDENTIAL_FAILURE, details are omitted to prevent account
      // enumeration (unknown-user vs wrong-password must be
      // indistinguishable to the caller — WORK-003 §12).
      const errorBody: Record<string, unknown> = {
        category: err.category,
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        request_id: requestId,
      };
      if (err.category !== "CREDENTIAL_FAILURE" && Object.keys(err.details).length > 0) {
        errorBody.details = err.details;
      }
      return c.json({ error: errorBody }, status);
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        error: {
          category: "PLATFORM_FAILURE",
          code: "api.unhandled",
          message,
          retryable: false,
          request_id: requestId,
        },
      },
      500,
    );
  };
}

// ---- WORK-003 auth + tenant-isolation middleware ---------------------

/**
 * Extract the bearer credential. Supports two header forms (both carry the
 * same opaque `cpkey_...` token):
 *   - `Authorization: Bearer <token>` (preferred)
 *   - `X-API-Key: <token>` (alternative for clients that cannot set Auth)
 * Returns null if no credential is present.
 */
function extractCredential(c: Context<{ Variables: AuthVars }>): string | null {
  const auth = c.req.header("authorization");
  if (auth && auth.length > 0) {
    if (auth.toLowerCase().startsWith("bearer ")) {
      const tok = auth.slice(7).trim();
      if (tok.length > 0) return tok;
    }
    // Non-bearer Authorization → return as-is so verifyApiKey reports
    // malformed (401) rather than silently treating as unauthenticated.
    return auth;
  }
  const xKey = c.req.header("x-api-key");
  if (xKey && xKey.length > 0) return xKey;
  return null;
}

/**
 * Authentication middleware. Verifies the presented credential (if any),
 * builds the Principal (auth verifies identity → userId; orgs loads
 * memberships → auth.buildPrincipal assembles), and stores it on the
 * request. Missing credential is not an error — use requirePrincipal or
 * orgContextMiddleware to enforce presence.
 *
 * A malformed/expired/revoked credential IS an error (401) so callers
 * learn about stale credentials immediately.
 */
export function authMiddleware(
  _runtime: Runtime,
  auth: AuthService,
  orgs: OrganizationsService,
): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const rawCredential = extractCredential(c);
    if (rawCredential === null) {
      await next();
      return;
    }
    // verifyApiKey throws CREDENTIAL_FAILURE (→ 401) on any failure.
    const { userId } = await auth.verifyApiKey(rawCredential);
    // Build the Principal: /auth verified identity (userId); /organizations
    // loads the resolved memberships (role → permissions). The Principal
    // is the explicit authenticated-context object (WORK-003 §3).
    const principal = await orgs.buildPrincipalForUser(userId);
    c.set("principal", principal);
    // Run the downstream chain in an execution context that extends the
    // current (request-id-bearing) context with userId, so logs/metrics
    // for the rest of this request carry the authenticated user.
    const ctx = withContext({ userId } as ExecutionContext);
    await runInContextAsync(ctx, async () => {
      await next();
    });
  };
}

/**
 * Require an authenticated principal. Use on protected non-tenant routes
 * (GET /v1/auth/me). Throws CREDENTIAL_FAILURE (→ 401) if no principal.
 */
export function requirePrincipal(): MiddlewareHandler<{
  Variables: AuthVars;
}> {
  return async (c, next) => {
    const p = c.get("principal");
    if (!p) {
      throw new AppError({
        category: "CREDENTIAL_FAILURE",
        code: "auth.required",
        message: "authentication is required",
        retryable: false,
      });
    }
    await next();
  };
}

/**
 * Tenant-isolation middleware. For routes with an `:orgId` path param:
 * require a principal (401 if absent) and resolve the server-side tenant
 * context (403 POLICY_BLOCKED if not an active member). The resolved
 * OrgContext is `c.get('orgContext')` and its organizationId is the
 * AUTHORIZED one — downstream handlers must use it, never the raw path
 * param.
 */
export function orgContextMiddleware(
  _runtime: Runtime,
  orgs: OrganizationsService,
): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal) {
      throw new AppError({
        category: "CREDENTIAL_FAILURE",
        code: "auth.required",
        message: "authentication is required",
        retryable: false,
      });
    }
    const requestedOrgId = c.req.param("orgId");
    if (typeof requestedOrgId !== "string" || requestedOrgId.length === 0) {
      throw new AppError({
        category: "PLATFORM_FAILURE",
        code: "organization.id.required",
        message: "organization id is required",
        retryable: false,
      });
    }
    // The server-side tenant gate. requestedOrgId is only a TARGET; the
    // principal's ACTIVE membership is what grants access. A caller who
    // authenticates as User A in Org A and supplies Org B's id fails here.
    const ctx = await orgs.resolveOrgContext(principal, requestedOrgId);
    c.set("orgContext", ctx);
    // Extend the execution context with the AUTHORIZED organization id for
    // the downstream chain. Using ctx.organizationId (the resolved,
    // verified one), not the raw path param.
    const execCtx = withContext({
      organizationId: ctx.organizationId,
    } as ExecutionContext);
    await runInContextAsync(execCtx, async () => {
      await next();
    });
  };
}

// ---- WORK-004 project-level tenant-scoping middleware ----------------

/**
 * Project-level tenant-scoping middleware (WORK-004). For routes with a
 * `:projectId` path param (under an already-org-resolved `:orgId`): resolve
 * the project via ProjectsService.resolveProjectContext against the
 * AUTHORIZED org id from `orgContext` (set by orgContextMiddleware). Throws
 * POLICY_BLOCKED (project.not_found) if the project does not exist in this
 * org — the existence of a project in a different org is never leaked to a
 * caller who has no membership there.
 *
 * The resolved ProjectContext is `c.get('projectContext')` and its
 * projectId/organizationId are the AUTHORIZED ones — downstream handlers
 * must use them, never the raw path params.
 *
 * This middleware MUST run after orgContextMiddleware so that the org-level
 * gate (principal is an active member of :orgId) has already passed and the
 * authorized org id is available.
 */
export function projectContextMiddleware(
  _runtime: Runtime,
  projects: ProjectsService,
): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const orgCtx = c.get("orgContext");
    if (!orgCtx) {
      // Programmer error: projectContextMiddleware used without a prior
      // orgContextMiddleware on the route. Surface as a structured
      // platform failure rather than a confusing null deref downstream.
      throw new AppError({
        category: "PLATFORM_FAILURE",
        code: "project.context.org_required",
        message: "project context requires a resolved organization context",
        retryable: false,
      });
    }
    const requestedProjectId = c.req.param("projectId");
    if (typeof requestedProjectId !== "string" || requestedProjectId.length === 0) {
      throw new AppError({
        category: "POLICY_BLOCKED",
        code: "project.id.required",
        message: "project id is required",
        retryable: false,
      });
    }
    // The server-side project-level gate. requestedProjectId is only a
    // TARGET; the project must belong to the AUTHORIZED organization.
    const projectCtx = await projects.resolveProjectContext(
      orgCtx.organizationId,
      requestedProjectId,
    );
    c.set("projectContext", projectCtx);
    await next();
  };
}
