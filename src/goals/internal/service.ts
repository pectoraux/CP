// /goals/internal/service.ts
// GoalsService — the /goals module's concrete service (WORK-011,
// architecture §5, §36; frozen GOAL-001..003). Owns the customer
// objective layer: WHAT the customer wants, and — through exact
// immutable outcome-contract references — HOW success will be measured.
//
//   Goal        = the desired business/technical objective (semantic)
//   Outcome     = how success/failure is measured (measurable — /outcomes)
//   Policy      = what must be true (a SEPARATE domain — never imported)
//   Strategy    = how to achieve it (future WORK-012 — never generated here)
//
// Versioning/lifecycle (the WORK-005/008 precedents): draft → active →
// deprecated → retired; drafts replaceable; published versions
// IMMUTABLE; at-most-one-active via a partial unique index; activation
// auto-deprecates the previous active version within one transaction;
// concurrent activation is race-safe.
//
// VERSION INTEGRITY (the goal ↔ contract reference invariant): a goal
// version may reference ONLY a PUBLISHED (immutable) outcome-contract
// version — active or deprecated. Draft contract versions are still
// mutable (updateDraftContent) and are rejected at goal-version
// CREATION, so a mutable measurement definition can never back a goal
// version that can become active; goal-version ACTIVATION defensively
// re-verifies the reference for rows that bypassed creation validation.
// The exact immutable version reference — never a copy of the content —
// is the authority: historical goal versions stay interpretable against
// the exact contract version they reference, across any later contract
// versions.
//
// NOT implemented (§18, §29): strategy generation, optimization, utility
// scoring — the objectives are the semantic target future layers
// evaluate against.
//
// TENANCY (§3, §19): project-scoped; the (organizationId, projectId)
// pair is resolved by the /api org/project gates and re-verified here
// via the /projects PUBLIC interface + activeMembershipIn (defense in
// depth). Reads: any active member. Mutations: admin/owner.

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
import type { ProjectsService } from "@cp/projects";
import type {
  OutcomesService,
  OutcomeContractVersion,
  OutcomeContractDocument,
} from "@cp/outcomes";
import {
  validateObjectives,
  type ObjectivesDocument,
  type GoalObjective,
} from "./objectives.ts";
import { validateOutcomeContractDocument } from "@cp/outcomes";

// ---- Lifecycle ------------------------------------------------------------------

export type GoalVersionStatus = "draft" | "active" | "deprecated" | "retired";

export const GOAL_VERSION_STATUSES: readonly GoalVersionStatus[] = [
  "draft",
  "active",
  "deprecated",
  "retired",
] as const;

export const GOAL_VERSION_LIFECYCLE: ReadonlyMap<GoalVersionStatus, readonly GoalVersionStatus[]> =
  new Map([
    ["draft", ["active", "retired"]],
    ["active", ["deprecated", "retired"]],
    ["deprecated", ["retired"]],
    ["retired", []],
  ]);

export function isGoalVersionStatus(v: string): v is GoalVersionStatus {
  return (GOAL_VERSION_STATUSES as readonly string[]).includes(v);
}

// ---- Record types -------------------------------------------------------------------

export interface Goal {
  id: string; // goal_<ulid>
  projectId: string;
  name: string;
  description: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalVersion {
  id: string; // goalv_<ulid>
  goalId: string; // internal goal_<ulid>
  version: string; // "1", "2", ...
  status: GoalVersionStatus;
  objectives: GoalObjective[];
  outcomeContractId: string; // oc_<ulid> — the exact measurement definition
  outcomeContractVersion: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Inputs ---------------------------------------------------------------------------

export interface CreateGoalInput {
  organizationId: string;
  projectId: string;
  name: string;
  description?: string;
  actingPrincipal: Principal;
}

export interface CreateGoalVersionInput {
  organizationId: string;
  projectId: string;
  goalId: string;
  /** Raw objectives (validated by validateObjectives). */
  objectives: unknown;
  /** Reference an EXISTING outcome contract version (the exact
   *  measurement definition this goal version measures against). */
  outcomeContractId: string;
  outcomeContractVersion: string;
  actingPrincipal: Principal;
}

export interface UpdateDraftVersionInput {
  organizationId: string;
  projectId: string;
  goalId: string;
  version: string;
  objectives: unknown;
  actingPrincipal: Principal;
}

export interface TransitionGoalVersionInput {
  organizationId: string;
  projectId: string;
  goalId: string;
  version: string;
  toStatus: GoalVersionStatus;
  actingPrincipal: Principal;
}

export interface ListGoalsOptions {
  limit?: number;
  cursor?: string | null;
  includeRetired?: boolean;
}

export interface GoalPage {
  goals: Goal[];
  nextCursor: string | null;
}

export interface GoalsServiceOptions {
  db: Database;
  logger?: Logger;
  projects: ProjectsService;
  outcomes: OutcomesService;
}

const NOOP_SINK: LogSink = {
  emit(_record: LogRecord): void {},
};

const MAX_NAME_LEN = 200;
const MAX_DESCRIPTION_LEN = 2000;

// ---- Service -----------------------------------------------------------------------------

export class GoalsService {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly projects: ProjectsService;
  private readonly outcomes: OutcomesService;

  constructor(opts: GoalsServiceOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
    this.projects = opts.projects;
    this.outcomes = opts.outcomes;
  }

  // ---- Tenancy + authorization (§19) ------------------------------------------------

  private async requireProjectScope(
    organizationId: string,
    projectId: string,
    principal: Principal,
    opts: { requireAdmin?: boolean } = {},
  ): Promise<void> {
    const membership = activeMembershipIn(principal, organizationId);
    if (!membership) {
      throw policyBlocked("goal.membership.required", "an active membership in this organization is required", {
        reason: "not_a_member",
        organization_id: organizationId,
      });
    }
    if (opts.requireAdmin && membership.role !== "admin" && membership.role !== "owner") {
      throw policyBlocked("goal.role.required", "the admin or owner role is required to mutate goals", {
        reason: "insufficient_role",
        required_roles: ["admin", "owner"],
        actual_role: membership.role,
      });
    }
    const project = await this.projects.getProject(organizationId, projectId);
    if (!project) {
      throw notFound("goal.project.not_found", "the project does not exist in this organization", {
        project_id: projectId,
      });
    }
  }

  // ---- Goal CRUD ----------------------------------------------------------------------

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const name = (typeof input.name === "string" ? input.name : "").trim();
    if (name.length === 0) {
      throw policyBlocked("goal.validation", "goal name is required", { reason: "missing_name" });
    }
    if (name.length > MAX_NAME_LEN) {
      throw policyBlocked("goal.validation", `goal name may be at most ${MAX_NAME_LEN} characters`, {
        reason: "name_too_long",
      });
    }
    const description =
      typeof input.description === "string" ? input.description.trim().slice(0, MAX_DESCRIPTION_LEN) : "";
    const id = `goal_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_goals (id, project_id, name, description, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5)`,
        params: [id, input.projectId, name, description, input.actingPrincipal.userId],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("goal.duplicate", "a goal with this name already exists in this project", {
          reason: "duplicate_name",
        });
      }
      throw err;
    }
    this.logger.info("goals: created", {
      goal_id: id,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    const created = await this.getGoalRow(input.projectId, id);
    if (!created) {
      throw platformFailure("goal.readback.failed", "goal creation succeeded but the row could not be read back");
    }
    return created;
  }

  async getGoal(organizationId: string, projectId: string, goalId: string, principal: Principal): Promise<Goal | null> {
    await this.requireProjectScope(organizationId, projectId, principal);
    return this.getGoalRow(projectId, goalId);
  }

  async listGoals(
    organizationId: string,
    projectId: string,
    principal: Principal,
    opts: ListGoalsOptions = {},
  ): Promise<GoalPage> {
    await this.requireProjectScope(organizationId, projectId, principal);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: string[] = [`project_id = $1`];
    const params: unknown[] = [projectId];
    if (!opts.includeRetired) {
      // Hide fully-retired goals (all versions retired) — the policies
      // listing convention.
      where.push(
        `NOT (
           EXISTS (SELECT 1 FROM cp_goal_versions v WHERE v.goal_id = cp_goals.id)
           AND NOT EXISTS (SELECT 1 FROM cp_goal_versions v WHERE v.goal_id = cp_goals.id AND v.status <> 'retired')
         )`,
      );
    }
    if (opts.cursor) {
      params.push(opts.cursor);
      where.push(`id < $${params.length}`);
    }
    const rows = await this.db.query({
      text: `SELECT * FROM cp_goals WHERE ${where.join(" AND ")}
             ORDER BY id DESC LIMIT ${limit + 1}`,
      params,
    });
    const all = rows.map((r) => mapGoal(r as GoalRow));
    const page = all.slice(0, limit);
    const nextCursor = all.length > limit ? page[page.length - 1]!.id : null;
    return { goals: page, nextCursor };
  }

  // ---- Goal versions --------------------------------------------------------------------

  /**
   * Create a new DRAFT goal version: validated objectives + an EXACT
   * outcome-contract reference. The referenced contract version is
   * resolved through the /outcomes PUBLIC interface (project-scoped):
   * it must exist, it must be PUBLISHED (immutable — active or
   * deprecated; draft versions are still mutable and are rejected so
   * they can never become the measurement definition of an activatable
   * goal version), and its metric/direction must be compatible with the
   * objectives (the same measurement space). A semantic change NEVER
   * overwrites a published version — a new version is the only path.
   */
  async createVersion(input: CreateGoalVersionInput): Promise<GoalVersion> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const goal = await this.getGoalRow(input.projectId, input.goalId);
    if (!goal) {
      throw notFound("goal.not_found", "the goal was not found in this project");
    }
    const doc = validateObjectives(input.objectives);

    // Resolve the EXACT contract version through the /outcomes public
    // interface — it must exist within this project.
    const contractVersion = await this.outcomes.getVersion(
      input.organizationId,
      input.projectId,
      input.outcomeContractId,
      input.outcomeContractVersion,
      input.actingPrincipal,
    );
    if (!contractVersion) {
      throw policyBlocked("goal.outcome_contract.not_found", `outcome contract "${input.outcomeContractId}" version "${input.outcomeContractVersion}" was not found in this project`, {
        reason: "contract_version_not_found",
        outcome_contract_id: input.outcomeContractId,
        outcome_contract_version: input.outcomeContractVersion,
      });
    }
    if (contractVersion.status === "draft") {
      // VERSION INTEGRITY: a draft contract version is still MUTABLE
      // (updateDraftContent can change its semantics at any time). It
      // must never become the measurement definition of a goal version
      // that can be activated — the goal would silently change meaning
      // once its reference is edited. Publish the contract version
      // first; the exact immutable reference stays the authority.
      throw policyBlocked(
        "goal.outcome_contract.mutable",
        `outcome contract "${input.outcomeContractId}" version "${input.outcomeContractVersion}" is still draft and mutable — publish the contract version before referencing it from a goal version`,
        {
          reason: "contract_version_mutable",
          stage: "creation",
          outcome_contract_id: input.outcomeContractId,
          outcome_contract_version: input.outcomeContractVersion,
        },
      );
    }
    if (contractVersion.status === "retired") {
      throw policyBlocked("goal.outcome_contract.retired", "a retired outcome contract version cannot be referenced by a new goal version", {
        reason: "contract_version_retired",
      });
    }
    // Semantic compatibility: every objective's metric must be defined
    // (measurable) by the referenced contract.
    const contract = contractVersion.content as OutcomeContractDocument;
    for (const objective of doc.objectives) {
      if (objective.metric !== contract.metric) {
        throw policyBlocked("goal.outcome_contract.mismatch", `objective metric "${objective.metric}" is not measured by the referenced contract (metric "${contract.metric}")`, {
          reason: "metric_not_measured",
          objective_metric: objective.metric,
          contract_metric: contract.metric,
        });
      }
      if (objective.direction !== contract.direction) {
        throw policyBlocked("goal.outcome_contract.mismatch", `objective direction "${objective.direction}" contradicts the referenced contract direction "${contract.direction}"`, {
          reason: "direction_contradiction",
          objective_direction: objective.direction,
          contract_direction: contract.direction,
        });
      }
    }

    const version = await this.nextVersionNumber(goal.id);
    const versionId = `goalv_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_goal_versions
                 (id, goal_id, version, status, objectives,
                  outcome_contract_id, outcome_contract_version, created_by_user_id)
               VALUES ($1, $2, $3, 'draft', $4::jsonb, $5, $6, $7)`,
        params: [
          versionId,
          goal.id,
          version,
          JSON.stringify(doc),
          contractVersion.contractId,
          input.outcomeContractVersion,
          input.actingPrincipal.userId,
        ],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("goal.version.duplicate", `version "${version}" already exists for this goal`, {
          reason: "duplicate_version",
          version,
        });
      }
      throw err;
    }
    this.logger.info("goals: version created (draft)", {
      goal_id: goal.id,
      goal_version: version,
      objective_count: doc.objectives.length,
      outcome_contract_id: contractVersion.contractId,
      outcome_contract_version: input.outcomeContractVersion,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireVersionRow(goal.id, version);
  }

  /**
   * Replace the objectives of a DRAFT version (never published). The
   * outcome-contract reference is immutable for the version's identity —
   * a different contract requires a NEW version.
   */
  async updateDraftVersion(input: UpdateDraftVersionInput): Promise<GoalVersion> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const goal = await this.getGoalRow(input.projectId, input.goalId);
    if (!goal) {
      throw notFound("goal.not_found", "the goal was not found in this project");
    }
    const existing = await this.getVersionRow(goal.id, input.version);
    if (!existing) {
      throw notFound("goal.version.not_found", `version "${input.version}" was not found`);
    }
    if (existing.status !== "draft") {
      throw policyBlocked("goal.version.immutable", `version "${input.version}" is ${existing.status} and cannot be modified — publish a NEW version instead`, {
        reason: "version_not_draft",
        version: input.version,
        status: existing.status,
      });
    }
    const doc = validateObjectives(input.objectives);
    // Re-validate semantic compatibility against the (fixed) contract.
    const contractVersion = await this.outcomes.getVersion(
      input.organizationId,
      input.projectId,
      existing.outcomeContractId,
      existing.outcomeContractVersion,
      input.actingPrincipal,
    );
    const contract = (contractVersion?.content ?? null) as OutcomeContractDocument | null;
    if (contract) {
      for (const objective of doc.objectives) {
        if (objective.metric !== contract.metric) {
          throw policyBlocked("goal.outcome_contract.mismatch", `objective metric "${objective.metric}" is not measured by the referenced contract (metric "${contract.metric}")`, {
            reason: "metric_not_measured",
          });
        }
        if (objective.direction !== contract.direction) {
          throw policyBlocked("goal.outcome_contract.mismatch", `objective direction "${objective.direction}" contradicts the referenced contract direction "${contract.direction}"`, {
            reason: "direction_contradiction",
          });
        }
      }
    }
    await this.db.exec({
      text: `UPDATE cp_goal_versions SET objectives = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      params: [JSON.stringify(doc), existing.id],
    });
    this.logger.info("goals: draft version updated", {
      goal_id: goal.id,
      goal_version: input.version,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireVersionRow(goal.id, input.version);
  }

  /**
   * Transition a goal version's lifecycle. Activation deprecates the
   * previous active version within one transaction; concurrent
   * activations resolve via the partial unique index (one winner).
   */
  async transitionVersion(input: TransitionGoalVersionInput): Promise<GoalVersion> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const goal = await this.getGoalRow(input.projectId, input.goalId);
    if (!goal) {
      throw notFound("goal.not_found", "the goal was not found in this project");
    }
    if (!isGoalVersionStatus(input.toStatus)) {
      throw policyBlocked("goal.validation", `unknown goal version status "${String(input.toStatus)}"`, {
        reason: "invalid_status",
      });
    }
    const existing = await this.getVersionRow(goal.id, input.version);
    if (!existing) {
      throw notFound("goal.version.not_found", `version "${input.version}" was not found`);
    }
    const allowed = GOAL_VERSION_LIFECYCLE.get(existing.status) ?? [];
    if (!allowed.includes(input.toStatus)) {
      throw policyBlocked("goal.transition.invalid", `goal version cannot transition from "${existing.status}" to "${input.toStatus}"`, {
        reason: "invalid_transition",
        from: existing.status,
        to: input.toStatus,
        allowed,
      });
    }
    if (input.toStatus === "active") {
      // VERSION INTEGRITY (defensive re-check at activation): the
      // referenced outcome-contract version must be immutable before a
      // goal version may become ACTIVE. Creation already rejects draft
      // references, so this gate should never fire for rows that passed
      // through createVersion() — it exists as defense in depth for
      // rows seeded by older code or written behind the service (direct
      // SQL), and it re-verifies the reference at the moment
      // immutability semantics actually bind. The contract lifecycle is
      // one-way (draft → active → deprecated → retired; a published
      // version can never return to draft), so a reference observed
      // non-draft here stays immutable forever — the check is sound
      // under concurrency.
      const referenced = await this.outcomes.getVersion(
        input.organizationId,
        input.projectId,
        existing.outcomeContractId,
        existing.outcomeContractVersion,
        input.actingPrincipal,
      );
      if (!referenced) {
        throw policyBlocked(
          "goal.outcome_contract.not_found",
          `the referenced outcome contract version no longer resolves in this project — the goal version cannot be activated`,
          {
            reason: "contract_version_not_found",
            stage: "activation",
            outcome_contract_id: existing.outcomeContractId,
            outcome_contract_version: existing.outcomeContractVersion,
          },
        );
      }
      if (referenced.status === "draft") {
        throw policyBlocked(
          "goal.outcome_contract.mutable",
          `outcome contract "${existing.outcomeContractId}" version "${existing.outcomeContractVersion}" is still draft and mutable — publish the contract version before activating this goal version`,
          {
            reason: "contract_version_mutable",
            stage: "activation",
            outcome_contract_id: existing.outcomeContractId,
            outcome_contract_version: existing.outcomeContractVersion,
          },
        );
      }
      try {
        await this.db.transaction(async (tx) => {
          await tx.exec({
            text: `UPDATE cp_goal_versions
                   SET status = 'deprecated', updated_at = NOW()
                   WHERE goal_id = $1 AND status = 'active'`,
            params: [goal.id],
          });
          await tx.exec({
            text: `UPDATE cp_goal_versions SET status = 'active', updated_at = NOW() WHERE id = $1`,
            params: [existing.id],
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw policyBlocked("goal.version.activation_conflict", "another version was activated concurrently; retry with the current state", {
            reason: "concurrent_activation",
            goal_id: goal.id,
          });
        }
        throw err;
      }
    } else {
      await this.db.exec({
        text: `UPDATE cp_goal_versions SET status = $1, updated_at = NOW() WHERE id = $2`,
        params: [input.toStatus, existing.id],
      });
    }
    this.logger.info("goals: version transitioned", {
      goal_id: goal.id,
      goal_version: input.version,
      from: existing.status,
      to: input.toStatus,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireVersionRow(goal.id, input.version);
  }

  async getVersion(
    organizationId: string,
    projectId: string,
    goalId: string,
    version: string,
    principal: Principal,
  ): Promise<GoalVersion | null> {
    await this.requireProjectScope(organizationId, projectId, principal);
    const goal = await this.getGoalRow(projectId, goalId);
    if (!goal) return null;
    return this.getVersionRow(goal.id, version);
  }

  async listVersions(
    organizationId: string,
    projectId: string,
    goalId: string,
    principal: Principal,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ versions: GoalVersion[]; nextCursor: string | null }> {
    await this.requireProjectScope(organizationId, projectId, principal);
    const goal = await this.getGoalRow(projectId, goalId);
    if (!goal) {
      throw notFound("goal.not_found", "the goal was not found in this project");
    }
    const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
    const where: string[] = [`goal_id = $1`];
    const params: unknown[] = [goal.id];
    if (opts.cursor) {
      params.push(opts.cursor);
      where.push(`id < $${params.length}`);
    }
    const rows = await this.db.query({
      text: `SELECT * FROM cp_goal_versions WHERE ${where.join(" AND ")}
             ORDER BY id DESC LIMIT ${limit + 1}`,
      params,
    });
    const all = rows.map((r) => mapVersion(r as VersionRow));
    const page = all.slice(0, limit);
    const nextCursor = all.length > limit ? page[page.length - 1]!.id : null;
    return { versions: page, nextCursor };
  }

  /** The ACTIVE version (the authoritative resolution primitive), or null. */
  async getActiveVersion(organizationId: string, projectId: string, goalId: string, principal: Principal): Promise<GoalVersion | null> {
    await this.requireProjectScope(organizationId, projectId, principal);
    const goal = await this.getGoalRow(projectId, goalId);
    if (!goal) return null;
    const rows = await this.db.query({
      text: `SELECT * FROM cp_goal_versions WHERE goal_id = $1 AND status = 'active' LIMIT 1`,
      params: [goal.id],
    });
    const row = rows[0];
    return row ? mapVersion(row as VersionRow) : null;
  }

  // ---- internal helpers ----------------------------------------------------------------------

  private async getGoalRow(projectId: string, goalId: string): Promise<Goal | null> {
    const rows = await this.db.query({
      text: `SELECT * FROM cp_goals WHERE id = $1 AND project_id = $2`,
      params: [goalId, projectId],
    });
    const row = rows[0];
    return row ? mapGoal(row as GoalRow) : null;
  }

  private async getVersionRow(goalInternalId: string, version: string): Promise<GoalVersion | null> {
    const rows = await this.db.query({
      text: `SELECT * FROM cp_goal_versions WHERE goal_id = $1 AND version = $2`,
      params: [goalInternalId, version],
    });
    const row = rows[0];
    return row ? mapVersion(row as VersionRow) : null;
  }

  private async requireVersionRow(goalInternalId: string, version: string): Promise<GoalVersion> {
    const v = await this.getVersionRow(goalInternalId, version);
    if (!v) {
      throw platformFailure("goal.readback.failed", "goal version operation succeeded but the row could not be read back");
    }
    return v;
  }

  private async nextVersionNumber(goalInternalId: string): Promise<string> {
    const rows = await this.db.query({
      text: `SELECT COALESCE(MAX(version::int), 0)::int AS max_v FROM cp_goal_versions WHERE goal_id = $1`,
      params: [goalInternalId],
    });
    const maxV = Number((rows[0] as { max_v: number | string }).max_v ?? 0);
    return String(maxV + 1);
  }
}

// ---- Row mappers ------------------------------------------------------------------------------

interface GoalRow extends DbQueryResultRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapGoal(row: GoalRow): Goal {
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
  goal_id: string;
  version: string;
  status: string;
  objectives: unknown;
  outcome_contract_id: string;
  outcome_contract_version: string;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapVersion(row: VersionRow): GoalVersion {
  const doc = row.objectives as ObjectivesDocument | null;
  const objectives: GoalObjective[] =
    doc && typeof doc === "object" && Array.isArray((doc as ObjectivesDocument).objectives)
      ? (doc as ObjectivesDocument).objectives
      : [];
  return {
    id: row.id,
    goalId: row.goal_id,
    version: row.version,
    status: row.status as GoalVersionStatus,
    objectives,
    outcomeContractId: row.outcome_contract_id,
    outcomeContractVersion: row.outcome_contract_version,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ---- Error helpers --------------------------------------------------------------------------------

function policyBlocked(code: string, message: string, details?: Record<string, unknown>): AppError {
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
