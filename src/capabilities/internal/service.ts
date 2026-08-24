// /capabilities/internal/service.ts
// CapabilitiesService — the /capabilities module's concrete service
// (architecture §2.2, §6, §36, §37, lock §1, §7, §8, WORK-005 CAP-001..004).
// Owns:
//   - capability identity (cp_capabilities) — global, stable canonical id
//   - immutable versioned contracts (cp_capability_versions) — input/output
//     JSON Schemas, error model, side-effect class, idempotency semantics,
//     required context, execution modes, policy metadata
//   - the directed, version-aware capability dependency graph
//     (cp_capability_dependencies) with cycle detection, self-dep rejection,
//     duplicate-edge rejection, and retired-status validation
//   - the CP-level platform-admin grant that gates global catalog mutations
//     (cp_capability_admins) — distinct from org-membership roles
//
// Authority (WORK-005 §12, §15, §22, architect review of PR #4): capabilities
// are GLOBAL CP-level primitives; a semantic capability such as
// `payment.accept` is not owned by a single organization. There is NO
// organization_id/project_id on the global capability identity. Mutations
// (create/publish/version/deprecate/retire, add-dependency, grant-admin)
// require the acting principal to be a capability admin (a row in
// cp_capability_admins). Reads (get/list/graph) are authenticated-only —
// any active principal may inspect the global catalog. An arbitrary org
// owner/admin without a capability-admin grant CANNOT mutate the catalog
// (proven in tests/security/capability-authority).
//
// Bootstrap authority (architect review of PR #4): the FIRST capability
// admin is created EXCLUSIVELY by the deployment/operator authority — the
// CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID configuration processed by serve()
// at startup via bootstrapCapabilityAdmin(). The normal tenant API
// (POST /v1/capabilities/admins → grantCapabilityAdmin) NEVER self-
// bootstraps on an empty table; it only permits an EXISTING capability
// admin to grant another. A tenant user cannot bootstrap themselves into
// global catalog administration merely because the installation is new.
//
// Bootstrap atomicity (architect review #2 of PR #4): the first-admin
// claim is a SINGLETON database row (constant-TRUE primary key) claimed
// and granted in ONE atomic SQL statement, so concurrent bootstrap calls
// (e.g. two serve() instances racing with different users) can never
// produce two bootstrap admins — exactly one claim row can ever exist.
//
// Immutability (WORK-005 §18): once a capability version reaches status
// 'active' (published), its contract fields are IMMUTABLE. The service
// exposes NO path that updates input_schema/output_schema/error_model/
// side_effect/idempotency_semantics/required_context/execution_modes/
// policy_metadata on a published version — transitionVersion flips ONLY the
// status column. An incompatible change requires a NEW version. At most one
// version per capability may be 'active' at a time (partial UNIQUE index);
// publishing a new version auto-deprecates the previous active one within the
// same transaction.
//
// PostgreSQL is authoritative. The service depends ONLY on the
// provider-neutral platform `Database` interface — `pg` is isolated to
// /platform internals (architecture §2.3, lock §7, WORK-005 §16).

import {
  AppError,
  type Database,
  type DbQueryResultRow,
  ulid,
  Logger,
  type LogSink,
  type LogRecord,
} from "@cp/platform";
import type { Principal } from "@cp/auth";
import {
  validateCapabilityId,
  validateVersion,
} from "./identifiers.ts";
import {
  validateJsonSchemaShape,
  isSideEffect,
  isCapabilityStatus,
  LIFECYCLE_TRANSITIONS,
  type SideEffect,
  type CapabilityStatus,
  type CapabilityContract,
  type CapabilityErrorEntry,
  type IdempotencySemantics,
  type JsonSchema,
} from "./contract.ts";
import {
  detectCycle,
  reachableFrom,
  topologicalOrder,
  nodeKey,
  type GraphEdge,
} from "./graph.ts";

// ---- Record types ------------------------------------------------------

export interface Capability {
  id: string; // internal surrogate id (cap_<ulid>)
  capabilityId: string; // canonical 'payment.accept'
  name: string;
  description: string;
  status: CapabilityStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CapabilityVersion {
  id: string; // internal surrogate (capv_<ulid>)
  capabilityId: string; // internal surrogate of the parent capability
  canonicalId: string; // canonical 'payment.accept' (denormalized for display)
  version: string; // '1', '2', ...
  status: CapabilityStatus;
  contract: CapabilityContract;
  createdByUserId: string;
  createdAt: Date;
}

export interface CapabilityDependency {
  id: string;
  capabilityId: string; // internal surrogate of A
  canonicalId: string; // canonical of A
  version: string; // version of A
  requiredCapabilityId: string; // internal surrogate of B
  requiredCanonicalId: string; // canonical of B
  requiredVersion: string | null; // pinned version of B, or null (→ active)
  resolvedRequiredVersion: string; // the version of B this edge resolves to
  createdByUserId: string;
  createdAt: Date;
}

export interface DependencyGraph {
  capabilityId: string;
  canonicalId: string;
  version: string;
  directDependencies: CapabilityDependency[];
  /** Resolved edges (from→to node keys) for the reachable subgraph. */
  edges: { from: string; to: string; fromCanonical: string; fromVersion: string; toCanonical: string; toVersion: string }[];
  /** Deterministic topological traversal of the reachable subgraph. */
  order: string[];
  /** Transitive set of nodes reachable from the queried (capability, version). */
  reachable: string[];
}

// ---- Inputs ------------------------------------------------------------

export interface CreateCapabilityInput {
  capabilityId: string; // canonical 'payment.accept'
  name: string;
  description?: string;
  actingPrincipal: Principal;
}

export interface ListCapabilitiesOptions {
  limit?: number;
  cursor?: string; // capability.id (ULID-based) for cursor pagination
  status?: CapabilityStatus;
}

export interface CapabilityPage {
  capabilities: Capability[];
  page: { next_cursor: string | null; has_more: boolean; limit: number };
}

export interface TransitionCapabilityInput {
  capabilityId: string; // canonical id
  toStatus: CapabilityStatus;
  actingPrincipal: Principal;
}

export interface CreateVersionInput {
  capabilityId: string; // canonical id of the parent capability
  /** Optional explicit version string ('1','2',...). If omitted, auto = max+1. */
  version?: string;
  contract: CapabilityContract;
  actingPrincipal: Principal;
}

export interface TransitionVersionInput {
  capabilityId: string; // canonical id
  version: string;
  toStatus: CapabilityStatus;
  actingPrincipal: Principal;
}

export interface AddDependencyInput {
  capabilityId: string; // canonical id of A (the depending capability)
  version: string; // version of A
  requiredCapabilityId: string; // canonical id of B (the required capability)
  /** Optional pinned version of B; null/omitted → B's active version. */
  requiredVersion?: string | null;
  actingPrincipal: Principal;
}

export interface ListVersionsOptions {
  includeDeprecated?: boolean;
  includeRetired?: boolean;
}

// ---- Row mappers ------------------------------------------------------

interface CapabilityRow extends DbQueryResultRow {
  id: string;
  capability_id: string;
  name: string;
  description: string;
  status: string;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface VersionRow extends DbQueryResultRow {
  id: string;
  capability_id: string;
  capability_canonical_id: string;
  version: string;
  status: string;
  input_schema: unknown;
  output_schema: unknown;
  error_model: unknown;
  side_effect: string;
  idempotency_semantics: unknown;
  required_context: unknown;
  execution_modes: unknown;
  policy_metadata: unknown;
  constraints: unknown;
  latency_expectations: unknown;
  created_by_user_id: string;
  created_at: Date | string;
}

interface DependencyRow extends DbQueryResultRow {
  id: string;
  capability_id: string;
  capability_canonical_id: string;
  version: string;
  required_capability_id: string;
  required_canonical_id: string;
  required_version: string | null;
  resolved_required_version: string;
  created_by_user_id: string;
  created_at: Date | string;
}

function mapCapability(r: CapabilityRow): Capability {
  return {
    id: r.id as string,
    capabilityId: r.capability_id as string,
    name: r.name as string,
    description: (r.description as string) ?? "",
    status: asStatus(r.status),
    createdByUserId: r.created_by_user_id as string,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function mapVersion(r: VersionRow): CapabilityVersion {
  return {
    id: r.id as string,
    capabilityId: r.capability_id as string,
    canonicalId: (r.capability_canonical_id as string) ?? "",
    version: r.version as string,
    status: asStatus(r.status),
    contract: {
      inputSchema: r.input_schema as JsonSchema,
      outputSchema: r.output_schema as JsonSchema,
      errorModel: (r.error_model as CapabilityErrorEntry[]) ?? [],
      sideEffect: r.side_effect as SideEffect,
      idempotencySemantics:
        (r.idempotency_semantics as IdempotencySemantics) ?? {},
      requiredContext: (r.required_context as string[]) ?? [],
      executionModes: (r.execution_modes as string[]) ?? [],
      policyMetadata: (r.policy_metadata as Record<string, unknown>) ?? {},
      constraints: (r.constraints as Record<string, unknown>[]) ?? [],
      latencyExpectations:
        (r.latency_expectations as Record<string, unknown>) ?? {},
    },
    createdByUserId: r.created_by_user_id as string,
    createdAt: new Date(r.created_at as string),
  };
}

function mapDependency(r: DependencyRow): CapabilityDependency {
  return {
    id: r.id as string,
    capabilityId: r.capability_id as string,
    canonicalId: (r.capability_canonical_id as string) ?? "",
    version: r.version as string,
    requiredCapabilityId: r.required_capability_id as string,
    requiredCanonicalId: (r.required_canonical_id as string) ?? "",
    requiredVersion: (r.required_version as string | null) ?? null,
    resolvedRequiredVersion: r.resolved_required_version as string,
    createdByUserId: r.created_by_user_id as string,
    createdAt: new Date(r.created_at as string),
  };
}

function asStatus(v: unknown): CapabilityStatus {
  const s = String(v ?? "draft");
  return s === "active" || s === "deprecated" || s === "retired"
    ? (s as CapabilityStatus)
    : "draft";
}

// ---- Errors -----------------------------------------------------------

function policyBlocked(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code,
    message,
    retryable: false,
    details,
  });
}

function platformFailure(code: string, message: string, cause?: unknown): AppError {
  return new AppError({
    category: "PLATFORM_FAILURE",
    code,
    message,
    retryable: false,
    cause,
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof AppError) {
    if (err.details?.driverCode === "23505") return true;
    const causeCode = (err.causeValue as { code?: string } | undefined)?.code;
    if (causeCode === "23505") return true;
    return false;
  }
  const rawCode = (err as { code?: string } | undefined)?.code;
  return rawCode === "23505";
}

// ---- Service ----------------------------------------------------------

export interface CapabilitiesServiceOptions {
  db: Database;
  logger?: Logger;
}

const NOOP_SINK: LogSink = { emit: (_r: LogRecord) => {} };
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

function clampLimit(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(Math.max(Math.floor(n), 1), MAX_PAGE_LIMIT);
}

export class CapabilitiesService {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(opts: CapabilitiesServiceOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
  }

  // ---- Platform-admin authority --------------------------------------

  /**
   * Is the given user a capability admin (may mutate the global catalog)?
   * A CP-level grant, NOT an org-membership role (WORK-005 §12). The check
   * is a real DB lookup against cp_capability_admins.
   */
  async isCapabilityAdmin(userId: string): Promise<boolean> {
    const rows = await this.db.query({
      text: `SELECT 1 FROM cp_capability_admins
             WHERE user_id = $1 AND permission = 'capability.manage'
             LIMIT 1`,
      params: [userId],
    });
    return rows.length > 0;
  }

  /**
   * Grant capability-admin authority to a user. This is the NORMAL
   * capability-admin API (WORK-005 §22): it requires the acting principal
   * to ALREADY be a capability admin. There is NO empty-table bypass —
   * the first admin is bootstrapped via the deployment/operator authority
   * path (`bootstrapCapabilityAdmin`), never via this method.
   *
   * The grant is idempotent (INSERT ... ON CONFLICT DO NOTHING).
   *
   * Authority correction (architect review of PR #4): the previous
   * implementation allowed any authenticated principal to grant the first
   * admin when the table was empty. That defeated the purpose of a
   * CP-level platform-admin authority — a tenant user could bootstrap
   * themselves into global catalog administration merely because the
   * installation was new. The normal API now ONLY permits:
   *
   *     existing capability admin → grant another capability admin
   *
   * The first admin is created exclusively by the deployment/bootstrap
   * configuration (CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID) processed in
   * serve() at startup (see bootstrapCapabilityAdmin below).
   */
  async grantCapabilityAdmin(input: {
    userId: string;
    actingPrincipal: Principal;
  }): Promise<void> {
    const ok = await this.isCapabilityAdmin(input.actingPrincipal.userId);
    if (!ok) {
      throw policyBlocked("capability.admin.required", "capability.manage authority is required to grant capability-admin", {
        reason: "not_a_capability_admin",
        acting_user_id: input.actingPrincipal.userId,
      });
    }
    await this.db.exec({
      text: `INSERT INTO cp_capability_admins (user_id, permission, granted_by_user_id)
             VALUES ($1, 'capability.manage', $2)
             ON CONFLICT (user_id, permission) DO NOTHING`,
      params: [input.userId, input.actingPrincipal.userId],
    });
    this.logger.info("capabilities: granted capability-admin", {
      granted_user_id: input.userId,
      granted_by: input.actingPrincipal.userId,
    });
  }

  /**
   * Bootstrap the FIRST capability-admin grant on a fresh installation.
   * This is the DEPLOYMENT/OPERATOR authority path (WORK-005 §22
   * correction): it is NOT exposed over HTTP, has NO acting principal,
   * and only grants when cp_capability_admins is EMPTY. When an admin
   * already exists, this is an idempotent no-op (logged) so re-deploys
   * and config-reloads never grant new admins.
   *
   * The granted_by_user_id column is NULL — this is the deployment
   * authority, not a user-mediated grant.
   *
   * Authority model:
   *
   *     deployment/bootstrap configuration (env var)
   *               ↓
   *     initial capability admin  ←  THIS method
   *               ↓
   *     normal capability-admin API (grantCapabilityAdmin)
   *               ↓
   *     subsequent admin grants
   *
   * ATOMICITY (architect review #2 of PR #4): the first-admin claim is
   * made AT THE DATABASE LEVEL, in ONE atomic statement — a check-then-
   * insert sequence can never be safe here:
   *
   *     Instance A: SELECT → empty     Instance B: SELECT → empty
   *     A: INSERT admin(A)             B: INSERT admin(B)
   *     → TWO bootstrap admins (A and B have different PKs, so
   *       ON CONFLICT (user_id, permission) cannot dedupe them)
   *
   * Instead, cp_capability_admin_bootstrap is a SINGLETON table whose
   * PRIMARY KEY is the constant TRUE. All bootstrap attempts conflict on
   * that one key regardless of the user_id they carry, so the claim below
   * is the serialization point:
   *
   *   WITH claim AS (
   *     INSERT INTO cp_capability_admin_bootstrap ... VALUES (TRUE, $user)
   *       ON CONFLICT (singleton) DO NOTHING RETURNING user_id
   *   )
   *   INSERT INTO cp_capability_admins
   *   SELECT ... FROM claim WHERE NOT EXISTS (SELECT 1 FROM cp_capability_admins)
   *
   * PostgreSQL blocks the loser's claim INSERT on the winner's uncommitted
   * singleton tuple until the winner's whole statement commits; the loser
   * then takes the DO NOTHING path, its `claim` CTE is empty, and its
   * admin INSERT selects zero rows. Both the claim and the grant commit
   * together (single-statement atomicity), so exactly ONE bootstrap
   * admin can ever exist. The WHERE NOT EXISTS guard additionally
   * refuses to grant when an admin already exists without a claim row —
   * the upgrade path where a pre-fix installation already has its first
   * admin (the claim is recorded but NO admin is granted).
   *
   * Only the claim winner can reach the admin INSERT, and the claim can
   * be won exactly once EVER, so the guard cannot race with another
   * bootstrap; normal-API grants require an existing admin, so they
   * cannot race an empty admin table either.
   *
   * Returns the outcome so the caller (serve()) can log/observe it.
   */
  async bootstrapCapabilityAdmin(input: {
    userId: string;
    source?: string;
  }): Promise<{ granted: boolean; reason: "granted" | "already_present" | "table_not_empty" }> {
    const userId = input.userId.trim();
    if (userId.length === 0) {
      throw policyBlocked("capability.validation", "bootstrap user_id is required", {
        reason: "missing_user_id",
      });
    }
    const source = input.source ?? "deployment-config";

    // ONE atomic statement: (1) claim the single permanent bootstrap slot
    // (the singleton PK serializes every concurrent attempt), and
    // (2) grant the admin row IFF this call won the claim AND no admin
    // already exists. A row is returned only when THIS call granted the
    // admin; every other outcome returns zero rows.
    const grantedRows = await this.db.query({
      text: `WITH claim AS (
               INSERT INTO cp_capability_admin_bootstrap (singleton, user_id, source)
               VALUES (TRUE, $1, $2)
               ON CONFLICT (singleton) DO NOTHING
               RETURNING user_id
             )
             INSERT INTO cp_capability_admins (user_id, permission, granted_by_user_id)
             SELECT claim.user_id, 'capability.manage', NULL
             FROM claim
             WHERE NOT EXISTS (SELECT 1 FROM cp_capability_admins)
             ON CONFLICT (user_id, permission) DO NOTHING
             RETURNING user_id`,
      params: [userId, source],
    });

    if (grantedRows.length === 1) {
      this.logger.info("capabilities: bootstrap capability-admin", {
        bootstrap_user_id: userId,
        source,
        granted: true,
        reason: "granted",
      });
      return { granted: true, reason: "granted" };
    }

    // No admin was granted by this call: either another bootstrap owns
    // the singleton claim (concurrent loser or re-deploy), or an admin
    // already exists (pre-fix installation / normal-API grants). The
    // end state is identical either way — no new admin was created.
    // Determine the reason for observability only.
    const isAlreadyAdmin = await this.isCapabilityAdmin(userId);
    const reason = isAlreadyAdmin ? "already_present" : "table_not_empty";
    this.logger.info("capabilities: bootstrap capability-admin not applied", {
      bootstrap_user_id: userId,
      source,
      granted: false,
      reason,
    });
    return { granted: false, reason };
  }

  /**
   * Internal authority gate for catalog mutations. Throws POLICY_BLOCKED
   * (capability.admin.required) if the acting principal is not a capability
   * admin. This is the server-side check that an arbitrary org owner/admin
   * cannot mutate the global catalog (WORK-005 §22).
   */
  private async requireCapabilityAdmin(principal: Principal): Promise<void> {
    const ok = await this.isCapabilityAdmin(principal.userId);
    if (!ok) {
      throw policyBlocked("capability.admin.required", "capability.manage authority is required for this operation", {
        reason: "not_a_capability_admin",
        user_id: principal.userId,
      });
    }
  }

  // ---- Capability identity CRUD --------------------------------------

  /**
   * Create a new global capability. The canonical id is validated (lowercase
   * namespace.action) and uniqueness is enforced by the DB (race-safe under
   * concurrent creates). Requires capability.manage authority.
   */
  async createCapability(input: CreateCapabilityInput): Promise<Capability> {
    await this.requireCapabilityAdmin(input.actingPrincipal);
    const capabilityId = validateCapabilityId(input.capabilityId);
    const name = (typeof input.name === "string" ? input.name : "").trim();
    if (name.length === 0) {
      throw policyBlocked("capability.validation", "capability name is required", {
        reason: "missing_name",
      });
    }
    const description =
      typeof input.description === "string" ? input.description.trim() : "";
    const id = `cap_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_capabilities
                 (id, capability_id, name, description, status, created_by_user_id)
               VALUES ($1, $2, $3, $4, 'draft', $5)`,
        params: [id, capabilityId, name, description, input.actingPrincipal.userId],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("capability.duplicate", "a capability with this id already exists", {
          reason: "duplicate_capability_id",
          capability_id: capabilityId,
        });
      }
      throw platformFailure("capability.create.failed", "createCapability failed", err);
    }
    const created = await this.getCapability(capabilityId);
    if (!created) {
      throw platformFailure("capability.create.failed", "capability disappeared after insert");
    }
    this.logger.info("capabilities: created", {
      capability_id: capabilityId,
      internal_id: id,
      created_by: input.actingPrincipal.userId,
    });
    return created;
  }

  /** Get a capability by its canonical id (e.g. 'payment.accept'). */
  async getCapability(canonicalId: string): Promise<Capability | null> {
    const rows = await this.db.query({
      text: `SELECT id, capability_id, name, description, status,
                created_by_user_id, created_at, updated_at
             FROM cp_capabilities
             WHERE lower(capability_id) = lower($1)`,
      params: [canonicalId],
    });
    const row = rows[0];
    return row ? mapCapability(row as CapabilityRow) : null;
  }

  /** Get a capability by its internal surrogate id (cap_<ulid>). */
  async getCapabilityById(internalId: string): Promise<Capability | null> {
    const rows = await this.db.query({
      text: `SELECT id, capability_id, name, description, status,
                created_by_user_id, created_at, updated_at
             FROM cp_capabilities WHERE id = $1`,
      params: [internalId],
    });
    const row = rows[0];
    return row ? mapCapability(row as CapabilityRow) : null;
  }

  /**
   * List capabilities, newest-first, with cursor pagination by internal id
   * DESC (ULID — time-monotonic, lexicographically sortable). Optionally
   * filter by status.
   */
  async listCapabilities(opts: ListCapabilitiesOptions = {}): Promise<CapabilityPage> {
    const limit = clampLimit(opts.limit);
    const fetchN = limit + 1;
    const statusFilter = opts.status && isCapabilityStatus(opts.status) ? opts.status : null;
    let text: string;
    let params: unknown[];
    if (opts.cursor && opts.cursor.startsWith("cap_")) {
      if (statusFilter) {
        text = `SELECT id, capability_id, name, description, status,
                  created_by_user_id, created_at, updated_at
               FROM cp_capabilities
               WHERE id < $1 AND status = $2
               ORDER BY id DESC LIMIT $3`;
        params = [opts.cursor, statusFilter, fetchN];
      } else {
        text = `SELECT id, capability_id, name, description, status,
                  created_by_user_id, created_at, updated_at
               FROM cp_capabilities
               WHERE id < $1
               ORDER BY id DESC LIMIT $2`;
        params = [opts.cursor, fetchN];
      }
    } else {
      if (statusFilter) {
        text = `SELECT id, capability_id, name, description, status,
                  created_by_user_id, created_at, updated_at
               FROM cp_capabilities
               WHERE status = $1
               ORDER BY id DESC LIMIT $2`;
        params = [statusFilter, fetchN];
      } else {
        text = `SELECT id, capability_id, name, description, status,
                  created_by_user_id, created_at, updated_at
               FROM cp_capabilities
               ORDER BY id DESC LIMIT $1`;
        params = [fetchN];
      }
    }
    const rows = await this.db.query({ text, params });
    const all = rows.map((r) => mapCapability(r as CapabilityRow));
    const hasMore = all.length > limit;
    const page = all.slice(0, limit);
    const last = page[page.length - 1];
    return {
      capabilities: page,
      page: {
        next_cursor: hasMore && last ? last.id : null,
        has_more: hasMore,
        limit,
      },
    };
  }

  /**
   * Transition a capability's lifecycle status (draft→active→deprecated→
   * retired). Validates the transition is in LIFECYCLE_TRANSITIONS. Requires
   * capability.manage authority. Deprecating/retiring does NOT change the
   * meaning of any published version (only the status flag flips).
   */
  async transitionCapability(input: TransitionCapabilityInput): Promise<Capability> {
    await this.requireCapabilityAdmin(input.actingPrincipal);
    const existing = await this.getCapability(input.capabilityId);
    if (!existing) {
      throw policyBlocked("capability.not_found", "capability not found", {
        reason: "no_such_capability",
        capability_id: input.capabilityId,
      });
    }
    const allowed = LIFECYCLE_TRANSITIONS.get(existing.status) ?? [];
    if (!allowed.includes(input.toStatus)) {
      throw policyBlocked("capability.lifecycle.invalid", `cannot transition ${existing.status} → ${input.toStatus}`, {
        reason: "invalid_transition",
        from: existing.status,
        to: input.toStatus,
      });
    }
    await this.db.exec({
      text: `UPDATE cp_capabilities SET status = $1, updated_at = NOW()
             WHERE id = $2`,
      params: [input.toStatus, existing.id],
    });
    const updated = await this.getCapabilityById(existing.id);
    if (!updated) throw platformFailure("capability.transition.failed", "capability disappeared");
    this.logger.info("capabilities: transitioned", {
      capability_id: existing.capabilityId,
      from: existing.status,
      to: input.toStatus,
      actor: input.actingPrincipal.userId,
    });
    return updated;
  }

  // ---- Capability versions (immutable published contracts) -----------

  /**
   * Create a new capability version (a contract snapshot). The version starts
   * in 'draft' status; publish it with transitionVersion(draft→active). The
   * contract is structurally validated (JSON-Schema shape) at creation time.
   * The version string, if provided, must be a positive integer; if omitted,
   * auto-assigned as max(existing)+1. Requires capability.manage authority.
   */
  async createVersion(input: CreateVersionInput): Promise<CapabilityVersion> {
    await this.requireCapabilityAdmin(input.actingPrincipal);
    const cap = await this.getCapability(input.capabilityId);
    if (!cap) {
      throw policyBlocked("capability.not_found", "capability not found", {
        reason: "no_such_capability",
        capability_id: input.capabilityId,
      });
    }
    // A retired capability cannot receive new versions.
    if (cap.status === "retired") {
      throw policyBlocked("capability.retired", "cannot add a version to a retired capability", {
        reason: "capability_retired",
      });
    }
    // Validate the contract structurally before persisting.
    const contract = this.validateContract(input.contract);
    // Resolve the version string.
    let version: string;
    if (typeof input.version === "string" && input.version.length > 0) {
      version = validateVersion(input.version);
    } else {
      version = await this.nextVersionNumber(cap.id);
    }
    const id = `capv_${ulid()}`;
    // JSONB columns: the `pg` driver serializes JS arrays as PostgreSQL array
    // literals (not JSON), so JSON.stringify the JSONB fields ourselves and
    // send them as text — PostgreSQL casts the text to jsonb at the column.
    // (Reading JSONB back is handled by pg's default jsonb parser → JS object.)
    try {
      await this.db.exec({
        text: `INSERT INTO cp_capability_versions
                 (id, capability_id, version, input_schema, output_schema,
                  error_model, side_effect, idempotency_semantics,
                  required_context, execution_modes, policy_metadata,
                  constraints, latency_expectations, status, created_by_user_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft',$14)`,
        params: [
          id,
          cap.id,
          version,
          JSON.stringify(contract.inputSchema),
          JSON.stringify(contract.outputSchema),
          JSON.stringify(contract.errorModel),
          contract.sideEffect,
          JSON.stringify(contract.idempotencySemantics),
          JSON.stringify(contract.requiredContext),
          JSON.stringify(contract.executionModes),
          JSON.stringify(contract.policyMetadata),
          JSON.stringify(contract.constraints),
          JSON.stringify(contract.latencyExpectations),
          input.actingPrincipal.userId,
        ],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("capability.version.duplicate", "a version with this number already exists for this capability", {
          reason: "duplicate_version",
          capability_id: cap.capabilityId,
          version,
        });
      }
      throw platformFailure("capability.version.create.failed", "createVersion failed", err);
    }
    const created = await this.getVersion(cap.capabilityId, version);
    if (!created) {
      throw platformFailure("capability.version.create.failed", "version disappeared after insert");
    }
    this.logger.info("capabilities: version created", {
      capability_id: cap.capabilityId,
      version,
      side_effect: contract.sideEffect,
      created_by: input.actingPrincipal.userId,
    });
    return created;
  }

  /** Get a specific version of a capability by canonical id + version. */
  async getVersion(canonicalId: string, version: string): Promise<CapabilityVersion | null> {
    const rows = await this.db.query({
      text: `SELECT v.id, v.capability_id, v.version, v.status,
                v.input_schema, v.output_schema, v.error_model, v.side_effect,
                v.idempotency_semantics, v.required_context, v.execution_modes,
                v.policy_metadata, v.constraints, v.latency_expectations,
                v.created_by_user_id, v.created_at,
                c.capability_id AS capability_canonical_id
             FROM cp_capability_versions v
             JOIN cp_capabilities c ON c.id = v.capability_id
             WHERE lower(c.capability_id) = lower($1) AND v.version = $2`,
      params: [canonicalId, version],
    });
    const row = rows[0];
    return row ? mapVersion(row as VersionRow) : null;
  }

  /** List all versions of a capability, newest-first. */
  async listVersions(
    canonicalId: string,
    opts: ListVersionsOptions = {},
  ): Promise<CapabilityVersion[]> {
    const rows = await this.db.query({
      text: `SELECT v.id, v.capability_id, v.version, v.status,
                v.input_schema, v.output_schema, v.error_model, v.side_effect,
                v.idempotency_semantics, v.required_context, v.execution_modes,
                v.policy_metadata, v.constraints, v.latency_expectations,
                v.created_by_user_id, v.created_at,
                c.capability_id AS capability_canonical_id
             FROM cp_capability_versions v
             JOIN cp_capabilities c ON c.id = v.capability_id
             WHERE lower(c.capability_id) = lower($1)
             ORDER BY v.version DESC`,
      params: [canonicalId],
    });
    let all = rows.map((r) => mapVersion(r as VersionRow));
    if (!opts.includeDeprecated) {
      all = all.filter((v) => v.status !== "deprecated");
    }
    if (!opts.includeRetired) {
      all = all.filter((v) => v.status !== "retired");
    }
    return all;
  }

  /**
   * Transition a version's lifecycle status (draft→active→deprecated→
   * retired). Publishing (draft→active) is the immutability boundary: after
   * this, the contract fields are immutable. Publishing a new active version
   * auto-deprecates the previous active version within the same transaction
   * so the at-most-one-active-version invariant always holds. Requires
   * capability.manage authority.
   */
  async transitionVersion(input: TransitionVersionInput): Promise<CapabilityVersion> {
    await this.requireCapabilityAdmin(input.actingPrincipal);
    const version = await this.getVersion(input.capabilityId, input.version);
    if (!version) {
      throw policyBlocked("capability.version.not_found", "version not found", {
        reason: "no_such_version",
        capability_id: input.capabilityId,
        version: input.version,
      });
    }
    const allowed = LIFECYCLE_TRANSITIONS.get(version.status) ?? [];
    if (!allowed.includes(input.toStatus)) {
      throw policyBlocked("capability.version.lifecycle.invalid", `cannot transition ${version.status} → ${input.toStatus}`, {
        reason: "invalid_transition",
        from: version.status,
        to: input.toStatus,
      });
    }
    // Publish path (draft→active): auto-deprecate any prior active version of
    // the same capability, within a transaction, so the partial UNIQUE index
    // (at-most-one-active) is maintained.
    if (version.status === "draft" && input.toStatus === "active") {
      await this.db.transaction(async (tx) => {
        // Deprecate the prior active version (if any) BEFORE promoting the
        // new one, so the partial UNIQUE index never sees two active rows.
        await tx.exec({
          text: `UPDATE cp_capability_versions
                 SET status = 'deprecated'
                 WHERE capability_id = $1 AND status = 'active' AND id <> $2`,
          params: [version.capabilityId, version.id],
        });
        await tx.exec({
          text: `UPDATE cp_capability_versions SET status = 'active'
                 WHERE id = $1`,
          params: [version.id],
        });
      });
    } else {
      // Non-publish transition: flip only the status column. Contract fields
      // are never touched here (immutability, WORK-005 §18).
      await this.db.exec({
        text: `UPDATE cp_capability_versions SET status = $1 WHERE id = $2`,
        params: [input.toStatus, version.id],
      });
    }
    const updated = await this.getVersion(input.capabilityId, input.version);
    if (!updated) throw platformFailure("capability.version.transition.failed", "version disappeared");
    this.logger.info("capabilities: version transitioned", {
      capability_id: input.capabilityId,
      version: input.version,
      from: version.status,
      to: input.toStatus,
      actor: input.actingPrincipal.userId,
    });
    return updated;
  }

  // ---- Dependency graph ----------------------------------------------

  /**
   * Add a directed dependency edge: capability A (at version vA) requires
   * capability B (optionally pinned to required_version, else B's active
   * version). Validates (WORK-005 §17):
   *   - A and vA exist (and vA is not retired — can't add deps to retired)
   *   - B exists and is not retired
   *   - if required_version pinned: that version of B exists and is not retired
   *   - if required_version null: B has an active version to resolve to
   *   - self-dependency (A requires A) is rejected
   *   - duplicate edge is rejected (DB UNIQUE, race-safe)
   *   - cycle: adding the edge must not create a cycle (DFS)
   * Requires capability.manage authority.
   */
  async addDependency(input: AddDependencyInput): Promise<CapabilityDependency> {
    await this.requireCapabilityAdmin(input.actingPrincipal);

    const capA = await this.getCapability(input.capabilityId);
    if (!capA) {
      throw policyBlocked("capability.not_found", "depending capability not found", {
        reason: "no_such_capability",
        capability_id: input.capabilityId,
      });
    }
    const capB = await this.getCapability(input.requiredCapabilityId);
    if (!capB) {
      throw policyBlocked("capability.dependency.missing", "required capability not found", {
        reason: "missing_dependency",
        required_capability_id: input.requiredCapabilityId,
      });
    }
    if (capB.status === "retired") {
      throw policyBlocked("capability.dependency.retired", "cannot depend on a retired capability", {
        reason: "retired_dependency",
        required_capability_id: capB.capabilityId,
      });
    }
    // Self-dependency rejection (A requires A is a degenerate cycle).
    if (capA.id === capB.id) {
      throw policyBlocked("capability.dependency.self", "a capability cannot depend on itself", {
        reason: "self_dependency",
        capability_id: capA.capabilityId,
      });
    }
    // The depending version vA must exist and not be retired.
    const versionA = await this.getVersion(capA.capabilityId, input.version);
    if (!versionA) {
      throw policyBlocked("capability.version.not_found", "depending version not found", {
        reason: "missing_version",
        capability_id: capA.capabilityId,
        version: input.version,
      });
    }
    if (versionA.status === "retired") {
      throw policyBlocked("capability.dependency.retired_version", "cannot add dependencies to a retired version", {
        reason: "retired_version",
        capability_id: capA.capabilityId,
        version: input.version,
      });
    }
    // Resolve the required version of B.
    let resolvedRequiredVersion: string;
    if (typeof input.requiredVersion === "string" && input.requiredVersion.length > 0) {
      const pinned = validateVersion(input.requiredVersion);
      const pinnedVersion = await this.getVersion(capB.capabilityId, pinned);
      if (!pinnedVersion) {
        throw policyBlocked("capability.dependency.missing_version", "pinned required version not found", {
          reason: "missing_required_version",
          required_capability_id: capB.capabilityId,
          required_version: pinned,
        });
      }
      if (pinnedVersion.status === "retired") {
        throw policyBlocked("capability.dependency.retired_version", "cannot depend on a retired version", {
          reason: "retired_required_version",
          required_capability_id: capB.capabilityId,
          required_version: pinned,
        });
      }
      resolvedRequiredVersion = pinned;
    } else {
      // NULL pin → B's active version. Must exist (else the dependency has
      // nothing to resolve to).
      const activeB = await this.getActiveVersion(capB.id);
      if (!activeB) {
        throw policyBlocked("capability.dependency.no_active_version", "required capability has no active version to resolve to", {
          reason: "no_active_version",
          required_capability_id: capB.capabilityId,
        });
      }
      resolvedRequiredVersion = activeB.version;
    }

    // Cycle detection: load all edges, resolve their targets, add the
    // candidate, and DFS from the candidate target back to (A, vA).
    const existingEdges = await this.loadResolvedEdges();
    const startNode = nodeKey(capA.id, input.version);
    const candidateTarget = nodeKey(capB.id, resolvedRequiredVersion);
    // If an identical edge already exists (same resolved target), the DFS
    // would not flag it as a cycle, but the DB UNIQUE will reject the
    // duplicate. Detect here too for a clean error.
    const dupExists = existingEdges.some(
      (e) => e.from === startNode && e.to === candidateTarget,
    );
    if (dupExists) {
      throw policyBlocked("capability.dependency.duplicate", "this dependency edge already exists", {
        reason: "duplicate_dependency",
        capability_id: capA.capabilityId,
        version: input.version,
        required_capability_id: capB.capabilityId,
        required_version: input.requiredVersion ?? null,
      });
    }
    const cycle = detectCycle(existingEdges, startNode, candidateTarget);
    if (cycle.hasCycle) {
      throw policyBlocked("capability.dependency.cycle", "adding this dependency would create a cycle", {
        reason: "cycle",
        path: cycle.path,
      });
    }

    // Insert the edge. The DB UNIQUE is the race-safe backstop under
    // concurrent adds; the in-memory dup check above is for a clean error.
    const id = `capd_${ulid()}`;
    const requiredVersionParam =
      typeof input.requiredVersion === "string" && input.requiredVersion.length > 0
        ? input.requiredVersion
        : null;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_capability_dependencies
                 (id, capability_id, version, required_capability_id,
                  required_version, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6)`,
        params: [
          id,
          capA.id,
          input.version,
          capB.id,
          requiredVersionParam,
          input.actingPrincipal.userId,
        ],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("capability.dependency.duplicate", "this dependency edge already exists", {
          reason: "duplicate_dependency",
        });
      }
      throw platformFailure("capability.dependency.add.failed", "addDependency failed", err);
    }
    this.logger.info("capabilities: dependency added", {
      capability_id: capA.capabilityId,
      version: input.version,
      required_capability_id: capB.capabilityId,
      required_version: requiredVersionParam,
      resolved_required_version: resolvedRequiredVersion,
      actor: input.actingPrincipal.userId,
    });
    const deps = await this.listDependencies(capA.capabilityId, input.version);
    const added = deps.find((d) => d.id === id);
    if (!added) throw platformFailure("capability.dependency.add.failed", "dependency disappeared after insert");
    return added;
  }

  /** List the direct outgoing dependencies of (capability, version). */
  async listDependencies(canonicalId: string, version: string): Promise<CapabilityDependency[]> {
    const rows = await this.db.query({
      text: `SELECT d.id, d.capability_id, d.version, d.required_capability_id,
                d.required_version, d.created_by_user_id, d.created_at,
                ca.capability_id AS capability_canonical_id,
                cb.capability_id AS required_canonical_id,
                COALESCE(d.required_version, va.version) AS resolved_required_version
             FROM cp_capability_dependencies d
             JOIN cp_capabilities ca ON ca.id = d.capability_id
             JOIN cp_capabilities cb ON cb.id = d.required_capability_id
             LEFT JOIN cp_capability_versions va
               ON va.capability_id = d.required_capability_id
              AND va.status = 'active'
             WHERE lower(ca.capability_id) = lower($1) AND d.version = $2
             ORDER BY d.created_at, d.id`,
      params: [canonicalId, version],
    });
    return rows.map((r) => mapDependency(r as DependencyRow));
  }

  /**
   * Inspect the dependency graph reachable from (capability, version).
   * Returns the direct dependencies, the resolved edges (from→to node keys),
   * a deterministic topological traversal, and the transitive reachable set.
   */
  async getDependencyGraph(canonicalId: string, version: string): Promise<DependencyGraph> {
    const cap = await this.getCapability(canonicalId);
    if (!cap) {
      throw policyBlocked("capability.not_found", "capability not found", {
        reason: "no_such_capability",
        capability_id: canonicalId,
      });
    }
    const v = await this.getVersion(canonicalId, version);
    if (!v) {
      throw policyBlocked("capability.version.not_found", "version not found", {
        reason: "no_such_version",
        capability_id: canonicalId,
        version,
      });
    }
    const direct = await this.listDependencies(canonicalId, version);
    const allEdges = await this.loadResolvedEdges();
    const startNode = nodeKey(cap.id, version);
    const reachableNodes = reachableFrom(allEdges, startNode);
    // Build the subgraph edges that are reachable from the start node
    // (inclusive of the direct edges + transitive). For display, map node
    // keys back to canonical ids.
    const idToCanonical = await this.loadCanonicalMap();
    const reachableSet = new Set([startNode, ...reachableNodes]);
    const subEdges = allEdges
      .filter((e) => reachableSet.has(e.from) && reachableSet.has(e.to))
      .map((e) => {
        const [fc, fv] = splitNodeKey(e.from);
        const [tc, tv] = splitNodeKey(e.to);
        return {
          from: e.from,
          to: e.to,
          fromCanonical: idToCanonical.get(fc) ?? fc,
          fromVersion: fv,
          toCanonical: idToCanonical.get(tc) ?? tc,
          toVersion: tv,
        };
      });
    const topo = topologicalOrder(subEdges);
    return {
      capabilityId: cap.id,
      canonicalId: cap.capabilityId,
      version,
      directDependencies: direct,
      edges: subEdges,
      order: topo.order,
      reachable: reachableNodes,
    };
  }

  // ---- Internal helpers -----------------------------------------------

  private validateContract(c: CapabilityContract): CapabilityContract {
    if (!c || typeof c !== "object") {
      throw policyBlocked("capability.contract.malformed", "contract is required");
    }
    if (!isSideEffect(c.sideEffect)) {
      throw policyBlocked("capability.contract.malformed", `invalid side_effect "${String(c.sideEffect)}"`, {
        reason: "invalid_side_effect",
        field: "side_effect",
      });
    }
    // Validate the input/output schemas structurally (WORK-005 §7).
    const inputSchema = validateJsonSchemaShape(c.inputSchema, "input_schema");
    const outputSchema = validateJsonSchemaShape(c.outputSchema, "output_schema");
    return {
      inputSchema,
      outputSchema,
      errorModel: Array.isArray(c.errorModel) ? c.errorModel : [],
      sideEffect: c.sideEffect,
      idempotencySemantics:
        c.idempotencySemantics && typeof c.idempotencySemantics === "object"
          ? c.idempotencySemantics
          : {},
      requiredContext: Array.isArray(c.requiredContext) ? c.requiredContext : [],
      executionModes: Array.isArray(c.executionModes) ? c.executionModes : [],
      policyMetadata:
        c.policyMetadata && typeof c.policyMetadata === "object"
          ? c.policyMetadata
          : {},
      constraints: Array.isArray(c.constraints) ? c.constraints : [],
      latencyExpectations:
        c.latencyExpectations && typeof c.latencyExpectations === "object"
          ? c.latencyExpectations
          : {},
    };
  }

  /** The current active version of a capability, or null if none. */
  private async getActiveVersion(capInternalId: string): Promise<CapabilityVersion | null> {
    const rows = await this.db.query({
      text: `SELECT v.id, v.capability_id, v.version, v.status,
                v.input_schema, v.output_schema, v.error_model, v.side_effect,
                v.idempotency_semantics, v.required_context, v.execution_modes,
                v.policy_metadata, v.constraints, v.latency_expectations,
                v.created_by_user_id, v.created_at,
                c.capability_id AS capability_canonical_id
             FROM cp_capability_versions v
             JOIN cp_capabilities c ON c.id = v.capability_id
             WHERE v.capability_id = $1 AND v.status = 'active'
             LIMIT 1`,
      params: [capInternalId],
    });
    const row = rows[0];
    return row ? mapVersion(row as VersionRow) : null;
  }

  /** Compute the next version number (max existing integer + 1) for a capability. */
  private async nextVersionNumber(capInternalId: string): Promise<string> {
    const rows = await this.db.query({
      text: `SELECT version FROM cp_capability_versions
             WHERE capability_id = $1
             ORDER BY CAST(version AS BIGINT) DESC NULLS LAST
             LIMIT 1`,
      params: [capInternalId],
    });
    const row = rows[0];
    if (!row || typeof row.version !== "string") return "1";
    const n = parseInt(row.version, 10);
    if (!Number.isFinite(n) || n < 1) return "1";
    return String(n + 1);
  }

  /**
   * Load ALL dependency edges with their target versions resolved (NULL pin
   * → target's active version). Used by cycle detection (which must consider
   * the whole graph). For a V1 catalog this is bounded and correct.
   */
  private async loadResolvedEdges(): Promise<GraphEdge[]> {
    const rows = await this.db.query({
      text: `SELECT d.capability_id, d.version, d.required_capability_id,
                COALESCE(d.required_version, va.version) AS resolved_required_version
             FROM cp_capability_dependencies d
             LEFT JOIN cp_capability_versions va
               ON va.capability_id = d.required_capability_id
              AND va.status = 'active'`,
      params: [],
    });
    return rows.map((r) => {
      const row = r as {
        capability_id: string;
        version: string;
        required_capability_id: string;
        resolved_required_version: string;
      };
      return {
        from: nodeKey(row.capability_id, row.version),
        to: nodeKey(
          row.required_capability_id,
          row.resolved_required_version ?? "?",
        ),
      };
    });
  }

  /** Map internal capability ids → canonical ids (for graph display). */
  private async loadCanonicalMap(): Promise<Map<string, string>> {
    const rows = await this.db.query({
      text: `SELECT id, capability_id FROM cp_capabilities`,
      params: [],
    });
    const m = new Map<string, string>();
    for (const r of rows) {
      const row = r as { id: string; capability_id: string };
      m.set(row.id, row.capability_id);
    }
    return m;
  }
}

// ---- Helpers ----------------------------------------------------------

function splitNodeKey(key: string): [string, string] {
  const idx = key.lastIndexOf("@");
  if (idx < 0) return [key, ""];
  return [key.slice(0, idx), key.slice(idx + 1)];
}
