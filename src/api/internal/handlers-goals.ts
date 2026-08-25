// /api/internal/handlers-goals.ts
// WORK-011 transport routes for /goals + /outcomes (architecture §23, §35,
// §36, lock §8, §9, WORK-011 §20). The API layer is a transport boundary
// only: it imports only the PUBLIC interfaces of @cp/goals and
// @cp/outcomes (and @cp/platform for the runtime, @cp/auth for the
// Principal), never any module's internals. Authorization happens at the
// domain service boundaries (re-verification of active membership +
// admin/owner role) on top of the standard WORK-004 tenant gates.
//
// Routes (all under /v1/organizations/:orgId/projects/:projectId, gated
// by orgContextMiddleware + projectContextMiddleware — the ids passed to
// the services are the RESOLVED authorized values, never raw path
// params):
//   POST/GET  /goals                                     (create admin, list member)
//   GET       /goals/:goalId                             (member)
//   POST/GET  /goals/:goalId/versions                    (create admin, list member)
//   GET       /goals/:goalId/versions/:version           (member)
//   PATCH     /goals/:goalId/versions/:version           (draft objectives only; admin)
//   POST      /goals/:goalId/versions/:version/lifecycle (admin)
//   POST/GET  /outcome-contracts                         (create admin, list member)
//   GET       /outcome-contracts/:contractId             (member)
//   POST/GET  /outcome-contracts/:contractId/versions    (create admin, list member)
//   GET       /outcome-contracts/:contractId/versions/:version (member)
//   PATCH     /outcome-contracts/:contractId/versions/:version (draft content only; admin)
//   POST      /outcome-contracts/:contractId/versions/:version/lifecycle (admin)
//
// Mutations use the existing Idempotency-Key mechanism; reads use cursor
// pagination; structured errors follow the established conventions. No
// secrets are involved anywhere in the goals/outcomes domain (§26 — the
// architecture checker forbids the credentials/connections imports).

import { Hono } from "hono";
import type { Runtime } from "@cp/platform";
import type { AuthService } from "@cp/auth";
import type { Principal } from "@cp/auth";
import type { OrganizationsService } from "@cp/organizations";
import type { ProjectsService } from "@cp/projects";
import {
  GoalsService,
  type Goal,
  type GoalVersion,
  type GoalVersionStatus,
  isGoalVersionStatus,
} from "@cp/goals";
import {
  OutcomesService,
  type OutcomeContract,
  type OutcomeContractVersion,
  type OutcomeContractStatus,
  isOutcomeContractStatus,
} from "@cp/outcomes";
import {
  authMiddleware,
  orgContextMiddleware,
  projectContextMiddleware,
  type AuthVars,
} from "./middleware.ts";
import { IdempotencyStore, withIdempotency } from "./idempotency.ts";

export interface GoalRouteDeps {
  runtime: Runtime;
  auth: AuthService;
  orgs: OrganizationsService;
  projects: ProjectsService;
  goals: GoalsService;
  outcomes: OutcomesService;
  idempotency: IdempotencyStore;
}

export function createGoalRoutes(
  deps: GoalRouteDeps,
  app: Hono<{ Variables: AuthVars }>,
): void {
  const { runtime, auth, orgs, projects, goals, outcomes, idempotency } = deps;

  const base = "/v1/organizations/:orgId/projects/:projectId";
  // The tenant gates, applied as DIRECT route arguments (the WORK-008
  // handlers-policies precedent — Hono's typing with template-literal
  // paths requires the middleware handlers as direct arguments, not a
  // spread array).
  const mw = [
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
  ] as const;

  // ==================== GOALS ====================

  // ---- Create goal (admin, idempotent) ------------------------------------

  app.post(
    `${base}/goals`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const name = String(body?.name ?? "").trim();
        if (!name) {
          return validationError(c, "name is required");
        }
        const goal = await goals.createGoal({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          name,
          description: typeof body?.description === "string" ? body.description : undefined,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ goal: serializeGoal(goal) }, 201);
      });
    },
  );

  // ---- List goals (member, paginated) ----------------------------------------

  app.get(
    `${base}/goals`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const limitRaw = Number(c.req.query("limit") ?? 25);
      const page = await goals.listGoals(
        orgCtx.organizationId,
        pctx.projectId,
        orgCtx.principal,
        {
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          cursor: c.req.query("cursor") ?? null,
          includeRetired: c.req.query("include_retired") === "true",
        },
      );
      return c.json({
        goals: page.goals.map(serializeGoal),
        next_cursor: page.nextCursor,
      });
    },
  );

  // ---- Get goal (member) ---------------------------------------------------------

  app.get(
    `${base}/goals/:goalId`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const goal = await goals.getGoal(
        orgCtx.organizationId, pctx.projectId, String(c.req.param("goalId")), orgCtx.principal,
      );
      if (!goal) {
        return notFound(c, "goal.not_found", `goal "${String(c.req.param("goalId"))}" was not found`);
      }
      return c.json({ goal: serializeGoal(goal) });
    },
  );

  // ---- Create goal version (admin, idempotent) --------------------------------------

  app.post(
    `${base}/goals/:goalId/versions`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        if (!Array.isArray(body?.objectives)) {
          return validationError(c, "objectives (array) are required");
        }
        const outcomeContractId = String(body?.outcome_contract_id ?? "").trim();
        const outcomeContractVersion = String(body?.outcome_contract_version ?? "").trim();
        if (!outcomeContractId || !outcomeContractVersion) {
          return validationError(c, "outcome_contract_id and outcome_contract_version are required (the exact measurement definition this goal version references)");
        }
        const version = await goals.createVersion({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          goalId: String(c.req.param("goalId")),
          objectives: body.objectives,
          outcomeContractId,
          outcomeContractVersion,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ version: serializeGoalVersion(version) }, 201);
      });
    },
  );

  // ---- List goal versions (member) ------------------------------------------------------

  app.get(
    `${base}/goals/:goalId/versions`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const limitRaw = Number(c.req.query("limit") ?? 50);
      const page = await goals.listVersions(
        orgCtx.organizationId, pctx.projectId, String(c.req.param("goalId")), orgCtx.principal,
        {
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          cursor: c.req.query("cursor") ?? null,
        },
      );
      return c.json({
        versions: page.versions.map(serializeGoalVersion),
        next_cursor: page.nextCursor,
      });
    },
  );

  // ---- Get goal version (member) ------------------------------------------------------------

  app.get(
    `${base}/goals/:goalId/versions/:version`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const version = await goals.getVersion(
        orgCtx.organizationId, pctx.projectId, String(c.req.param("goalId")),
        String(c.req.param("version")), orgCtx.principal,
      );
      if (!version) {
        return notFound(c, "goal.version.not_found", `version "${String(c.req.param("version"))}" was not found`);
      }
      return c.json({ version: serializeGoalVersion(version) });
    },
  );

  // ---- Update DRAFT objectives (admin, idempotent) ---------------------------------------------

  app.patch(
    `${base}/goals/:goalId/versions/:version`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        if (!Array.isArray(body?.objectives)) {
          return validationError(c, "objectives (array) are required");
        }
        const version = await goals.updateDraftVersion({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          goalId: String(c.req.param("goalId")),
          version: String(c.req.param("version")),
          objectives: body.objectives,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ version: serializeGoalVersion(version) });
      });
    },
  );

  // ---- Goal version lifecycle (admin, idempotent) --------------------------------------------------

  app.post(
    `${base}/goals/:goalId/versions/:version/lifecycle`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const toStatus = String(body?.status ?? "");
        if (!isGoalVersionStatus(toStatus)) {
          return validationError(c, `status must be one of draft|active|deprecated|retired (got "${toStatus}")`);
        }
        const version = await goals.transitionVersion({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          goalId: String(c.req.param("goalId")),
          version: String(c.req.param("version")),
          toStatus: toStatus as GoalVersionStatus,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ version: serializeGoalVersion(version) });
      });
    },
  );

  // ==================== OUTCOME CONTRACTS ====================

  // ---- Create outcome contract (admin, idempotent; first version is DRAFT) ----

  app.post(
    `${base}/outcome-contracts`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const name = String(body?.name ?? "").trim();
        if (!name) {
          return validationError(c, "name is required");
        }
        if (body?.content === undefined || body?.content === null) {
          return validationError(c, "content (the contract definition) is required");
        }
        const version = await outcomes.createContract({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          name,
          description: typeof body?.description === "string" ? body.description : undefined,
          content: body.content,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ contract_version: serializeContractVersion(version) }, 201);
      });
    },
  );

  // ---- List outcome contracts (member, paginated) ------------------------------------------------

  app.get(
    `${base}/outcome-contracts`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const limitRaw = Number(c.req.query("limit") ?? 25);
      const page = await outcomes.listContracts(
        orgCtx.organizationId, pctx.projectId, orgCtx.principal,
        {
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          cursor: c.req.query("cursor") ?? null,
          includeRetired: c.req.query("include_retired") === "true",
        },
      );
      return c.json({
        contracts: page.contracts.map(serializeContract),
        next_cursor: page.nextCursor,
      });
    },
  );

  // ---- Get outcome contract (member) ---------------------------------------------------------------

  app.get(
    `${base}/outcome-contracts/:contractId`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const contract = await outcomes.getContract(
        orgCtx.organizationId, pctx.projectId, String(c.req.param("contractId")), orgCtx.principal,
      );
      if (!contract) {
        return notFound(c, "outcome.contract.not_found", `outcome contract "${String(c.req.param("contractId"))}" was not found`);
      }
      return c.json({ contract: serializeContract(contract) });
    },
  );

  // ---- Create contract version (admin, idempotent) ------------------------------------------------------

  app.post(
    `${base}/outcome-contracts/:contractId/versions`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        if (body?.content === undefined || body?.content === null) {
          return validationError(c, "content (the contract definition) is required");
        }
        const version = await outcomes.createVersion({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          contractId: String(c.req.param("contractId")),
          content: body.content,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ contract_version: serializeContractVersion(version) }, 201);
      });
    },
  );

  // ---- List contract versions (member) --------------------------------------------------------------------

  app.get(
    `${base}/outcome-contracts/:contractId/versions`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const limitRaw = Number(c.req.query("limit") ?? 50);
      const page = await outcomes.listVersions(
        orgCtx.organizationId, pctx.projectId, String(c.req.param("contractId")), orgCtx.principal,
        {
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          cursor: c.req.query("cursor") ?? null,
        },
      );
      return c.json({
        versions: page.versions.map(serializeContractVersion),
        next_cursor: page.nextCursor,
      });
    },
  );

  // ---- Get contract version (member) --------------------------------------------------------------------------

  app.get(
    `${base}/outcome-contracts/:contractId/versions/:version`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      const version = await outcomes.getVersion(
        orgCtx.organizationId, pctx.projectId, String(c.req.param("contractId")),
        String(c.req.param("version")), orgCtx.principal,
      );
      if (!version) {
        return notFound(c, "outcome.contract.version.not_found", `version "${String(c.req.param("version"))}" was not found`);
      }
      return c.json({ contract_version: serializeContractVersion(version) });
    },
  );

  // ---- Update DRAFT content (admin, idempotent) ------------------------------------------------------------------

  app.patch(
    `${base}/outcome-contracts/:contractId/versions/:version`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        if (body?.content === undefined || body?.content === null) {
          return validationError(c, "content (the contract definition) is required");
        }
        const version = await outcomes.updateDraftContent({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          contractId: String(c.req.param("contractId")),
          version: String(c.req.param("version")),
          content: body.content,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ contract_version: serializeContractVersion(version) });
      });
    },
  );

  // ---- Contract version lifecycle (admin, idempotent) ----------------------------------------------------------------

  app.post(
    `${base}/outcome-contracts/:contractId/versions/:version/lifecycle`,
    mw[0],
    mw[1],
    mw[2],
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const toStatus = String(body?.status ?? "");
        if (!isOutcomeContractStatus(toStatus)) {
          return validationError(c, `status must be one of draft|active|deprecated|retired (got "${toStatus}")`);
        }
        const version = await outcomes.transitionVersion({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          contractId: String(c.req.param("contractId")),
          version: String(c.req.param("version")),
          toStatus: toStatus as OutcomeContractStatus,
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ contract_version: serializeContractVersion(version) });
      });
    },
  );

  void (null as unknown as Principal);
}

// ---- Serializers (explicit allowlist — explainable, no internals) -------------------

function serializeGoal(g: Goal) {
  return {
    id: g.id,
    project_id: g.projectId,
    name: g.name,
    description: g.description,
    created_by_user_id: g.createdByUserId,
    created_at: g.createdAt.toISOString(),
    updated_at: g.updatedAt.toISOString(),
  };
}

function serializeGoalVersion(v: GoalVersion) {
  return {
    id: v.id,
    goal_id: v.goalId,
    version: v.version,
    status: v.status,
    objectives: v.objectives.map((o) => ({
      id: o.id,
      direction: o.direction,
      metric: o.metric,
      kind: o.kind,
      ...(o.target !== undefined ? { target: o.target } : {}),
      ...(o.unit !== undefined ? { unit: o.unit } : {}),
      ...(o.notes !== undefined ? { notes: o.notes } : {}),
    })),
    outcome_contract: {
      contract_id: v.outcomeContractId,
      contract_version: v.outcomeContractVersion,
    },
    created_by_user_id: v.createdByUserId,
    created_at: v.createdAt.toISOString(),
    updated_at: v.updatedAt.toISOString(),
  };
}

function serializeContract(c: OutcomeContract) {
  return {
    id: c.id,
    project_id: c.projectId,
    name: c.name,
    description: c.description,
    created_by_user_id: c.createdByUserId,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

function serializeContractVersion(v: OutcomeContractVersion) {
  return {
    id: v.id,
    contract_id: v.contractId,
    version: v.version,
    status: v.status,
    content: {
      metric: v.content.metric,
      unit: v.content.unit,
      direction: v.content.direction,
      aggregation: v.content.aggregation,
      threshold: v.content.threshold,
      window_seconds: v.content.windowSeconds,
      measurement_source: v.content.measurementSource,
      required: v.content.required,
      description: v.content.description,
    },
    created_by_user_id: v.createdByUserId,
    created_at: v.createdAt.toISOString(),
    updated_at: v.updatedAt.toISOString(),
  };
}

function validationError(c: { json: (b: unknown, s: number) => Response; get: (k: "requestId") => string }, message: string): Response {
  return c.json(
    {
      error: {
        category: "POLICY_BLOCKED",
        code: "goal.validation",
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
