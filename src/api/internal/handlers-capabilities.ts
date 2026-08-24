// /api/internal/handlers-capabilities.ts
// WORK-005 transport routes for /capabilities (architecture §2.2, §6, §23,
// §35, §36, lock §8, §9, WORK-005 §14). The API layer is a transport
// boundary only: it imports only the PUBLIC interfaces of @cp/capabilities
// (and @cp/platform for the runtime, @cp/auth for the Principal), never any
// module's internals. Authorization happens at the domain service boundary
// (CapabilitiesService checks the CP-level capability-admin grant
// server-side); the API handler never re-implements authority logic.
//
// Routes (all under /v1/capabilities, authenticated; the :capabilityId path
// param is the canonical id e.g. 'payment.accept'):
//   POST   /v1/capabilities                                    — create (idempotent, admin)
//   GET    /v1/capabilities                                     — list (paginated, any principal)
//   GET    /v1/capabilities/:capabilityId                       — get (any principal)
//   POST   /v1/capabilities/:capabilityId/lifecycle             — transition lifecycle (admin, idempotent)
//   POST   /v1/capabilities/:capabilityId/versions              — create version (admin, idempotent)
//   GET    /v1/capabilities/:capabilityId/versions              — list versions (any principal)
//   GET    /v1/capabilities/:capabilityId/versions/:version     — get version (any principal)
//   POST   /v1/capabilities/:capabilityId/versions/:version/lifecycle — transition version lifecycle (admin, idempotent)
//   POST   /v1/capabilities/:capabilityId/dependencies          — add dependency (admin, idempotent)
//   GET    /v1/capabilities/:capabilityId/graph                 — inspect dependency graph (any principal)
//   POST   /v1/capabilities/admins                               — grant capability-admin (bootstrap/admin, idempotent)
//
// Authority (WORK-005 §12, §22): the capability catalog is GLOBAL. Mutations
// require a capability-admin grant (capability.manage). The service enforces
// this server-side and throws POLICY_BLOCKED (capability.admin.required) →
// 403 for any non-admin. An arbitrary org owner/admin without the grant
// cannot mutate the global catalog (proven in tests/security/capability-authority).
// Reads are authenticated-only (any active principal may inspect the catalog).

import { Hono } from "hono";
import { AppError, type Runtime } from "@cp/platform";
import type { AuthService } from "@cp/auth";
import type { Principal } from "@cp/auth";
import type { OrganizationsService } from "@cp/organizations";
import {
  CapabilitiesService,
  type Capability,
  type CapabilityVersion,
  type CapabilityContract,
  type SideEffect,
  type CapabilityStatus,
} from "@cp/capabilities";
import {
  isSideEffect,
  isCapabilityStatus,
} from "@cp/capabilities";
import {
  authMiddleware,
  requirePrincipal,
  type AuthVars,
} from "./middleware.ts";
import { IdempotencyStore, withIdempotency } from "./idempotency.ts";

export interface CapabilityRouteDeps {
  runtime: Runtime;
  auth: AuthService;
  orgs: OrganizationsService;
  capabilities: CapabilitiesService;
  idempotency: IdempotencyStore;
}

/**
 * Register the /v1/capabilities[/*] routes on the given Hono app. The auth
 * middleware runs on every sub-route so a presented credential is verified
 * and a Principal is populated; missing credentials are allowed (the
 * requirePrincipal gate on each route enforces presence).
 */
export function createCapabilityRoutes(
  deps: CapabilityRouteDeps,
  app: Hono<{ Variables: AuthVars }>,
): void {
  const { runtime, auth, orgs, capabilities, idempotency } = deps;
  // Verify credential IF present on every /v1/capabilities route. The
  // Principal is built via orgs.buildPrincipalForUser (the standard WORK-003
  // flow) — the capability-admin authority check uses principal.userId.
  app.use("/v1/capabilities/*", authMiddleware(runtime, auth, orgs));
  app.use("/v1/capabilities", authMiddleware(runtime, auth, orgs));

  // ---- Create capability (side-effecting → idempotency-supported) ------

  app.post(
    "/v1/capabilities",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (body) => {
        const capabilityId = String(body?.capability_id ?? "").trim();
        const name = String(body?.name ?? "").trim();
        const description =
          typeof body?.description === "string" ? body.description.trim() : "";
        if (!capabilityId || !name) {
          return validationError(c, "capability_id and name are required");
        }
        const cap = await capabilities.createCapability({
          capabilityId,
          name,
          description,
          actingPrincipal: principal,
        });
        return c.json({ capability: serializeCapability(cap) }, 201);
      });
    },
  );

  // ---- List capabilities (paginated, any principal) -------------------

  app.get(
    "/v1/capabilities",
    requirePrincipal(),
    async (c) => {
      const limitParam = Number(c.req.query("limit"));
      const cursor = c.req.query("cursor") ?? undefined;
      const status = c.req.query("status") ?? undefined;
      const page = await capabilities.listCapabilities({
        limit: Number.isFinite(limitParam) ? limitParam : undefined,
        cursor,
        status:
          typeof status === "string" && isCapabilityStatus(status)
            ? (status as CapabilityStatus)
            : undefined,
      });
      return c.json({
        capabilities: page.capabilities.map(serializeCapability),
        page: page.page,
      });
    },
  );

  // ---- Get capability (any principal) --------------------------------

  app.get(
    "/v1/capabilities/:capabilityId",
    requirePrincipal(),
    async (c) => {
      const capabilityId = decodeId(c.req.param("capabilityId"));
      const cap = await capabilities.getCapability(capabilityId);
      if (!cap) {
        throw notFound(c, "capability.not_found", "capability not found");
      }
      return c.json({ capability: serializeCapability(cap) });
    },
  );

  // ---- Transition capability lifecycle (admin, idempotent) -----------

  app.post(
    "/v1/capabilities/:capabilityId/lifecycle",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      const capabilityId = decodeId(c.req.param("capabilityId"));
      return withIdempotency(c, idempotency, principal, async (body) => {
        const toStatus = String(body?.status ?? "").trim() as CapabilityStatus;
        if (!isCapabilityStatus(toStatus)) {
          return validationError(c, "status must be one of draft|active|deprecated|retired");
        }
        const cap = await capabilities.transitionCapability({
          capabilityId,
          toStatus,
          actingPrincipal: principal,
        });
        return c.json({ capability: serializeCapability(cap) });
      });
    },
  );

  // ---- Create version (admin, idempotent) ----------------------------

  app.post(
    "/v1/capabilities/:capabilityId/versions",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      const capabilityId = decodeId(c.req.param("capabilityId"));
      return withIdempotency(c, idempotency, principal, async (body) => {
        const contract = parseContractBody(body);
        if (!contract) {
          return validationError(c, "contract (input_schema, output_schema, side_effect) is required");
        }
        const version =
          typeof body?.version === "string" && body.version.length > 0
            ? String(body.version)
            : undefined;
        const v = await capabilities.createVersion({
          capabilityId,
          version,
          contract,
          actingPrincipal: principal,
        });
        return c.json({ version: serializeVersion(v) }, 201);
      });
    },
  );

  // ---- List versions (any principal) ---------------------------------

  app.get(
    "/v1/capabilities/:capabilityId/versions",
    requirePrincipal(),
    async (c) => {
      const capabilityId = decodeId(c.req.param("capabilityId"));
      const includeDeprecated = c.req.query("include_deprecated") === "true";
      const includeRetired = c.req.query("include_retired") === "true";
      const versions = await capabilities.listVersions(capabilityId, {
        includeDeprecated,
        includeRetired,
      });
      return c.json({ versions: versions.map(serializeVersion) });
    },
  );

  // ---- Get version (any principal) -----------------------------------

  app.get(
    "/v1/capabilities/:capabilityId/versions/:version",
    requirePrincipal(),
    async (c) => {
      const capabilityId = decodeId(c.req.param("capabilityId"));
      const version = c.req.param("version");
      const v = await capabilities.getVersion(capabilityId, version);
      if (!v) {
        throw notFound(c, "capability.version.not_found", "version not found");
      }
      return c.json({ version: serializeVersion(v) });
    },
  );

  // ---- Transition version lifecycle (admin, idempotent) --------------

  app.post(
    "/v1/capabilities/:capabilityId/versions/:version/lifecycle",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      const capabilityId = decodeId(c.req.param("capabilityId"));
      const version = c.req.param("version");
      return withIdempotency(c, idempotency, principal, async (body) => {
        const toStatus = String(body?.status ?? "").trim() as CapabilityStatus;
        if (!isCapabilityStatus(toStatus)) {
          return validationError(c, "status must be one of draft|active|deprecated|retired");
        }
        const v = await capabilities.transitionVersion({
          capabilityId,
          version,
          toStatus,
          actingPrincipal: principal,
        });
        return c.json({ version: serializeVersion(v) });
      });
    },
  );

  // ---- Add dependency (admin, idempotent) ----------------------------

  app.post(
    "/v1/capabilities/:capabilityId/dependencies",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      const capabilityId = decodeId(c.req.param("capabilityId"));
      return withIdempotency(c, idempotency, principal, async (body) => {
        const requiredCapabilityId = String(body?.required_capability_id ?? "").trim();
        const requiredVersion =
          typeof body?.required_version === "string" && body.required_version.length > 0
            ? String(body.required_version)
            : null;
        if (!requiredCapabilityId) {
          return validationError(c, "required_capability_id is required");
        }
        const dep = await capabilities.addDependency({
          capabilityId,
          version: String(body?.version ?? ""),
          requiredCapabilityId,
          requiredVersion,
          actingPrincipal: principal,
        });
        return c.json({ dependency: serializeDependency(dep) }, 201);
      });
    },
  );

  // ---- Inspect dependency graph (any principal) ----------------------

  app.get(
    "/v1/capabilities/:capabilityId/graph",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      const capabilityId = decodeId(c.req.param("capabilityId"));
      const version = c.req.query("version") ?? "";
      if (!version) {
        return validationError(c, "version query parameter is required");
      }
      const graph = await capabilities.getDependencyGraph(capabilityId, version);
      return c.json({ graph: serializeGraph(graph) });
    },
  );

  // ---- Grant capability-admin (admin-only, idempotent) ---------------
  // Architect review of PR #4: this is the NORMAL capability-admin API.
  // It requires the acting principal to ALREADY be a capability admin —
  // the service has NO empty-table bootstrap path. The FIRST admin is
  // created exclusively by the deployment/operator authority
  // (CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID → serve() startup →
  // bootstrapCapabilityAdmin), never via this endpoint. A fresh
  // installation with an ordinary authenticated user gets 403 here.

  app.post(
    "/v1/capabilities/admins",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (body) => {
        const userId = String(body?.user_id ?? "").trim();
        if (!userId) {
          return validationError(c, "user_id is required");
        }
        await capabilities.grantCapabilityAdmin({
          userId,
          actingPrincipal: principal,
        });
        return c.json({ granted: { user_id: userId, permission: "capability.manage" } }, 201);
      });
    },
  );

  // Silence the unused-import warning for Principal (imported for type
  // clarity; the handler receives the principal via c.get('principal')).
  void (null as unknown as Principal);
}

// ---- Helpers ----------------------------------------------------------

// Canonical capability ids contain a dot (e.g. 'payment.accept'); they are
// URL-safe in a path segment, but Hono may URL-decode them. Decode here so
// '%2E' or encoded forms resolve to the literal canonical id.
function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseContractBody(
  body: Record<string, unknown> | null,
): CapabilityContract | null {
  if (!body || typeof body !== "object") return null;
  const contract = body.contract;
  if (contract && typeof contract === "object") {
    return parseContract(contract as Record<string, unknown>);
  }
  // Allow a flat body where the contract fields are at the top level.
  if (body.input_schema || body.output_schema || body.side_effect) {
    return parseContract(body);
  }
  return null;
}

function parseContract(c: Record<string, unknown>): CapabilityContract | null {
  if (!c || typeof c !== "object") return null;
  const sideEffect = String(c.side_effect ?? "") as SideEffect;
  if (!isSideEffect(sideEffect)) return null;
  return {
    inputSchema: (c.input_schema ?? { type: "object" }) as CapabilityContract["inputSchema"],
    outputSchema: (c.output_schema ?? { type: "object" }) as CapabilityContract["outputSchema"],
    errorModel: Array.isArray(c.error_model) ? (c.error_model as CapabilityContract["errorModel"]) : [],
    sideEffect,
    idempotencySemantics:
      (c.idempotency_semantics as CapabilityContract["idempotencySemantics"]) ?? {},
    requiredContext:
      Array.isArray(c.required_context) ? (c.required_context as string[]) : [],
    executionModes:
      Array.isArray(c.execution_modes) ? (c.execution_modes as string[]) : [],
    policyMetadata:
      (c.policy_metadata as Record<string, unknown>) ?? {},
    constraints:
      Array.isArray(c.constraints) ? (c.constraints as Record<string, unknown>[]) : [],
    latencyExpectations:
      (c.latency_expectations as Record<string, unknown>) ?? {},
  };
}

function validationError(c: { json: (b: unknown, s: number) => Response; get: (k: "requestId") => string }, message: string): Response {
  return c.json(
    {
      error: {
        category: "POLICY_BLOCKED",
        code: "capability.validation",
        message,
        retryable: false,
        request_id: c.get("requestId"),
      },
    },
    400,
  );
}

function notFound(c: { get: (k: "requestId") => string }, code: string, message: string): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code,
    message,
    retryable: false,
    details: { request_id: c.get("requestId") },
  });
}

// ---- Serialization ---------------------------------------------------

function serializeCapability(c: Capability): Record<string, unknown> {
  return {
    id: c.id,
    capability_id: c.capabilityId,
    name: c.name,
    description: c.description,
    status: c.status,
    created_by_user_id: c.createdByUserId,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

function serializeVersion(v: CapabilityVersion): Record<string, unknown> {
  return {
    id: v.id,
    capability_id: v.canonicalId,
    version: v.version,
    status: v.status,
    contract: {
      input_schema: v.contract.inputSchema,
      output_schema: v.contract.outputSchema,
      error_model: v.contract.errorModel,
      side_effect: v.contract.sideEffect,
      idempotency_semantics: v.contract.idempotencySemantics,
      required_context: v.contract.requiredContext,
      execution_modes: v.contract.executionModes,
      policy_metadata: v.contract.policyMetadata,
      constraints: v.contract.constraints,
      latency_expectations: v.contract.latencyExpectations,
    },
    created_by_user_id: v.createdByUserId,
    created_at: v.createdAt.toISOString(),
  };
}

function serializeDependency(d: {
  id: string;
  canonicalId: string;
  version: string;
  requiredCanonicalId: string;
  requiredVersion: string | null;
  resolvedRequiredVersion: string;
  createdByUserId: string;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: d.id,
    capability_id: d.canonicalId,
    version: d.version,
    required_capability_id: d.requiredCanonicalId,
    required_version: d.requiredVersion,
    resolved_required_version: d.resolvedRequiredVersion,
    created_by_user_id: d.createdByUserId,
    created_at: d.createdAt.toISOString(),
  };
}

function serializeGraph(g: {
  canonicalId: string;
  version: string;
  directDependencies: { id: string; canonicalId: string; version: string; requiredCanonicalId: string; requiredVersion: string | null; resolvedRequiredVersion: string }[];
  edges: { from: string; to: string; fromCanonical: string; fromVersion: string; toCanonical: string; toVersion: string }[];
  order: string[];
  reachable: string[];
}): Record<string, unknown> {
  return {
    capability_id: g.canonicalId,
    version: g.version,
    direct_dependencies: g.directDependencies.map((d) => ({
      capability_id: d.canonicalId,
      version: d.version,
      required_capability_id: d.requiredCanonicalId,
      required_version: d.requiredVersion,
      resolved_required_version: d.resolvedRequiredVersion,
    })),
    edges: g.edges,
    order: g.order,
    reachable: g.reachable,
  };
}
