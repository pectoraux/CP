// /outcomes/internal/service.ts
// OutcomesService — the /outcomes module's concrete service (WORK-011,
// architecture §15, §36, lock §1; frozen GOAL-001..003 + OUT-001).
// Owns the versioned, immutable outcome CONTRACTS: the machine-readable
// measurement definitions (metric/unit/direction/aggregation/threshold/
// window/source) that goal versions reference and that WORK-015/016 will
// later consume.
//
// NOT implemented here (WORK-011 §28): outcome records, observation
// ingestion, outcome calculation — the contract DEFINES measurement
// semantics; it never executes them.
//
// Versioning/lifecycle (the WORK-005/008 precedents): draft → active →
// deprecated → retired; drafts replaceable; published versions
// IMMUTABLE (historical goal versions remain interpretable against the
// exact contract version they reference); at-most-one-active via a
// partial unique index; activation auto-deprecates the previous active
// version within one transaction; concurrent activation is race-safe
// (one winner, deterministic conflict).
//
// TENANCY (§3, §19): project-scoped; the (organizationId, projectId)
// pair is resolved by the /api org/project gates and re-verified here
// via the /projects PUBLIC interface + activeMembershipIn (defense in
// depth). Reads: any active member. Mutations: admin/owner. Cross-org/
// cross-project ids simply do not resolve.

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
import {
  validateOutcomeContractDocument,
  type OutcomeContractDocument,
} from "./contract.ts";

// ---- Lifecycle ----------------------------------------------------------------

export type OutcomeContractStatus = "draft" | "active" | "deprecated" | "retired";

export const OUTCOME_CONTRACT_STATUSES: readonly OutcomeContractStatus[] = [
  "draft",
  "active",
  "deprecated",
  "retired",
] as const;

export const OUTCOME_CONTRACT_LIFECYCLE: ReadonlyMap<
  OutcomeContractStatus,
  readonly OutcomeContractStatus[]
> = new Map([
  ["draft", ["active", "retired"]],
  ["active", ["deprecated", "retired"]],
  ["deprecated", ["retired"]],
  ["retired", []],
]);

export function isOutcomeContractStatus(v: string): v is OutcomeContractStatus {
  return (OUTCOME_CONTRACT_STATUSES as readonly string[]).includes(v);
}

// ---- Record types ----------------------------------------------------------------

/** SAFE representation — the validated contract document + metadata. */
export interface OutcomeContract {
  id: string; // oc_<ulid>
  projectId: string;
  name: string;
  description: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutcomeContractVersion {
  id: string; // ocv_<ulid>
  contractId: string; // internal oc_<ulid>
  version: string; // "1", "2", ...
  status: OutcomeContractStatus;
  content: OutcomeContractDocument;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Inputs -----------------------------------------------------------------------

export interface CreateOutcomeContractInput {
  organizationId: string;
  projectId: string;
  name: string;
  description?: string;
  /** Raw contract content (validated by validateOutcomeContractDocument). */
  content: unknown;
  actingPrincipal: Principal;
}

export interface UpdateDraftContentInput {
  organizationId: string;
  projectId: string;
  contractId: string;
  version: string;
  content: unknown;
  actingPrincipal: Principal;
}

export interface TransitionContractVersionInput {
  organizationId: string;
  projectId: string;
  contractId: string;
  version: string;
  toStatus: OutcomeContractStatus;
  actingPrincipal: Principal;
}

export interface ListOutcomeContractsOptions {
  limit?: number;
  cursor?: string | null;
  includeRetired?: boolean;
}

export interface OutcomeContractPage {
  contracts: OutcomeContract[];
  nextCursor: string | null;
}

export interface OutcomeContractServiceOptions {
  db: Database;
  logger?: Logger;
  projects: ProjectsService;
}

const NOOP_SINK: LogSink = {
  emit(_record: LogRecord): void {},
};

const MAX_NAME_LEN = 200;
const MAX_DESCRIPTION_LEN = 2000;

// ---- Service ------------------------------------------------------------------------

export class OutcomesService {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly projects: ProjectsService;

  constructor(opts: OutcomeContractServiceOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
    this.projects = opts.projects;
  }

  // ---- Tenancy + authorization (§19) --------------------------------------------

  private async requireProjectScope(
    organizationId: string,
    projectId: string,
    principal: Principal,
    opts: { requireAdmin?: boolean } = {},
  ): Promise<void> {
    const membership = activeMembershipIn(principal, organizationId);
    if (!membership) {
      throw policyBlocked("outcome.membership.required", "an active membership in this organization is required", {
        reason: "not_a_member",
        organization_id: organizationId,
      });
    }
    if (opts.requireAdmin && membership.role !== "admin" && membership.role !== "owner") {
      throw policyBlocked("outcome.role.required", "the admin or owner role is required to mutate outcome contracts", {
        reason: "insufficient_role",
        required_roles: ["admin", "owner"],
        actual_role: membership.role,
      });
    }
    const project = await this.projects.getProject(organizationId, projectId);
    if (!project) {
      throw notFound("outcome.project.not_found", "the project does not exist in this organization", {
        project_id: projectId,
      });
    }
  }

  // ---- Contract CRUD + versions ---------------------------------------------------

  /**
   * Create a project-scoped outcome contract with its first DRAFT version
   * (validated content). The contract is reusable across goals within the
   * project — the canonical place for a measurement definition.
   */
  async createContract(input: CreateOutcomeContractInput): Promise<OutcomeContractVersion> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const name = (typeof input.name === "string" ? input.name : "").trim();
    if (name.length === 0) {
      throw policyBlocked("outcome.validation", "contract name is required", { reason: "missing_name" });
    }
    if (name.length > MAX_NAME_LEN) {
      throw policyBlocked("outcome.validation", `contract name may be at most ${MAX_NAME_LEN} characters`, {
        reason: "name_too_long",
      });
    }
    const description =
      typeof input.description === "string" ? input.description.trim().slice(0, MAX_DESCRIPTION_LEN) : "";
    const doc = validateOutcomeContractDocument(input.content);

    const contractId = `oc_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_outcome_contracts (id, project_id, name, description, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5)`,
        params: [contractId, input.projectId, name, description, input.actingPrincipal.userId],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("outcome.contract.duplicate", "an outcome contract with this name already exists in this project", {
          reason: "duplicate_name",
        });
      }
      throw err;
    }
    // First version: DRAFT.
    const versionId = `ocv_${ulid()}`;
    await this.db.exec({
      text: `INSERT INTO cp_outcome_contract_versions (id, contract_id, version, status, content, created_by_user_id)
             VALUES ($1, $2, '1', 'draft', $3::jsonb, $4)`,
      params: [versionId, contractId, JSON.stringify(doc), input.actingPrincipal.userId],
    });
    this.logger.info("outcomes: contract created (draft v1)", {
      contract_id: contractId,
      metric: doc.metric,
      direction: doc.direction,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireVersionRow(input.projectId, contractId, "1");
  }

  async getContract(organizationId: string, projectId: string, contractId: string, principal: Principal): Promise<OutcomeContract | null> {
    await this.requireProjectScope(organizationId, projectId, principal);
    return this.getContractRow(projectId, contractId);
  }

  async listContracts(
    organizationId: string,
    projectId: string,
    principal: Principal,
    opts: ListOutcomeContractsOptions = {},
  ): Promise<OutcomeContractPage> {
    await this.requireProjectScope(organizationId, projectId, principal);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: string[] = [`project_id = $1`];
    const params: unknown[] = [projectId];
    if (!opts.includeRetired) {
      // Hide fully-retired contracts (all versions retired — same shape
      // as the policies listing convention).
      where.push(
        `NOT (
           EXISTS (SELECT 1 FROM cp_outcome_contract_versions v WHERE v.contract_id = cp_outcome_contracts.id)
           AND NOT EXISTS (SELECT 1 FROM cp_outcome_contract_versions v WHERE v.contract_id = cp_outcome_contracts.id AND v.status <> 'retired')
         )`,
      );
    }
    if (opts.cursor) {
      params.push(opts.cursor);
      where.push(`id < $${params.length}`);
    }
    const rows = await this.db.query({
      text: `SELECT * FROM cp_outcome_contracts WHERE ${where.join(" AND ")}
             ORDER BY id DESC LIMIT ${limit + 1}`,
      params,
    });
    const all = rows.map((r) => mapContract(r as ContractRow));
    const page = all.slice(0, limit);
    const nextCursor = all.length > limit ? page[page.length - 1]!.id : null;
    return { contracts: page, nextCursor };
  }

  /**
   * Create a new DRAFT version with validated content. Semantic changes
   * NEVER overwrite published versions — a new version is the only path.
   */
  async createVersion(input: {
    organizationId: string;
    projectId: string;
    contractId: string;
    content: unknown;
    actingPrincipal: Principal;
  }): Promise<OutcomeContractVersion> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const contract = await this.getContractRow(input.projectId, input.contractId);
    if (!contract) {
      throw notFound("outcome.contract.not_found", "the outcome contract was not found in this project");
    }
    const doc = validateOutcomeContractDocument(input.content);
    const version = await this.nextVersionNumber(contract.id);
    const versionId = `ocv_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_outcome_contract_versions (id, contract_id, version, status, content, created_by_user_id)
               VALUES ($1, $2, $3, 'draft', $4::jsonb, $5)`,
        params: [versionId, contract.id, version, JSON.stringify(doc), input.actingPrincipal.userId],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("outcome.contract.version.duplicate", `version "${version}" already exists for this contract`, {
          reason: "duplicate_version",
          version,
        });
      }
      throw err;
    }
    this.logger.info("outcomes: contract version created (draft)", {
      contract_id: contract.id,
      contract_version: version,
      metric: doc.metric,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireVersionRow(input.projectId, contract.id, version);
  }

  /**
   * Replace the content of a DRAFT version (never published). Published
   * versions are IMMUTABLE — historical goal versions stay interpretable
   * against the exact contract version they reference.
   */
  async updateDraftContent(input: UpdateDraftContentInput): Promise<OutcomeContractVersion> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const contract = await this.getContractRow(input.projectId, input.contractId);
    if (!contract) {
      throw notFound("outcome.contract.not_found", "the outcome contract was not found in this project");
    }
    const existing = await this.getVersionRow(contract.id, input.version);
    if (!existing) {
      throw notFound("outcome.contract.version.not_found", `version "${input.version}" was not found`);
    }
    if (existing.status !== "draft") {
      throw policyBlocked("outcome.contract.version.immutable", `version "${input.version}" is ${existing.status} and cannot be modified — publish a NEW version instead`, {
        reason: "version_not_draft",
        version: input.version,
        status: existing.status,
      });
    }
    const doc = validateOutcomeContractDocument(input.content);
    await this.db.exec({
      text: `UPDATE cp_outcome_contract_versions SET content = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      params: [JSON.stringify(doc), existing.id],
    });
    this.logger.info("outcomes: draft contract version updated", {
      contract_id: contract.id,
      contract_version: input.version,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireVersionRow(input.projectId, contract.id, input.version);
  }

  /**
   * Transition a contract version's lifecycle. Activation deprecates the
   * previous active version within one transaction; concurrent
   * activations resolve via the partial unique index (one winner).
   */
  async transitionVersion(input: TransitionContractVersionInput): Promise<OutcomeContractVersion> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const contract = await this.getContractRow(input.projectId, input.contractId);
    if (!contract) {
      throw notFound("outcome.contract.not_found", "the outcome contract was not found in this project");
    }
    if (!isOutcomeContractStatus(input.toStatus)) {
      throw policyBlocked("outcome.validation", `unknown contract status "${String(input.toStatus)}"`, {
        reason: "invalid_status",
      });
    }
    const existing = await this.getVersionRow(contract.id, input.version);
    if (!existing) {
      throw notFound("outcome.contract.version.not_found", `version "${input.version}" was not found`);
    }
    const allowed = OUTCOME_CONTRACT_LIFECYCLE.get(existing.status) ?? [];
    if (!allowed.includes(input.toStatus)) {
      throw policyBlocked("outcome.contract.transition.invalid", `contract version cannot transition from "${existing.status}" to "${input.toStatus}"`, {
        reason: "invalid_transition",
        from: existing.status,
        to: input.toStatus,
        allowed,
      });
    }
    if (input.toStatus === "active") {
      try {
        await this.db.transaction(async (tx) => {
          await tx.exec({
            text: `UPDATE cp_outcome_contract_versions
                   SET status = 'deprecated', updated_at = NOW()
                   WHERE contract_id = $1 AND status = 'active'`,
            params: [contract.id],
          });
          await tx.exec({
            text: `UPDATE cp_outcome_contract_versions
                   SET status = 'active', updated_at = NOW()
                   WHERE id = $1`,
            params: [existing.id],
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw policyBlocked("outcome.contract.activation_conflict", "another version was activated concurrently; retry with the current state", {
            reason: "concurrent_activation",
            contract_id: contract.id,
          });
        }
        throw err;
      }
    } else {
      await this.db.exec({
        text: `UPDATE cp_outcome_contract_versions SET status = $1, updated_at = NOW() WHERE id = $2`,
        params: [input.toStatus, existing.id],
      });
    }
    this.logger.info("outcomes: contract version transitioned", {
      contract_id: contract.id,
      contract_version: input.version,
      from: existing.status,
      to: input.toStatus,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireVersionRow(input.projectId, contract.id, input.version);
  }

  async getVersion(
    organizationId: string,
    projectId: string,
    contractId: string,
    version: string,
    principal: Principal,
  ): Promise<OutcomeContractVersion | null> {
    await this.requireProjectScope(organizationId, projectId, principal);
    const contract = await this.getContractRow(projectId, contractId);
    if (!contract) return null;
    return this.getVersionRow(contract.id, version);
  }

  async listVersions(
    organizationId: string,
    projectId: string,
    contractId: string,
    principal: Principal,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ versions: OutcomeContractVersion[]; nextCursor: string | null }> {
    await this.requireProjectScope(organizationId, projectId, principal);
    const contract = await this.getContractRow(projectId, contractId);
    if (!contract) {
      throw notFound("outcome.contract.not_found", "the outcome contract was not found in this project");
    }
    const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
    const where: string[] = [`contract_id = $1`];
    const params: unknown[] = [contract.id];
    if (opts.cursor) {
      params.push(opts.cursor);
      where.push(`id < $${params.length}`);
    }
    const rows = await this.db.query({
      text: `SELECT * FROM cp_outcome_contract_versions WHERE ${where.join(" AND ")}
             ORDER BY id DESC LIMIT ${limit + 1}`,
      params,
    });
    const all = rows.map((r) => mapVersion(r as VersionRow));
    const page = all.slice(0, limit);
    const nextCursor = all.length > limit ? page[page.length - 1]!.id : null;
    return { versions: page, nextCursor };
  }

  /** The ACTIVE version (the authoritative resolution primitive), or null. */
  async getActiveVersion(projectId: string, contractId: string): Promise<OutcomeContractVersion | null> {
    const contract = await this.getContractRow(projectId, contractId);
    if (!contract) return null;
    const rows = await this.db.query({
      text: `SELECT * FROM cp_outcome_contract_versions WHERE contract_id = $1 AND status = 'active' LIMIT 1`,
      params: [contract.id],
    });
    const row = rows[0];
    return row ? mapVersion(row as VersionRow) : null;
  }

  // ---- internal helpers ----------------------------------------------------------

  private async getContractRow(projectId: string, contractId: string): Promise<OutcomeContract | null> {
    const rows = await this.db.query({
      text: `SELECT * FROM cp_outcome_contracts WHERE id = $1 AND project_id = $2`,
      params: [contractId, projectId],
    });
    const row = rows[0];
    return row ? mapContract(row as ContractRow) : null;
  }

  private async getVersionRow(contractInternalId: string, version: string): Promise<OutcomeContractVersion | null> {
    const rows = await this.db.query({
      text: `SELECT * FROM cp_outcome_contract_versions WHERE contract_id = $1 AND version = $2`,
      params: [contractInternalId, version],
    });
    const row = rows[0];
    return row ? mapVersion(row as VersionRow) : null;
  }

  private async requireVersionRow(projectId: string, contractInternalId: string, version: string): Promise<OutcomeContractVersion> {
    const v = await this.getVersionRow(contractInternalId, version);
    if (!v) {
      throw new AppError({
        category: "PLATFORM_FAILURE",
        code: "outcome.readback.failed",
        message: "contract version operation succeeded but the row could not be read back",
        retryable: false,
      });
    }
    void projectId;
    return v;
  }

  private async nextVersionNumber(contractInternalId: string): Promise<string> {
    const rows = await this.db.query({
      text: `SELECT COALESCE(MAX(version::int), 0)::int AS max_v FROM cp_outcome_contract_versions WHERE contract_id = $1`,
      params: [contractInternalId],
    });
    const maxV = Number((rows[0] as { max_v: number | string }).max_v ?? 0);
    return String(maxV + 1);
  }
}

// ---- Row mappers ----------------------------------------------------------------------

interface ContractRow extends DbQueryResultRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapContract(row: ContractRow): OutcomeContract {
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
  contract_id: string;
  version: string;
  status: string;
  content: unknown;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapVersion(row: VersionRow): OutcomeContractVersion {
  const doc = row.content as OutcomeContractDocument | null;
  return {
    id: row.id,
    contractId: row.contract_id,
    version: row.version,
    status: row.status as OutcomeContractStatus,
    content:
      doc && typeof doc === "object"
        ? doc
        : {
            schema: 1,
            metric: "business_success",
            unit: "count",
            direction: "maximize",
            aggregation: "count",
            threshold: 1,
            windowSeconds: 1,
            measurementSource: "execution_observation",
            required: true,
            description: "",
          },
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ---- Error helpers ----------------------------------------------------------------------

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
