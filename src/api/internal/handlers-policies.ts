// /api/internal/handlers-policies.ts
// WORK-008 transport routes for /policies (architecture §10, §23, §34,
// §35, §36, lock §8, §9, WORK-008 §19-§20). The API layer is a transport
// boundary only: it imports only the PUBLIC interface of @cp/policies
// (and @cp/platform for the runtime, @cp/auth for the Principal), never
// any module's internals. Authorization happens at the domain service
// boundary (PoliciesService re-verifies active membership + admin/owner
// role server-side) on top of the standard tenant gates.
//
// Routes (all under /v1/organizations/:orgId/projects/:projectId/policies
// — the WORK-004 project-route conventions: orgContextMiddleware resolves
// the AUTHORIZED org, projectContextMiddleware verifies the project
// belongs to that org; the org/project ids passed to the service are the
// RESOLVED values, never raw path params):
//   POST   .../policies                                  — create policy (admin/owner, idempotent)
//   GET    .../policies                                  — list (paginated, any member)
//   GET    .../policies/:policyId                        — get policy (any member)
//   POST   .../policies/:policyId/versions               — create draft version (admin/owner, idempotent)
//   GET    .../policies/:policyId/versions               — list versions (any member)
//   GET    .../policies/:policyId/versions/:version      — get version with rules (any member)
//   PATCH  .../policies/:policyId/versions/:version      — update DRAFT rules (admin/owner, idempotent)
//   POST   .../policies/:policyId/versions/:version/lifecycle — transition (admin/owner, idempotent)
//   POST   .../policies/:policyId/evaluate               — evaluate explicit version against a
//                                                           caller-supplied context (any member,
//                                                           read-only, no execution)
//
// Side-effecting mutations use the existing Idempotency-Key mechanism.
// List endpoints use cursor pagination. Evaluation responses are
// structured and explainable (per-rule results with actual/expected
// values), clearly distinguishing hard failures from preference
// failures. No internal SQL/schema details are exposed.

import { Hono } from "hono";
import type { Runtime } from "@cp/platform";
import type { AuthService } from "@cp/auth";
import type { Principal } from "@cp/auth";
import type { OrganizationsService } from "@cp/organizations";
import type { ProjectsService } from "@cp/projects";
import {
  PoliciesService,
  type Policy,
  type PolicyVersion,
  type PolicyVersionStatus,
  isPolicyVersionStatus,
} from "@cp/policies";
import {
  authMiddleware,
  orgContextMiddleware,
  projectContextMiddleware,
  type AuthVars,
} from "./middleware.ts";
import { IdempotencyStore, withIdempotency } from "./idempotency.ts";

export interface PolicyRouteDeps {
  runtime: Runtime;
  auth: AuthService;
  orgs: OrganizationsService;
  projects: ProjectsService;
  policies: PoliciesService;
  idempotency: IdempotencyStore;
}

export function createPolicyRoutes(
  deps: PolicyRouteDeps,
  app: Hono<{ Variables: AuthVars }>,
): void {
  const { runtime, auth, orgs, projects, policies, idempotency } = deps;

  const base = "/v1/organizations/:orgId/projects/:projectId/policies";

  // ---- Create policy (admin/owner, idempotent) --------------------------

  app.post(
    base,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const name = String(body?.name ?? "").trim();
        if (!name) {
          return validationError(c, "name is required");
        }
        const policy = await policies.createPolicy({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          name,
          description: typeof body?.description === "string" ? body.description : undefined,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ policy: serializePolicy(policy) }, 201);
      });
    },
  );

  // ---- List policies (any member, paginated) --------------------------------

  app.get(
    base,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const limitRaw = Number(c.req.query("limit") ?? 25);
      const page = await policies.listPolicies(
        orgCtx.organizationId,
        pctx.projectId,
        {
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          cursor: c.req.query("cursor") ?? null,
          includeRetired: c.req.query("include_retired") === "true",
        },
      );
      return c.json({
        policies: page.policies.map(serializePolicy),
        next_cursor: page.nextCursor,
      });
    },
  );

  // ---- Get policy (any member) -----------------------------------------------

  app.get(
    `${base}/:policyId`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const policy = await policies.getPolicy(
        orgCtx.organizationId,
        pctx.projectId,
        String(c.req.param("policyId")),
      );
      if (!policy) {
        return notFound(c, "policy.not_found", `policy "${String(c.req.param("policyId"))}" was not found`);
      }
      return c.json({ policy: serializePolicy(policy) });
    },
  );

  // ---- Create draft version (admin/owner, idempotent) --------------------------

  app.post(
    `${base}/:policyId/versions`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        if (body?.rules === undefined) {
          return validationError(c, "rules are required");
        }
        const versionInput =
          body?.version === undefined || body?.version === null || body?.version === ""
            ? undefined
            : String(body.version);
        const version = await policies.createVersion({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          policyId: String(c.req.param("policyId")),
          version: versionInput,
          rules: body.rules,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ version: serializeVersion(version) }, 201);
      });
    },
  );

  // ---- List versions (any member) -----------------------------------------------

  app.get(
    `${base}/:policyId/versions`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const limitRaw = Number(c.req.query("limit") ?? 50);
      const page = await policies.listVersions(
        orgCtx.organizationId,
        pctx.projectId,
        String(c.req.param("policyId")),
        {
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          cursor: c.req.query("cursor") ?? null,
        },
      );
      return c.json({
        versions: page.versions.map(serializeVersion),
        next_cursor: page.nextCursor,
      });
    },
  );

  // ---- Get version with rules (any member) -----------------------------------------

  app.get(
    `${base}/:policyId/versions/:version`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const version = await policies.getVersion(
        orgCtx.organizationId,
        pctx.projectId,
        String(c.req.param("policyId")),
        String(c.req.param("version")),
      );
      if (!version) {
        return notFound(c, "policy.version.not_found", `version "${String(c.req.param("version"))}" was not found`);
      }
      return c.json({ version: serializeVersion(version) });
    },
  );

  // ---- Update DRAFT rules (admin/owner, idempotent) ----------------------------------

  app.patch(
    `${base}/:policyId/versions/:version`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        if (body?.rules === undefined) {
          return validationError(c, "rules are required");
        }
        const version = await policies.updateDraftVersion({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          policyId: String(c.req.param("policyId")),
          version: String(c.req.param("version")),
          rules: body.rules,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ version: serializeVersion(version) });
      });
    },
  );

  // ---- Version lifecycle transition (admin/owner, idempotent) --------------------------

  app.post(
    `${base}/:policyId/versions/:version/lifecycle`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const toStatus = String(body?.status ?? "");
        if (!isPolicyVersionStatus(toStatus)) {
          return validationError(c, `status must be one of draft|active|deprecated|retired (got "${toStatus}")`);
        }
        const version = await policies.transitionVersion({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          policyId: String(c.req.param("policyId")),
          version: String(c.req.param("version")),
          toStatus: toStatus as PolicyVersionStatus,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ version: serializeVersion(version) });
      });
    },
  );

  // ---- Evaluate an explicit version (any member, read-only) ------------------------------

  app.post(
    `${base}/:policyId/evaluate`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const version = String(body?.version ?? "").trim();
        if (!version) {
          return validationError(c, "version is required (evaluation is version-pinned)");
        }
        if (body?.context === undefined || body.context === null || typeof body.context !== "object" || Array.isArray(body.context)) {
          return validationError(c, "context must be an object of normalized facts");
        }
        const result = await policies.evaluatePolicyVersion({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          policyId: String(c.req.param("policyId")),
          version,
          context: body.context as Record<string, unknown>,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({
          evaluation: {
            policy_id: result.policyId,
            policy_version: result.policyVersion,
            passed: result.passed,
            hard_constraints: {
              passed: result.hardConstraints.passed,
              violations: result.hardConstraints.violations.map(serializeRuleResult),
            },
            preferences: {
              satisfied: result.preferences.satisfied.map(serializeRuleResult),
              violated: result.preferences.violated.map(serializeRuleResult),
            },
            rule_results: result.ruleResults.map(serializeRuleResult),
          },
        });
      });
    },
  );

  void (null as unknown as Principal);
}

// ---- Serializers (explicit allowlist) -------------------------------------------

function serializePolicy(p: Policy) {
  return {
    id: p.id,
    project_id: p.projectId,
    name: p.name,
    description: p.description,
    created_by_user_id: p.createdByUserId,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

function serializeVersion(v: PolicyVersion) {
  return {
    id: v.id,
    policy_id: v.policyId,
    version: v.version,
    status: v.status,
    rules: v.rules.map((r) => ({
      id: r.id,
      subject: r.subject,
      operator: r.operator,
      value: r.value ?? null,
      mode: r.mode,
    })),
    created_by_user_id: v.createdByUserId,
    created_at: v.createdAt.toISOString(),
    updated_at: v.updatedAt.toISOString(),
  };
}

function serializeRuleResult(r: {
  ruleId: string;
  subject: string;
  operator: string;
  mode: string;
  result: string;
  expected: unknown;
  actual: unknown;
  reason: string;
}) {
  return {
    rule_id: r.ruleId,
    subject: r.subject,
    operator: r.operator,
    mode: r.mode,
    result: r.result,
    expected: r.expected,
    actual: r.actual,
    reason: r.reason,
  };
}

function validationError(c: { json: (b: unknown, s: number) => Response; get: (k: "requestId") => string }, message: string): Response {
  return c.json(
    {
      error: {
        category: "POLICY_BLOCKED",
        code: "policy.validation",
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
