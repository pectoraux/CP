// /api/internal/handlers-connections.ts
// WORK-010 transport routes for /connections (architecture §23, §34, §36,
// lock §8, §9, §10, WORK-010 §23-§25). The API layer is a transport
// boundary only: it imports only the PUBLIC interfaces of @cp/connections
// and @cp/credentials (and @cp/platform for the runtime, @cp/auth for the
// Principal), never any module's internals. Authorization happens at the
// domain service boundary (ConnectionsService re-verifies active
// membership + admin/owner role server-side) on top of the standard
// WORK-004 tenant gates.
//
// Routes (all under /v1/organizations/:orgId/projects/:projectId, gated
// by orgContextMiddleware + projectContextMiddleware — the org/project
// ids passed to the service are the RESOLVED authorized values, never raw
// path params):
//   POST   .../connections                                  — create (metadata only; admin, idempotent)
//   GET    .../connections                                  — list (paginated, member)
//   GET    .../connections/:connectionId                    — get (member)
//   PATCH  .../connections/:connectionId                    — update label/config (admin, idempotent)
//   POST   .../connections/:connectionId/lifecycle          — transition (admin, idempotent)
//   POST   .../connections/:connectionId/verify             — STRUCTURAL verification (admin, idempotent)
//   POST   .../connections/:connectionId/credential         — attach/replace credential (admin;
//                                                              SECRET-BEARING: redacted-fingerprint idempotency)
//   DELETE .../connections/:connectionId/credential         — detach + revoke credential (admin, idempotent)
//
// SECRET SAFETY (§24-§25, §28-§29): the credential-attach endpoint is the
// ONLY secret-bearing route. Its idempotency fingerprint replaces the
// secret_value with sha256(secret_value) BEFORE the fingerprint is
// computed, so the RAW SECRET NEVER reaches cp_idempotency — only an
// irreversible, redacted fingerprint (same key + different secret → 409,
// never silent replay). Responses contain metadata ONLY (kind, name,
// credential_configured, status — never the secret, never ciphertext,
// never storage keys). Structured logs carry ids/statuses only. There is
// deliberately NO HTTP endpoint that resolves secret material (§8-§10:
// resolution belongs to the future execution/provider-adapter boundary).

import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { Runtime } from "@cp/platform";
import type { AuthService } from "@cp/auth";
import type { Principal } from "@cp/auth";
import type { OrganizationsService } from "@cp/organizations";
import type { ProjectsService } from "@cp/projects";
import {
  ConnectionsService,
  type Connection,
  type ConnectionStatus,
  isConnectionStatus,
} from "@cp/connections";
import { CREDENTIAL_KINDS } from "@cp/credentials";
import {
  authMiddleware,
  orgContextMiddleware,
  projectContextMiddleware,
  type AuthVars,
} from "./middleware.ts";
import { IdempotencyStore, withIdempotency } from "./idempotency.ts";

export interface ConnectionRouteDeps {
  runtime: Runtime;
  auth: AuthService;
  orgs: OrganizationsService;
  projects: ProjectsService;
  connections: ConnectionsService;
  idempotency: IdempotencyStore;
}

/**
 * WORK-010 §25: redact secret-bearing fields from the request body text
 * before idempotency fingerprinting. Replaces every top-level
 * "secret_value" property with sha256(its string value) so:
//   - identical logical requests (same secret) → identical fingerprints
//   - the RAW secret never enters cp_idempotency (only its one-way hash
//     inside the composite fingerprint)
 */
function redactSecretFingerprint(bodyText: string): string {
  if (bodyText === "") return bodyText;
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return bodyText;
    }
    if (typeof parsed.secret_value === "string") {
      const redacted = {
        ...parsed,
        secret_value: `sha256:${createHash("sha256").update(parsed.secret_value, "utf8").digest("hex")}`,
      };
      return JSON.stringify(redacted);
    }
    return bodyText;
  } catch {
    return bodyText;
  }
}

export function createConnectionRoutes(
  deps: ConnectionRouteDeps,
  app: Hono<{ Variables: AuthVars }>,
): void {
  const { runtime, auth, orgs, projects, connections, idempotency } = deps;

  const base = "/v1/organizations/:orgId/projects/:projectId/connections";

  // ---- Create connection (metadata only; admin, idempotent) --------------

  app.post(
    base,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const providerId = String(body?.provider_id ?? "").trim();
        if (!providerId) {
          return validationError(c, "provider_id is required");
        }
        const connection = await connections.createConnection({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          providerId,
          capabilityId:
            body?.capability_id === undefined || body?.capability_id === null || body?.capability_id === ""
              ? undefined
              : String(body.capability_id),
          capabilityVersion:
            body?.capability_version === undefined || body?.capability_version === null || body?.capability_version === ""
              ? undefined
              : String(body.capability_version),
          environment:
            body?.environment === undefined || body?.environment === null || body?.environment === ""
              ? undefined
              : String(body.environment),
          label: body?.label === undefined || body?.label === null ? undefined : String(body.label),
          configuration:
            body?.configuration && typeof body.configuration === "object" && !Array.isArray(body.configuration)
              ? (body.configuration as Record<string, unknown>)
              : undefined,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ connection: serializeConnection(connection) }, 201);
      });
    },
  );

  // ---- List connections (member, paginated) --------------------------------

  app.get(
    base,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const limitRaw = Number(c.req.query("limit") ?? 25);
      const statusParam = c.req.query("status");
      let status: ConnectionStatus | undefined;
      if (statusParam !== undefined && statusParam !== "") {
        if (!isConnectionStatus(statusParam)) {
          return validationError(c, `unknown connection status "${statusParam}"`);
        }
        status = statusParam;
      }
      const page = await connections.listConnections(
        orgCtx.organizationId,
        pctx.projectId,
        orgCtx.principal,
        {
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          cursor: c.req.query("cursor") ?? null,
          providerId: c.req.query("provider_id") ?? undefined,
          status,
          includeRevoked: c.req.query("include_revoked") === "true",
        },
      );
      return c.json({
        connections: page.connections.map(serializeConnection),
        next_cursor: page.nextCursor,
      });
    },
  );

  // ---- Get connection (member) ----------------------------------------------

  app.get(
    `${base}/:connectionId`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const connection = await connections.getConnection(
        orgCtx.organizationId,
        pctx.projectId,
        String(c.req.param("connectionId")),
        orgCtx.principal,
      );
      if (!connection) {
        return notFound(c, "connection.not_found", `connection "${String(c.req.param("connectionId"))}" was not found`);
      }
      return c.json({ connection: serializeConnection(connection) });
    },
  );

  // ---- Update label/configuration (admin, idempotent) -------------------------

  app.patch(
    `${base}/:connectionId`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const connection = await connections.updateConnection({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          connectionId: String(c.req.param("connectionId")),
          label: body?.label === undefined || body?.label === null ? undefined : String(body.label),
          configuration:
            body?.configuration && typeof body.configuration === "object" && !Array.isArray(body.configuration)
              ? (body.configuration as Record<string, unknown>)
              : undefined,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ connection: serializeConnection(connection) });
      });
    },
  );

  // ---- Lifecycle transition (admin, idempotent) ---------------------------------

  app.post(
    `${base}/:connectionId/lifecycle`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const toStatus = String(body?.status ?? "");
        if (!isConnectionStatus(toStatus)) {
          return validationError(c, `status must be one of draft|active|paused|revoked (got "${toStatus}")`);
        }
        const connection = await connections.transitionConnection({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          connectionId: String(c.req.param("connectionId")),
          toStatus,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ connection: serializeConnection(connection) });
      });
    },
  );

  // ---- Structural verification (admin, idempotent; NO provider calls) ------------

  app.post(
    `${base}/:connectionId/verify`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (_body) => {
        const connection = await connections.verifyConnection({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          connectionId: String(c.req.param("connectionId")),
          actingPrincipal: orgCtx.principal,
        });
        return c.json({
          connection: serializeConnection(connection),
          verification: connection.verificationResult,
        });
      });
    },
  );

  // ---- Attach/replace credential (admin; SECRET-BEARING — redacted idempotency) -----

  app.post(
    `${base}/:connectionId/credential`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      // SECRET-SAFE IDEMPOTENCY (WORK-010 §24-§25): the fingerprint is
      // computed over the body with secret_value replaced by its SHA-256 —
      // the raw secret NEVER reaches cp_idempotency. Same key + different
      // secret → different fingerprint → 409 (no silent replay).
      return withIdempotency(
        c,
        idempotency,
        orgCtx.principal,
        async (body) => {
          const kind = String(body?.kind ?? "");
          if (!(CREDENTIAL_KINDS as readonly string[]).includes(kind)) {
            return validationError(c, `kind must be one of ${CREDENTIAL_KINDS.join("|")}`);
          }
          const name = String(body?.name ?? "").trim();
          if (!name) {
            return validationError(c, "name is required");
          }
          if (typeof body?.secret_value !== "string" || body.secret_value.length === 0) {
            return validationError(c, "secret_value is required");
          }
          const connection = await connections.attachCredential({
            organizationId: orgCtx.organizationId,
            projectId: pctx.projectId,
            connectionId: String(c.req.param("connectionId")),
            kind,
            name,
            secret: body.secret_value,
            actingPrincipal: orgCtx.principal,
          });
          // The response carries metadata ONLY — never the secret, never
          // ciphertext, never the storage key.
          return c.json({ connection: serializeConnection(connection) }, 201);
        },
        { fingerprintBody: redactSecretFingerprint },
      );
    },
  );

  // ---- Detach + revoke credential (admin, idempotent) --------------------------------

  app.delete(
    `${base}/:connectionId/credential`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (_body) => {
        const connection = await connections.detachCredential({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          connectionId: String(c.req.param("connectionId")),
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ connection: serializeConnection(connection) });
      });
    },
  );

  void (null as unknown as Principal);
}

// ---- Serializer (explicit allowlist: SAFE metadata only — never secrets) ---------

function serializeConnection(conn: Connection) {
  return {
    id: conn.id,
    project_id: conn.projectId,
    provider_id: conn.providerId,
    capability: conn.capabilityCanonicalId
      ? {
          capability_id: conn.capabilityCanonicalId,
          capability_version: conn.capabilityVersion,
        }
      : null,
    environment: conn.environment,
    label: conn.label,
    configuration: conn.configuration,
    credential: conn.credentialId
      ? {
          // §19: safe metadata only — never the reference's storage
          // internals, never ciphertext, never values.
          credential_configured: conn.credentialConfigured,
          credential_kind: conn.credentialKind,
          credential_status: conn.credentialStatus,
        }
      : null,
    status: conn.status,
    last_verified_at: conn.lastVerifiedAt ? conn.lastVerifiedAt.toISOString() : null,
    verification_result: conn.verificationResult,
    created_by_user_id: conn.createdByUserId,
    created_at: conn.createdAt.toISOString(),
    updated_at: conn.updatedAt.toISOString(),
  };
}

function validationError(c: { json: (b: unknown, s: number) => Response; get: (k: "requestId") => string }, message: string): Response {
  return c.json(
    {
      error: {
        category: "POLICY_BLOCKED",
        code: "connection.validation",
        message,
        retryable: false,
        request_id: c.get("requestId"),
      },
    },
    400,
  );
}

function notFound(c: { json: (b: unknown, s: number) => Response; get: (k: "requestId") => string }, code: string, message: string): Response {
  return c.json(
    {
      error: {
        category: "POLICY_BLOCKED",
        code,
        message,
        retryable: false,
        request_id: c.get("requestId"),
      },
    },
    404,
  );
}
