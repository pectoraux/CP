// /policies/internal/service.ts
// PoliciesService — the /policies module's concrete service (WORK-008,
// architecture §10, §34, §36; frozen POLICY-001..004). Owns:
//   - project-scoped policy identity (cp_policies) — customer/tenant
//     rules under Organization → Project (architecture §5/§34)
//   - immutable, versioned rule sets (cp_policy_versions) with the
//     DRAFT → ACTIVE → DEPRECATED → RETIRED lifecycle and the
//     at-most-one-active (effective version) invariant
//   - deterministic policy evaluation over the PURE evaluator
//
// Layer separation (WORK-008 §3): the policy engine expresses the RULES
// ("what requirements must an execution satisfy?"). It does NOT choose
// providers, rank candidates, or implement eligibility/routing/
// optimization — those are WORK-009+ and consume the evaluation results.
//
// Tenancy/authorization (WORK-008 §4, §16): every method takes the
// AUTHORIZED (organizationId, projectId) pair resolved by the /api
// org/project context middlewares — never raw request params. The
// service re-verifies server-side (defense in depth, the WORK-004
// projects precedent): the acting principal must hold an ACTIVE
// membership in the organization for reads; mutations additionally
// require the admin or owner role. Cross-org and cross-project access
// is rejected (the project-scope join + id-scoped queries mean another
// org's ids simply do not resolve).
//
// Purity (WORK-008 §11): the evaluator is pure (evaluator.ts); this
// service only LOADS the policy version and validates the caller's
// context before invoking it. Evaluation mutates nothing.
//
// PostgreSQL is authoritative via the provider-neutral platform
// Database interface. Dependencies: @cp/platform + @cp/auth only
// (Principal, activeMembershipIn — the same vocabulary the projects
// module uses). Project scope validity is enforced by the FK plus an
// explicit project∈org read join (the WORK-006/007 cross-module SQL
// join precedent).

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
import { activeMembershipIn } from "@cp/auth";
import {
  validateRules,
  validateEvaluationContext,
  MAX_POLICY_NAME_LEN,
  MAX_POLICY_DESCRIPTION_LEN,
  type PolicyRule,
  type RulesDocument,
} from "./rules.ts";
import { evaluateRules, type PolicyEvaluationResult } from "./evaluator.ts";

// ---- Lifecycle (WORK-008 §6; matches the WORK-005 capability precedent) ----

export type PolicyVersionStatus = "draft" | "active" | "deprecated" | "retired";

export const POLICY_VERSION_STATUSES: readonly PolicyVersionStatus[] = [
  "draft",
  "active",
  "deprecated",
  "retired",
] as const;

/**
 * Valid version lifecycle transitions. RETIRED is terminal. Activation
 * (draft → active) is handled by transitionVersion, which deprecates
 * the previous active version within the same transaction (WORK-005
 * publish-with-auto-deprecate precedent). Drafts may be discarded
 * (draft → retired).
 */
export const POLICY_VERSION_LIFECYCLE: ReadonlyMap<PolicyVersionStatus, readonly PolicyVersionStatus[]> =
  new Map([
    ["draft", ["active", "retired"]],
    ["active", ["deprecated", "retired"]],
    ["deprecated", ["retired"]],
    ["retired", []],
  ]);

export function isPolicyVersionStatus(v: string): v is PolicyVersionStatus {
  return (POLICY_VERSION_STATUSES as readonly string[]).includes(v);
}

// ---- Record types ---------------------------------------------------------

export interface Policy {
  id: string; // pol_<ulid>
  projectId: string; // internal proj_<ulid>
  name: string;
  description: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyVersion {
  id: string; // pver_<ulid>
  policyId: string; // internal pol_<ulid>
  version: string; // "1", "2", ...
  status: PolicyVersionStatus;
  rules: PolicyRule[];
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Inputs ---------------------------------------------------------------

export interface CreatePolicyInput {
  organizationId: string; // AUTHORIZED org id (from orgContextMiddleware)
  projectId: string; // AUTHORIZED project id (from projectContextMiddleware)
  name: string;
  description?: string;
  actingPrincipal: Principal;
}

export interface ListPoliciesOptions {
  limit?: number;
  cursor?: string | null;
  includeRetired?: boolean;
}

export interface PolicyPage {
  policies: Policy[];
  nextCursor: string | null;
}

export interface CreatePolicyVersionInput {
  organizationId: string;
  projectId: string;
  policyId: string;
  /** Optional explicit version number ("1", "2", ...); default: max+1. */
  version?: string;
  rules: unknown;
  actingPrincipal: Principal;
}

export interface UpdateDraftVersionInput {
  organizationId: string;
  projectId: string;
  policyId: string;
  version: string;
  rules: unknown;
  actingPrincipal: Principal;
}

export interface TransitionPolicyVersionInput {
  organizationId: string;
  projectId: string;
  policyId: string;
  version: string;
  toStatus: PolicyVersionStatus;
  actingPrincipal: Principal;
}

export interface EvaluatePolicyInput {
  organizationId: string;
  projectId: string;
  policyId: string;
  /** Explicit version to evaluate (WORK-008 §20 — evaluation is
   * version-pinned; draft evaluation is an operator preview surface,
   * while the EFFECTIVE policy for the system is always the ACTIVE
   * version via getEffectiveVersion). */
  version: string;
  context: unknown;
  actingPrincipal: Principal;
}

export interface PoliciesServiceOptions {
  db: Database;
  logger?: Logger;
}

const NOOP_SINK: LogSink = {
  emit(_record: LogRecord): void {},
};

// ---- Service ---------------------------------------------------------------

export class PoliciesService {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(opts: PoliciesServiceOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
  }

  // ---- Tenancy + authorization -------------------------------------------

  /**
   * Verify the (organizationId, projectId) scope is real and belongs
   * together, and that the acting principal is an ACTIVE member of the
   * organization (any role — the read gate). Mutations additionally
   * call requireOrgAdmin. Cross-org project id substitution cannot
   * resolve: the join requires project ∈ org.
   */
  private async requireProjectScope(
    organizationId: string,
    projectId: string,
    principal: Principal,
    opts: { requireAdmin?: boolean } = {},
  ): Promise<void> {
    const membership = activeMembershipIn(principal, organizationId);
    if (!membership) {
      throw policyBlocked("policy.membership.required", "an active membership in this organization is required", {
        reason: "not_a_member",
        organization_id: organizationId,
      });
    }
    if (opts.requireAdmin && membership.role !== "admin" && membership.role !== "owner") {
      throw policyBlocked("policy.role.required", "the admin or owner role is required to mutate policies", {
        reason: "insufficient_role",
        required_roles: ["admin", "owner"],
        actual_role: membership.role,
      });
    }
    const rows = await this.db.query({
      text: `SELECT id FROM cp_projects WHERE id = $1 AND organization_id = $2`,
      params: [projectId, organizationId],
    });
    if (rows.length === 0) {
      throw notFound("policy.project.not_found", "the project does not exist in this organization", {
        project_id: projectId,
      });
    }
  }

  // ---- Policy identity ------------------------------------------------------

  async createPolicy(input: CreatePolicyInput): Promise<Policy> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const name = (typeof input.name === "string" ? input.name : "").trim();
    if (name.length === 0) {
      throw policyBlocked("policy.validation", "policy name is required", { reason: "missing_name" });
    }
    if (name.length > MAX_POLICY_NAME_LEN) {
      throw policyBlocked("policy.validation", `policy name may be at most ${MAX_POLICY_NAME_LEN} characters`, {
        reason: "name_too_long",
      });
    }
    const description =
      typeof input.description === "string" ? input.description.trim().slice(0, MAX_POLICY_DESCRIPTION_LEN) : "";
    const id = `pol_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_policies (id, project_id, name, description, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5)`,
        params: [id, input.projectId, name, description, input.actingPrincipal.userId],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("policy.duplicate", "a policy with this name already exists in this project", {
          reason: "duplicate_name",
        });
      }
      throw err;
    }
    this.logger.info("policies: created", {
      policy_id: id,
      project_id: input.projectId,
      organization_id: input.organizationId,
      user_id: input.actingPrincipal.userId,
    });
    const created = await this.getPolicy(input.organizationId, input.projectId, id);
    if (!created) {
      throw platformFailure("policy.create.readback", "policy creation succeeded but the row could not be read back");
    }
    return created;
  }

  async getPolicy(organizationId: string, projectId: string, policyId: string): Promise<Policy | null> {
    const rows = await this.db.query({
      text: `SELECT p.* FROM cp_policies p
             JOIN cp_projects pr ON pr.id = p.project_id
             WHERE p.id = $1 AND pr.organization_id = $2 AND p.project_id = $3`,
      params: [policyId, organizationId, projectId],
    });
    const row = rows[0];
    return row ? mapPolicy(row as PolicyRow) : null;
  }

  async listPolicies(
    organizationId: string,
    projectId: string,
    opts: ListPoliciesOptions = {},
  ): Promise<PolicyPage> {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: string[] = [`pr.organization_id = $1`, `p.project_id = $2`];
    const params: unknown[] = [organizationId, projectId];
    if (!opts.includeRetired) {
      // A policy is "fully retired" when it has versions and ALL of them
      // are retired; the default list hides only those (a policy with no
      // versions yet is still visible).
      where.push(
        `NOT (
           EXISTS (SELECT 1 FROM cp_policy_versions v WHERE v.policy_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM cp_policy_versions v WHERE v.policy_id = p.id AND v.status <> 'retired')
         )`,
      );
    }
    if (opts.cursor) {
      params.push(opts.cursor);
      where.push(`p.id < $${params.length}`);
    }
    const rows = await this.db.query({
      text: `SELECT p.* FROM cp_policies p
             JOIN cp_projects pr ON pr.id = p.project_id
             WHERE ${where.join(" AND ")}
             ORDER BY p.id DESC
             LIMIT ${limit + 1}`,
      params,
    });
    const all = rows.map((r) => mapPolicy(r as PolicyRow));
    const page = all.slice(0, limit);
    const nextCursor = all.length > limit ? page[page.length - 1]!.id : null;
    return { policies: page, nextCursor };
  }

  // ---- Versions -----------------------------------------------------------

  /**
   * Create a new DRAFT version with validated rules. Rule validation
   * (closed vocabulary, type gating, caps) and deterministic conflict
   * detection run BEFORE persistence — an internally contradictory
   * version is rejected, and nothing outside the constrained model can
   * be stored. The version number defaults to max+1 and is unique per
   * policy (DB constraint; concurrent same-number creates resolve to
   * exactly one winner).
   */
  async createVersion(input: CreatePolicyVersionInput): Promise<PolicyVersion> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const policy = await this.getPolicy(input.organizationId, input.projectId, input.policyId);
    if (!policy) {
      throw notFound("policy.not_found", "the policy was not found in this project", {
        policy_id: input.policyId,
      });
    }
    const doc = validateRules(input.rules);
    const version = input.version
      ? validateVersionNumber(input.version)
      : await this.nextVersionNumber(policy.id);
    const id = `pver_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_policy_versions (id, policy_id, version, status, rules, created_by_user_id)
               VALUES ($1, $2, $3, 'draft', $4::jsonb, $5)`,
        params: [id, policy.id, version, JSON.stringify(doc), input.actingPrincipal.userId],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("policy.version.duplicate", `version "${version}" already exists for this policy`, {
          reason: "duplicate_version",
          version,
        });
      }
      throw err;
    }
    this.logger.info("policies: version created (draft)", {
      policy_id: policy.id,
      policy_version: version,
      rule_count: doc.rules.length,
      project_id: input.projectId,
      organization_id: input.organizationId,
      user_id: input.actingPrincipal.userId,
    });
    const created = await this.getVersionRow(policy.id, version);
    if (!created) {
      throw platformFailure("policy.version.readback", "version creation succeeded but the row could not be read back");
    }
    return created;
  }

  /**
   * Replace the rules of a DRAFT version (it has never been published —
   * WORK-008 §5: "an active version must not silently mutate"; drafts
   * are the only mutable state). Published versions (active/deprecated/
   * retired) are refused outright: the service exposes NO path that
   * mutates them, so historical evaluations remain interpretable.
   */
  async updateDraftVersion(input: UpdateDraftVersionInput): Promise<PolicyVersion> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const policy = await this.getPolicy(input.organizationId, input.projectId, input.policyId);
    if (!policy) {
      throw notFound("policy.not_found", "the policy was not found in this project", {
        policy_id: input.policyId,
      });
    }
    const existing = await this.getVersionRow(policy.id, input.version);
    if (!existing) {
      throw notFound("policy.version.not_found", `version "${input.version}" was not found`, {
        policy_id: policy.id,
        version: input.version,
      });
    }
    if (existing.status !== "draft") {
      throw policyBlocked("policy.version.immutable", `version "${input.version}" is ${existing.status} and cannot be modified — publish a NEW version instead`, {
        reason: "version_not_draft",
        version: input.version,
        status: existing.status,
      });
    }
    const doc = validateRules(input.rules);
    await this.db.exec({
      text: `UPDATE cp_policy_versions SET rules = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      params: [JSON.stringify(doc), existing.id],
    });
    this.logger.info("policies: draft version updated", {
      policy_id: policy.id,
      policy_version: input.version,
      rule_count: doc.rules.length,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    const updated = await this.getVersionRow(policy.id, input.version);
    if (!updated) {
      throw platformFailure("policy.version.readback", "update succeeded but the row could not be read back");
    }
    return updated;
  }

  /**
   * Transition a version's lifecycle. Activation (→ active):
   *   - requires the version to be draft
   *   - deprecates the currently active version (if any) within the
   *     SAME transaction, preserving the at-most-one-active invariant
   *   - the partial unique index makes concurrent activations race-safe
   *     (exactly one winner; the loser receives a deterministic
   *     policy.version.activation_conflict)
   */
  async transitionVersion(input: TransitionPolicyVersionInput): Promise<PolicyVersion> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const policy = await this.getPolicy(input.organizationId, input.projectId, input.policyId);
    if (!policy) {
      throw notFound("policy.not_found", "the policy was not found in this project", {
        policy_id: input.policyId,
      });
    }
    if (!isPolicyVersionStatus(input.toStatus)) {
      throw policyBlocked("policy.validation", `unknown policy version status "${String(input.toStatus)}"`, {
        reason: "invalid_status",
      });
    }
    const existing = await this.getVersionRow(policy.id, input.version);
    if (!existing) {
      throw notFound("policy.version.not_found", `version "${input.version}" was not found`, {
        policy_id: policy.id,
        version: input.version,
      });
    }
    const allowed = POLICY_VERSION_LIFECYCLE.get(existing.status) ?? [];
    if (!allowed.includes(input.toStatus)) {
      throw policyBlocked("policy.transition.invalid", `policy version cannot transition from "${existing.status}" to "${input.toStatus}"`, {
        reason: "invalid_transition",
        from: existing.status,
        to: input.toStatus,
        allowed,
      });
    }

    if (input.toStatus === "active") {
      try {
        await this.db.transaction(async (tx) => {
          // Deprecate the previous active version (if any) first, then
          // activate — one transaction, invariant preserved.
          await tx.exec({
            text: `UPDATE cp_policy_versions
                   SET status = 'deprecated', updated_at = NOW()
                   WHERE policy_id = $1 AND status = 'active'`,
            params: [policy.id],
          });
          await tx.exec({
            text: `UPDATE cp_policy_versions
                   SET status = 'active', updated_at = NOW()
                   WHERE id = $1`,
            params: [existing.id],
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Concurrent activation won the race for the single active slot.
          throw policyBlocked("policy.version.activation_conflict", "another version was activated concurrently; retry with the current state", {
            reason: "concurrent_activation",
            policy_id: policy.id,
            version: input.version,
          });
        }
        throw err;
      }
    } else {
      await this.db.exec({
        text: `UPDATE cp_policy_versions SET status = $1, updated_at = NOW() WHERE id = $2`,
        params: [input.toStatus, existing.id],
      });
    }
    this.logger.info("policies: version transitioned", {
      policy_id: policy.id,
      policy_version: input.version,
      from: existing.status,
      to: input.toStatus,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    const updated = await this.getVersionRow(policy.id, input.version);
    if (!updated) {
      throw platformFailure("policy.version.readback", "transition succeeded but the row could not be read back");
    }
    return updated;
  }

  async getVersion(
    organizationId: string,
    projectId: string,
    policyId: string,
    version: string,
  ): Promise<PolicyVersion | null> {
    const policy = await this.getPolicy(organizationId, projectId, policyId);
    if (!policy) return null;
    return this.getVersionRow(policy.id, version);
  }

  async listVersions(
    organizationId: string,
    projectId: string,
    policyId: string,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ versions: PolicyVersion[]; nextCursor: string | null }> {
    const policy = await this.getPolicy(organizationId, projectId, policyId);
    if (!policy) {
      throw notFound("policy.not_found", "the policy was not found in this project", {
        policy_id: policyId,
      });
    }
    const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
    const where: string[] = [`policy_id = $1`];
    const params: unknown[] = [policy.id];
    if (opts.cursor) {
      params.push(opts.cursor);
      where.push(`id < $${params.length}`);
    }
    const rows = await this.db.query({
      text: `SELECT * FROM cp_policy_versions WHERE ${where.join(" AND ")}
             ORDER BY id DESC LIMIT ${limit + 1}`,
      params,
    });
    const all = rows.map((r) => mapVersionRow(r as VersionRow));
    const page = all.slice(0, limit);
    const nextCursor = all.length > limit ? page[page.length - 1]!.id : null;
    return { versions: page, nextCursor };
  }

  /**
   * The EFFECTIVE version: the single ACTIVE version of the policy, or
   * null when none is active. Explicit and deterministic (the partial
   * unique index guarantees at most one) — never "ORDER BY version
   * DESC" (a higher version may be draft or retired). This is the
   * resolution primitive the future Eligibility engine (WORK-009)
   * consumes.
   */
  async getEffectiveVersion(
    organizationId: string,
    projectId: string,
    policyId: string,
  ): Promise<PolicyVersion | null> {
    const policy = await this.getPolicy(organizationId, projectId, policyId);
    if (!policy) return null;
    const rows = await this.db.query({
      text: `SELECT * FROM cp_policy_versions WHERE policy_id = $1 AND status = 'active' LIMIT 1`,
      params: [policy.id],
    });
    const row = rows[0];
    return row ? mapVersionRow(row as VersionRow) : null;
  }

  // ---- Evaluation -------------------------------------------------------------

  /**
   * Evaluate an EXPLICIT policy version against a caller-supplied,
   * normalized evaluation context (WORK-008 §20): read-only, no provider
   * execution, no mutation. Loads the version, validates the context
   * shape (resource-bounded primitives), and invokes the PURE evaluator.
   * Any lifecycle state may be evaluated explicitly (draft = operator
   * preview); the EFFECTIVE policy for the system remains the ACTIVE
   * version (getEffectiveVersion).
   */
  async evaluatePolicyVersion(input: EvaluatePolicyInput): Promise<PolicyEvaluationResult> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal);
    const policy = await this.getPolicy(input.organizationId, input.projectId, input.policyId);
    if (!policy) {
      throw notFound("policy.not_found", "the policy was not found in this project", {
        policy_id: input.policyId,
      });
    }
    const version = await this.getVersionRow(policy.id, input.version);
    if (!version) {
      throw notFound("policy.version.not_found", `version "${input.version}" was not found`, {
        policy_id: policy.id,
        version: input.version,
      });
    }
    const context = validateEvaluationContext(input.context);
    const result = evaluateRules(policy.id, version.version, version.rules, context);
    // Observability WITHOUT logging the caller's evaluation context
    // (WORK-008 §22): the summary carries ids and the pass/fail shape.
    this.logger.info("policies: evaluated", {
      policy_id: policy.id,
      policy_version: version.version,
      version_status: version.status,
      passed: result.passed,
      hard_violations: result.hardConstraints.violations.length,
      preference_violations: result.preferences.violated.length,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return result;
  }

  // ---- internal helpers ---------------------------------------------------------

  private async getVersionRow(policyInternalId: string, version: string): Promise<PolicyVersion | null> {
    const rows = await this.db.query({
      text: `SELECT * FROM cp_policy_versions WHERE policy_id = $1 AND version = $2`,
      params: [policyInternalId, version],
    });
    const row = rows[0];
    return row ? mapVersionRow(row as VersionRow) : null;
  }

  private async nextVersionNumber(policyInternalId: string): Promise<string> {
    const rows = await this.db.query({
      text: `SELECT COALESCE(MAX(version::int), 0)::int AS max_v FROM cp_policy_versions WHERE policy_id = $1`,
      params: [policyInternalId],
    });
    const maxV = Number((rows[0] as { max_v: number | string }).max_v ?? 0);
    return String(maxV + 1);
  }
}

// ---- Row mappers ---------------------------------------------------------------

interface PolicyRow extends DbQueryResultRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapPolicy(row: PolicyRow): Policy {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface VersionRow extends DbQueryResultRow {
  id: string;
  policy_id: string;
  version: string;
  status: string;
  rules: unknown;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapVersionRow(row: VersionRow): PolicyVersion {
  const doc = row.rules as RulesDocument | null;
  const rules: PolicyRule[] =
    doc && typeof doc === "object" && Array.isArray((doc as RulesDocument).rules)
      ? (doc as RulesDocument).rules
      : [];
  return {
    id: row.id,
    policyId: row.policy_id,
    version: row.version,
    status: row.status as PolicyVersionStatus,
    rules,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ---- Validation + error helpers -------------------------------------------------

function validateVersionNumber(v: string): string {
  if (!/^[0-9]+$/.test(v) || Number(v) < 1) {
    throw policyBlocked("policy.validation", `version must be a positive integer string (got "${v}")`, {
      reason: "invalid_version",
    });
  }
  return v;
}

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

function notFound(code: string, message: string, details?: Record<string, unknown>): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code,
    message,
    retryable: false,
    details: { reason: code, ...(details ?? {}) },
  });
}

function platformFailure(code: string, message: string): AppError {
  return new AppError({
    category: "PLATFORM_FAILURE",
    code,
    message,
    retryable: false,
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
