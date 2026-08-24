// /projects/internal/service.ts
// ProjectsService — the /projects module's concrete service (architecture
// §34, §36, §2.16, §23, lock §1, §8, §10, WORK-004). Owns:
//   - project identity (cp_projects table) under an organization
//   - project lifecycle: create / read (get + list, paginated) / update /
//     archive (soft-delete via status='archived')
//   - project-level tenant scoping: resolveProjectContext verifies a project
//     belongs to the AUTHORIZED organization id resolved by /organizations
//     — the :projectId in a request is only a REQUESTED TARGET; the
//     server-side check (project.organization_id === authorizedOrgId) is
//     what grants access. A caller who reaches into another org's project
//     id fails here (POLICY_BLOCKED / not-found), even with a valid org
//     membership in their own org.
//   - role-gated mutations: create requires an active org membership;
//     update requires admin/owner; archive requires owner. The role is read
//     from the acting Principal's org membership via @cp/auth's
//     activeMembershipIn (no /organizations import — keeps the dependency
//     one-way: /projects → @cp/auth + @cp/platform only).
//
// PostgreSQL is authoritative for project state. The service depends ONLY
// on the provider-neutral platform `Database` interface — `pg` is isolated
// to /platform internals (architecture §9, lock §7, WORK-004 §modules).
//
// Invariants (WORK-004):
//   - a project belongs to exactly one organization (DB FK + NOT NULL)
//   - project slug is unique within an organization (DB UNIQUE index on
//     (organization_id, lower(slug))) — race-safe; concurrent duplicate
//     creates fail with a structured error, never silently create a dup
//   - cross-org project id substitution cannot leak a row: every read
//     filters by (id, organization_id) together
//   - archived projects are retained (soft-delete) and are excluded from
//     the default list view but remain addressable for audit

import {
  AppError,
  type Database,
  type DbQueryResultRow,
  ulid,
  isUlid,
  Logger,
  type LogSink,
  type LogRecord,
} from "@cp/platform";
import {
  type Principal,
  type Role,
  activeMembershipIn,
} from "@cp/auth";

// ---- Record types ------------------------------------------------------

export type ProjectStatus = "active" | "archived";

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The authorized project tenant context. Constructed by resolveProjectContext
 * after the acting principal's ACTIVE org membership has been verified
 * (by /organizations.resolveOrgContext, in the /api orgContextMiddleware)
 * AND the project has been verified to belong to that authorized org. The
 * projectId/organizationId here are the AUTHORIZED ones — downstream
 * operations must use them, never the raw request path params.
 */
export interface ProjectContext {
  projectId: string;
  organizationId: string;
  project: Project;
}

// ---- Inputs ------------------------------------------------------------

export interface CreateProjectInput {
  organizationId: string;
  name: string;
  slug: string;
  createdByUserId: string;
  actingPrincipal: Principal;
}

export interface UpdateProjectInput {
  organizationId: string;
  projectId: string;
  name?: string;
  slug?: string;
  actingPrincipal: Principal;
}

export interface ArchiveProjectInput {
  organizationId: string;
  projectId: string;
  actingPrincipal: Principal;
}

export interface ListProjectsOptions {
  /** Max items per page. Default 50, clamped to [1, 100]. */
  limit?: number;
  /** Opaque cursor (a ULID) returned by a previous page's next_cursor. */
  cursor?: string;
  /** Include archived projects (default false). */
  includeArchived?: boolean;
}

export interface ProjectPage {
  projects: Project[];
  page: {
    /** Cursor for the next page, or null if this is the last page. */
    next_cursor: string | null;
    has_more: boolean;
    limit: number;
  };
}

// ---- Row mappers -------------------------------------------------------

interface ProjectRow extends DbQueryResultRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  status: string;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapProject(r: ProjectRow): Project {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    name: r.name as string,
    slug: r.slug as string,
    status: r.status === "archived" ? "archived" : "active",
    createdByUserId: r.created_by_user_id as string,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

// ---- Errors ------------------------------------------------------------

function policyBlocked(message: string, details?: Record<string, unknown>): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "project.policy",
    message,
    retryable: false,
    details,
  });
}

/**
 * A project that does not belong to the authorized org is returned as
 * POLICY_BLOCKED (not a 404) to avoid leaking the existence of projects in
 * orgs the caller has no membership in (WORK-003 §12 anti-enumeration
 * principle, applied to the project boundary in WORK-004).
 */
function projectNotFound(message: string, details?: Record<string, unknown>): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "project.not_found",
    message,
    retryable: false,
    details,
  });
}

function platformFailure(message: string, cause?: unknown): AppError {
  return new AppError({
    category: "PLATFORM_FAILURE",
    code: "project.platform",
    message,
    retryable: false,
    cause,
  });
}

/**
 * Detect a PostgreSQL unique_violation (SQLSTATE 23505) across the platform's
 * normalized AppError wrapper (mirrors /organizations.isUniqueViolation).
 * Used to map duplicate (org, slug) inserts to a structured domain failure.
 */
function isUniqueViolation(err: unknown): boolean {
  if (err instanceof AppError) {
    const dc = err.details?.driverCode;
    if (dc === "23505") return true;
    const causeCode = (err.causeValue as { code?: string } | undefined)?.code;
    if (causeCode === "23505") return true;
    return false;
  }
  const rawCode = (err as { code?: string } | undefined)?.code;
  return rawCode === "23505";
}

// ---- Service -----------------------------------------------------------

export interface ProjectsServiceOptions {
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

export class ProjectsService {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(opts: ProjectsServiceOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
  }

  // ---- Project CRUD --------------------------------------------------

  /**
   * Create a project within an organization. Requires the acting principal
   * to have an ACTIVE membership in the target organization (any role —
   * owner/admin/member may create projects). The (organization_id, slug)
   * uniqueness is enforced by the DB; a duplicate slug in the same org
   * fails with a structured POLICY_BLOCKED, never silently creates a dup.
   *
   * `organizationId` MUST be the AUTHORIZED org id (resolved by
   * /organizations.resolveOrgContext in the /api orgContextMiddleware), not
   * a raw request path param.
   */
  async createProject(input: CreateProjectInput): Promise<Project> {
    // Verify the acting principal is an active member of the target org.
    // This is a server-side check — the caller's claim to act in this org
    // must be backed by an authenticated active membership.
    const membership = activeMembershipIn(
      input.actingPrincipal,
      input.organizationId,
    );
    if (!membership) {
      throw policyBlocked("no active membership in this organization", {
        reason: "not_a_member",
        organization_id: input.organizationId,
      });
    }
    if (typeof input.createdByUserId !== "string" || input.createdByUserId.length === 0) {
      throw platformFailure("createProject: createdByUserId required");
    }
    const name = (typeof input.name === "string" ? input.name : "").trim();
    if (name.length === 0) {
      throw policyBlocked("project name is required", { reason: "missing_name" });
    }
    const slug = normalizeSlug(input.slug);
    if (!isValidSlug(slug)) {
      throw policyBlocked("project slug is not valid", { reason: "malformed_slug" });
    }
    const projectId = `proj_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_projects
                 (id, organization_id, name, slug, status, created_by_user_id)
               VALUES ($1, $2, $3, $4, 'active', $5)`,
        params: [projectId, input.organizationId, name, slug, input.createdByUserId],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("a project with this slug already exists in this organization", {
          reason: "duplicate_slug",
        });
      }
      throw platformFailure("createProject failed", err);
    }
    const created = await this.getProject(input.organizationId, projectId);
    if (!created) {
      // Should be impossible after a successful insert; treat as platform.
      throw platformFailure("createProject: project disappeared after insert");
    }
    this.logger.info("projects: created", {
      project_id: projectId,
      organization_id: input.organizationId,
      created_by_user_id: input.createdByUserId,
    });
    return created;
  }

  /**
   * Get a project by id, scoped to the given organization. Returns null if
   * the project does not exist OR does not belong to this organization —
   * both cases are indistinguishable to the caller (cross-org project id
   * substitution yields null, not a leaked row).
   */
  async getProject(
    organizationId: string,
    projectId: string,
  ): Promise<Project | null> {
    const rows = await this.db.query({
      text: `SELECT id, organization_id, name, slug, status, created_by_user_id,
                created_at, updated_at
             FROM cp_projects
             WHERE id = $1 AND organization_id = $2`,
      params: [projectId, organizationId],
    });
    const row = rows[0];
    return row ? mapProject(row as ProjectRow) : null;
  }

  async getProjectBySlug(
    organizationId: string,
    slug: string,
  ): Promise<Project | null> {
    const rows = await this.db.query({
      text: `SELECT id, organization_id, name, slug, status, created_by_user_id,
                created_at, updated_at
             FROM cp_projects
             WHERE organization_id = $1 AND lower(slug) = lower($2)`,
      params: [organizationId, normalizeSlug(slug)],
    });
    const row = rows[0];
    return row ? mapProject(row as ProjectRow) : null;
  }

  /**
   * List projects in an organization, newest-first, with cursor pagination.
   * The cursor is a project id (ULID — time-monotonic, lexicographically
   * sortable), so ordering by id DESC is a stable newest-first ordering and
   * `id < cursor` advances without skipping or duplicating rows under
   * concurrent inserts.
   *
   * Archived projects are excluded by default; set includeArchived=true to
   * include them.
   */
  async listProjects(
    organizationId: string,
    opts: ListProjectsOptions = {},
  ): Promise<ProjectPage> {
    const limit = clampLimit(opts.limit);
    const includeArchived = opts.includeArchived === true;
    // Fetch limit+1 to determine has_more without a separate COUNT query.
    const fetchN = limit + 1;
    let text: string;
    let params: unknown[];
    if (opts.cursor && isUlid(opts.cursor.replace(/^proj_/, ""))) {
      const cursorId = opts.cursor.startsWith("proj_") ? opts.cursor : `proj_${opts.cursor}`;
      if (includeArchived) {
        text = `SELECT id, organization_id, name, slug, status, created_by_user_id,
                  created_at, updated_at
               FROM cp_projects
               WHERE organization_id = $1 AND id < $2
               ORDER BY id DESC
               LIMIT $3`;
        params = [organizationId, cursorId, fetchN];
      } else {
        text = `SELECT id, organization_id, name, slug, status, created_by_user_id,
                  created_at, updated_at
               FROM cp_projects
               WHERE organization_id = $1 AND id < $2 AND status = 'active'
               ORDER BY id DESC
               LIMIT $3`;
        params = [organizationId, cursorId, fetchN];
      }
    } else {
      if (includeArchived) {
        text = `SELECT id, organization_id, name, slug, status, created_by_user_id,
                  created_at, updated_at
               FROM cp_projects
               WHERE organization_id = $1
               ORDER BY id DESC
               LIMIT $2`;
        params = [organizationId, fetchN];
      } else {
        text = `SELECT id, organization_id, name, slug, status, created_by_user_id,
                  created_at, updated_at
               FROM cp_projects
               WHERE organization_id = $1 AND status = 'active'
               ORDER BY id DESC
               LIMIT $2`;
        params = [organizationId, fetchN];
      }
    }
    const rows = await this.db.query({ text, params });
    const all = rows.map((r) => mapProject(r as ProjectRow));
    const hasMore = all.length > limit;
    const page = all.slice(0, limit);
    const last = page[page.length - 1];
    return {
      projects: page,
      page: {
        next_cursor: hasMore && last ? last.id : null,
        has_more: hasMore,
        limit,
      },
    };
  }

  /**
   * Update a project's name and/or slug. Requires the acting principal to
   * be an admin or owner of the organization. Cross-org authority does not
   * transfer (the role is read from the principal's membership in THIS org).
   * A duplicate slug in the same org fails with a structured error.
   */
  async updateProject(input: UpdateProjectInput): Promise<Project> {
    const membership = activeMembershipIn(
      input.actingPrincipal,
      input.organizationId,
    );
    if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
      throw policyBlocked("admin or owner role is required to update a project", {
        reason: "insufficient_role",
        required_roles: ["admin", "owner"],
        organization_id: input.organizationId,
      });
    }
    const existing = await this.getProject(input.organizationId, input.projectId);
    if (!existing) {
      throw projectNotFound("project not found", { reason: "no_such_project" });
    }
    const newName =
      typeof input.name === "string" && input.name.trim().length > 0
        ? input.name.trim()
        : existing.name;
    const newSlug =
      typeof input.slug === "string" && input.slug.trim().length > 0
        ? normalizeSlug(input.slug)
        : existing.slug;
    if (!isValidSlug(newSlug)) {
      throw policyBlocked("project slug is not valid", { reason: "malformed_slug" });
    }
    try {
      await this.db.exec({
        text: `UPDATE cp_projects
               SET name = $1, slug = $2, updated_at = NOW()
               WHERE id = $3 AND organization_id = $4`,
        params: [newName, newSlug, input.projectId, input.organizationId],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("a project with this slug already exists in this organization", {
          reason: "duplicate_slug",
        });
      }
      throw platformFailure("updateProject failed", err);
    }
    const updated = await this.getProject(input.organizationId, input.projectId);
    if (!updated) throw platformFailure("updateProject: project disappeared");
    this.logger.info("projects: updated", {
      project_id: input.projectId,
      organization_id: input.organizationId,
    });
    return updated;
  }

  /**
   * Archive a project (soft-delete: status='archived'). Requires the acting
   * principal to be an OWNER of the organization (destructive operation).
   * An archived project is retained for audit and remains addressable, but
   * is excluded from the default list view.
   */
  async archiveProject(input: ArchiveProjectInput): Promise<Project> {
    const membership = activeMembershipIn(
      input.actingPrincipal,
      input.organizationId,
    );
    if (!membership || membership.role !== "owner") {
      throw policyBlocked("owner role is required to archive a project", {
        reason: "insufficient_role",
        required_roles: ["owner"],
        organization_id: input.organizationId,
      });
    }
    const existing = await this.getProject(input.organizationId, input.projectId);
    if (!existing) {
      throw projectNotFound("project not found", { reason: "no_such_project" });
    }
    if (existing.status === "archived") {
      // Idempotent: archiving an already-archived project is a no-op.
      return existing;
    }
    await this.db.exec({
      text: `UPDATE cp_projects SET status = 'archived', updated_at = NOW()
             WHERE id = $1 AND organization_id = $2`,
      params: [input.projectId, input.organizationId],
    });
    const archived = await this.getProject(input.organizationId, input.projectId);
    if (!archived) throw platformFailure("archiveProject: project disappeared");
    this.logger.info("projects: archived", {
      project_id: input.projectId,
      organization_id: input.organizationId,
    });
    return archived;
  }

  // ---- Project-level tenant context resolution ------------------------

  /**
   * The project-level tenant-scoping gate (WORK-004). Given the AUTHORIZED
   * organization id (already resolved by /organizations.resolveOrgContext)
   * and a REQUESTED project id, verify the project belongs to that
   * organization. Throws POLICY_BLOCKED (project.not_found) if not — the
   * existence of projects in orgs the caller has no membership in is never
   * leaked. The returned ProjectContext carries the AUTHORIZED
   * projectId/organizationId; downstream operations must use them, never
   * the raw path params.
   *
   * This is the project-level equivalent of /organizations.resolveOrgContext
   * (WORK-003 §7): the :projectId in a request is only a REQUESTED TARGET;
   * the server-side project-belongs-to-org check is what grants access.
   */
  async resolveProjectContext(
    organizationId: string,
    requestedProjectId: string,
  ): Promise<ProjectContext> {
    const project = await this.getProject(organizationId, requestedProjectId);
    if (!project) {
      throw projectNotFound("project not found in this organization", {
        reason: "no_such_project",
      });
    }
    return {
      projectId: project.id,
      organizationId: project.organizationId,
      project,
    };
  }
}

// ---- Helpers -----------------------------------------------------------

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function isValidSlug(slug: string): boolean {
  if (slug.length === 0 || slug.length > 63) return false;
  // Slug: lowercase letters, digits, hyphens; must start with a letter.
  return /^[a-z][a-z0-9-]*$/.test(slug);
}
