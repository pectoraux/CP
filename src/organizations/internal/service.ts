// /organizations/internal/service.ts
// OrganizationsService — the /organizations module's concrete service
// (architecture §34, §36, §30, §2.16, lock §1, WORK-003 §5, §6, §7, §10,
// §15). Owns:
//   - organization identity (cp_organizations table)
//   - organization membership lifecycle (cp_organization_memberships):
//     add / invite / suspend / reinstate / remove / role-change
//   - role assignment (owner / admin / member)
//   - organization-level permission evaluation at the service boundary
//     (the API handler never re-implements role logic — WORK-003 §8)
//   - server-side tenant context resolution
//     (resolveOrgContext — the authoritative "which org may this caller
//     access" decision; the org_id in a request is only a REQUESTED TARGET
//     and must be backed by an authenticated ACTIVE membership)
//
// PostgreSQL is authoritative for organization state. Redis is never
// authoritative here. The service depends ONLY on the provider-neutral
// platform `Database` interface — `pg` is isolated to /platform internals
// (architecture §9, WORK-003 §9).
//
// Invariants (WORK-003 §6, §10):
//   - membership is unique per (org, user) — DB UNIQUE constraint + checked
//     by service; duplicate adds throw a structured error, never silent
//   - the last owner cannot be removed/demoted (org continuity)
//   - mutating operations require the acting principal to have the
//     appropriate permission in the SAME org the mutation targets
//     (server-side, never client-side)

import {
  AppError,
  type Database,
  type DbQueryResultRow,
  type DbTransaction,
  ulid,
  Logger,
  type LogSink,
  type LogRecord,
} from "@cp/platform";
import {
  type Principal,
  type OrgMembership,
  type Role,
  type MembershipStatus,
  hasPermission,
  buildPrincipal,
} from "@cp/auth";
import {
  ORG_PERMISSIONS,
  permissionsForRole,
} from "./permissions.ts";

// ---- Record types ------------------------------------------------------

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: "active" | "archived";
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The authorized tenant context. Constructed by resolveOrgContext after the
 * acting principal's ACTIVE membership in `organizationId` has been
 * verified server-side. This is the object downstream operations use to
 * scope tenant-owned data — the organizationId here is the AUTHORIZED one,
 * never the raw request path param.
 */
export interface OrgContext {
  organizationId: string;
  role: Role;
  principal: Principal;
}

// ---- Inputs ------------------------------------------------------------

export interface CreateOrganizationInput {
  ownerUserId: string;
  name: string;
  slug: string;
}

export interface AddMemberInput {
  organizationId: string;
  userId: string;
  role: Role;
  actingPrincipal: Principal;
}

export interface UpdateMembershipStateInput {
  organizationId: string;
  userId: string;
  status: MembershipStatus;
  actingPrincipal: Principal;
}

export interface UpdateRoleInput {
  organizationId: string;
  userId: string;
  role: Role;
  actingPrincipal: Principal;
}

export interface RemoveMemberInput {
  organizationId: string;
  userId: string;
  actingPrincipal: Principal;
}

// ---- Row mappers ------------------------------------------------------

interface OrgRow extends DbQueryResultRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MembershipRow extends DbQueryResultRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapOrg(r: OrgRow): Organization {
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    status: r.status === "archived" ? "archived" : "active",
    createdByUserId: r.created_by_user_id as string,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function mapMembership(r: MembershipRow): OrganizationMembership {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    userId: r.user_id as string,
    role: (r.role as Role) ?? "member",
    status: (r.status as MembershipStatus) ?? "active",
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function toRole(v: string): Role {
  if (v === "owner" || v === "admin" || v === "member") return v;
  throw new Error(`toRole: invalid role "${v}"`);
}

function toStatus(v: string): MembershipStatus {
  if (v === "active" || v === "invited" || v === "suspended" || v === "removed") {
    return v;
  }
  throw new Error(`toStatus: invalid status "${v}"`);
}

// ---- Errors ------------------------------------------------------------

function policyBlocked(message: string, details?: Record<string, unknown>): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "organization.policy",
    message,
    retryable: false,
    details,
  });
}

function notFound(message: string, details?: Record<string, unknown>): AppError {
  // Tenant-owned not-found is returned as POLICY_BLOCKED rather than 404 to
  // avoid leaking existence of orgs the caller has no membership in
  // (WORK-003 §12: do not expose whether a resource exists to a caller who
  // shouldn't know). Within an authorized context, a genuinely-missing
  // resource is a separate code path handled by the caller.
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "organization.not_found",
    message,
    retryable: false,
    details,
  });
}

function platformFailure(message: string, cause?: unknown): AppError {
  return new AppError({
    category: "PLATFORM_FAILURE",
    code: "organization.platform",
    message,
    retryable: false,
    cause,
  });
}

/**
 * Detect a PostgreSQL unique_violation (SQLSTATE 23505) across the
 * platform's normalized AppError wrapper. `normalizePgError` puts the
 * driver code in `details.driverCode`; the raw pg error (preserved as the
 * AppError's `causeValue`) also carries `code`. Used to map duplicate
 * (org, user) membership inserts and duplicate slug inserts to a
 * structured domain failure rather than a generic PLATFORM_FAILURE.
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

export interface OrganizationsServiceOptions {
  db: Database;
  logger?: Logger;
}

const NOOP_SINK: LogSink = { emit: (_r: LogRecord) => {} };

export class OrganizationsService {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(opts: OrganizationsServiceOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
  }

  // ---- Organization CRUD ---------------------------------------------

  /**
   * Create an organization and its initial OWNER membership in a single
   * transaction (WORK-003 §10). Either both succeed or both roll back — no
   * orphan organizations or memberships. The acting user becomes the
   * organization's first owner with an ACTIVE membership.
   */
  async createOrganizationWithOwner(
    input: CreateOrganizationInput,
  ): Promise<{ organization: Organization; ownerMembership: OrganizationMembership }> {
    if (typeof input.ownerUserId !== "string" || input.ownerUserId.length === 0) {
      throw platformFailure("createOrganizationWithOwner: ownerUserId required");
    }
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw policyBlocked("organization name is required", { reason: "missing_name" });
    }
    const slug = normalizeSlug(input.slug);
    if (!isValidSlug(slug)) {
      throw policyBlocked("organization slug is not valid", { reason: "malformed_slug" });
    }
    const orgId = `org_${ulid()}`;
    const mbrId = `mbr_${ulid()}`;

    try {
      const result = await this.db.transaction(async (tx) => {
        // Insert the organization.
        await tx.exec({
          text: `INSERT INTO cp_organizations
                  (id, name, slug, status, created_by_user_id)
                 VALUES ($1, $2, $3, 'active', $4)`,
          params: [orgId, input.name.trim(), slug, input.ownerUserId],
        });
        // Insert the initial owner membership.
        await tx.exec({
          text: `INSERT INTO cp_organization_memberships
                  (id, organization_id, user_id, role, status)
                 VALUES ($1, $2, $3, 'owner', 'active')`,
          params: [mbrId, orgId, input.ownerUserId],
        });
        // Read back the rows within the same transaction.
        const orgRows = await tx.query({
          text: `SELECT id, name, slug, status, created_by_user_id, created_at, updated_at
                 FROM cp_organizations WHERE id = $1`,
          params: [orgId],
        });
        const mbrRows = await tx.query({
          text: `SELECT id, organization_id, user_id, role, status, created_at, updated_at
                 FROM cp_organization_memberships WHERE id = $1`,
          params: [mbrId],
        });
        return {
          org: mapOrg(orgRows[0] as OrgRow),
          mbr: mapMembership(mbrRows[0] as MembershipRow),
        };
      });
      this.logger.info("organizations: created", {
        organization_id: orgId,
        owner_user_id: input.ownerUserId,
      });
      return { organization: result.org, ownerMembership: result.mbr };
    } catch (err) {
      // Re-throw domain-level AppErrors (input validation, etc.) as-is.
      // Only PLATFORM_FAILURE DB-wrapped errors fall through to the
      // unique-violation check below.
      if (err instanceof AppError && err.category !== "PLATFORM_FAILURE") throw err;
      if (isUniqueViolation(err)) {
        throw policyBlocked("an organization with this slug already exists", {
          reason: "duplicate_slug",
        });
      }
      throw platformFailure("createOrganizationWithOwner failed", err);
    }
  }

  async getOrganization(id: string): Promise<Organization | null> {
    const rows = await this.db.query({
      text: `SELECT id, name, slug, status, created_by_user_id, created_at, updated_at
             FROM cp_organizations WHERE id = $1`,
      params: [id],
    });
    const row = rows[0];
    return row ? mapOrg(row as OrgRow) : null;
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | null> {
    const rows = await this.db.query({
      text: `SELECT id, name, slug, status, created_by_user_id, created_at, updated_at
             FROM cp_organizations WHERE lower(slug) = lower($1)`,
      params: [normalizeSlug(slug)],
    });
    const row = rows[0];
    return row ? mapOrg(row as OrgRow) : null;
  }

  /**
   * List organizations the given user has any membership in (any status).
   * The API can filter to active memberships for the caller's own view.
   */
  async listOrganizationsForUser(userId: string): Promise<Organization[]> {
    const rows = await this.db.query({
      text: `SELECT o.id, o.name, o.slug, o.status, o.created_by_user_id,
                o.created_at, o.updated_at
             FROM cp_organizations o
             JOIN cp_organization_memberships m ON m.organization_id = o.id
             WHERE m.user_id = $1
             ORDER BY o.created_at DESC`,
      params: [userId],
    });
    return rows.map((r) => mapOrg(r as OrgRow));
  }

  // ---- Membership loading (for Principal construction) ----------------

  /**
   * Load all memberships for a user, with each membership's role resolved
   * to its full permission set. Returns the /auth-typed OrgMembership[]
   * used to build a Principal. The permission resolution happens here
   * (organizations owns the role→permission mapping); the Principal type
   * and hasPermission primitive live in /auth.
   */
  async getMemberships(userId: string): Promise<readonly OrgMembership[]> {
    const rows = await this.db.query({
      text: `SELECT id, organization_id, user_id, role, status, created_at, updated_at
             FROM cp_organization_memberships
             WHERE user_id = $1
             ORDER BY created_at ASC`,
      params: [userId],
    });
    return rows.map((r) => {
      const row = r as MembershipRow;
      const role = toRole(row.role as string);
      const status = toStatus(row.status as string);
      const memberships: OrgMembership = {
        organizationId: row.organization_id as string,
        role,
        status,
        permissions: permissionsForRole(role),
      };
      return memberships;
    });
  }

  /**
   * Convenience: build a full Principal for a user (verify identity in
   * /auth, load memberships here, assemble via /auth.buildPrincipal). The
   * API auth middleware uses this orchestration.
   */
  async buildPrincipalForUser(userId: string): Promise<Principal> {
    const memberships = await this.getMemberships(userId);
    return buildPrincipal(userId, memberships);
  }

  // ---- Tenant context resolution -------------------------------------

  /**
   * The server-side tenant-isolation gate (WORK-003 §7). Given a principal
   * and a REQUESTED organization id, verify the principal has an ACTIVE
   * membership in that organization. Throws POLICY_BLOCKED if not. The
   * returned OrgContext is the only object downstream operations may use
   * to scope tenant-owned data — its organizationId is the AUTHORIZED one.
   *
   * A caller who authenticates as User A in Org A and supplies Org B's id
   * fails here with POLICY_BLOCKED, even though User A's credential is
   * valid and Org B exists.
   *
   * Always re-loads from the authoritative store: the Principal's resolved
   * memberships may be stale (e.g. an admin just suspended this caller
   * after their Principal was built). A suspended/removed member must lose
   * access immediately, even with a valid long-lived credential
   * (WORK-003 §15). This is one DB query per tenant-scoped request —
   * correctness over micro-optimization.
   */
  async resolveOrgContext(
    principal: Principal,
    requestedOrgId: string,
  ): Promise<OrgContext> {
    const fresh = await this.getMemberships(principal.userId);
    const m = fresh.find((x) => x.organizationId === requestedOrgId);
    if (!m) {
      throw policyBlocked("no membership in this organization", {
        reason: "not_a_member",
      });
    }
    if (m.status !== "active") {
      throw policyBlocked("membership is not active", {
        reason: `membership_${m.status}`,
      });
    }
    // Return a refreshed principal (latest memberships) so downstream
    // hasPermission() checks use the fresh state.
    const refreshed = buildPrincipal(principal.userId, fresh);
    return {
      organizationId: m.organizationId,
      role: m.role,
      principal: refreshed,
    };
  }

  // ---- Membership lifecycle ------------------------------------------

  /**
   * Add a member to an organization. Requires the acting principal to have
   * organization.member.invite in the SAME org. The (org, user) uniqueness
   * is enforced by the DB constraint — a duplicate add fails with a
   * structured error, never silently creates a duplicate.
   */
  async addMember(input: AddMemberInput): Promise<OrganizationMembership> {
    this.requirePermission(
      input.actingPrincipal,
      ORG_PERMISSIONS.MEMBER_INVITE,
      input.organizationId,
    );
    const role = input.role;
    const mbrId = `mbr_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_organization_memberships
                (id, organization_id, user_id, role, status)
               VALUES ($1, $2, $3, $4, 'active')`,
        params: [mbrId, input.organizationId, input.userId, role],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("user is already a member of this organization", {
          reason: "duplicate_membership",
        });
      }
      throw platformFailure("addMember failed", err);
    }
    const rows = await this.db.query({
      text: `SELECT id, organization_id, user_id, role, status, created_at, updated_at
             FROM cp_organization_memberships WHERE id = $1`,
      params: [mbrId],
    });
    if (!rows[0]) throw platformFailure("addMember: membership disappeared");
    this.logger.info("organizations: member added", {
      organization_id: input.organizationId,
      user_id: input.userId,
      role,
    });
    return mapMembership(rows[0] as MembershipRow);
  }

  /**
   * Change a membership's status (active/invited/suspended/removed).
   * Requires organization.member.manage in the same org. The last owner
   * cannot be removed or suspended (org continuity).
   */
  async updateMembershipState(
    input: UpdateMembershipStateInput,
  ): Promise<OrganizationMembership> {
    this.requirePermission(
      input.actingPrincipal,
      ORG_PERMISSIONS.MEMBER_MANAGE,
      input.organizationId,
    );
    const target = await this.findMembership(input.organizationId, input.userId);
    if (!target) {
      throw notFound("membership not found", { reason: "no_such_membership" });
    }
    // Org continuity: cannot suspend/remove the last owner.
    if (
      target.role === "owner" &&
      (input.status === "suspended" || input.status === "removed")
    ) {
      const ownerCount = await this.countActiveOwners(input.organizationId);
      if (ownerCount <= 1) {
        throw policyBlocked("cannot remove the last owner of the organization", {
          reason: "last_owner",
        });
      }
    }
    await this.db.exec({
      text: `UPDATE cp_organization_memberships
             SET status = $1, updated_at = NOW()
             WHERE id = $2`,
      params: [input.status, target.id],
    });
    this.logger.info("organizations: membership state changed", {
      organization_id: input.organizationId,
      user_id: input.userId,
      new_status: input.status,
    });
    return (await this.findMembership(input.organizationId, input.userId))!;
  }

  /**
   * Change a member's role. Requires organization.member.manage in the
   * same org. Cannot demote the last owner.
   */
  async updateRole(input: UpdateRoleInput): Promise<OrganizationMembership> {
    this.requirePermission(
      input.actingPrincipal,
      ORG_PERMISSIONS.MEMBER_MANAGE,
      input.organizationId,
    );
    const target = await this.findMembership(input.organizationId, input.userId);
    if (!target) {
      throw notFound("membership not found", { reason: "no_such_membership" });
    }
    if (target.role === "owner" && input.role !== "owner") {
      const ownerCount = await this.countActiveOwners(input.organizationId);
      if (ownerCount <= 1) {
        throw policyBlocked("cannot demote the last owner of the organization", {
          reason: "last_owner",
        });
      }
    }
    await this.db.exec({
      text: `UPDATE cp_organization_memberships
             SET role = $1, updated_at = NOW()
             WHERE id = $2`,
      params: [input.role, target.id],
    });
    this.logger.info("organizations: role changed", {
      organization_id: input.organizationId,
      user_id: input.userId,
      new_role: input.role,
    });
    return (await this.findMembership(input.organizationId, input.userId))!;
  }

  /**
   * Soft-delete a membership (set status=removed). Requires
   * organization.member.manage. Cannot remove the last owner.
   * A removed member immediately loses access (resolveOrgContext rejects
   * removed status).
   */
  async removeMember(input: RemoveMemberInput): Promise<void> {
    // Reuse updateMembershipState with status=removed, which enforces the
    // last-owner invariant and the permission check.
    await this.updateMembershipState({
      organizationId: input.organizationId,
      userId: input.userId,
      status: "removed",
      actingPrincipal: input.actingPrincipal,
    });
  }

  /**
   * List the members of an organization. Requires
   * organization.member.list in the same org.
   */
  async listMembers(
    organizationId: string,
    actingPrincipal: Principal,
  ): Promise<OrganizationMembership[]> {
    this.requirePermission(
      actingPrincipal,
      ORG_PERMISSIONS.MEMBER_LIST,
      organizationId,
    );
    const rows = await this.db.query({
      text: `SELECT id, organization_id, user_id, role, status, created_at, updated_at
             FROM cp_organization_memberships
             WHERE organization_id = $1
             ORDER BY created_at ASC`,
      params: [organizationId],
    });
    return rows.map((r) => mapMembership(r as MembershipRow));
  }

  /**
   * Count the active owners of an organization. Used to enforce the
   * last-owner invariant.
   */
  async countActiveOwners(organizationId: string): Promise<number> {
    const rows = await this.db.query({
      text: `SELECT COUNT(*)::int AS n
             FROM cp_organization_memberships
             WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`,
      params: [organizationId],
    });
    const n = rows[0]?.n as number | undefined;
    return typeof n === "number" ? n : 0;
  }

  // ---- Internal helpers ------------------------------------------------

  private async findMembership(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMembership | null> {
    const rows = await this.db.query({
      text: `SELECT id, organization_id, user_id, role, status, created_at, updated_at
             FROM cp_organization_memberships
             WHERE organization_id = $1 AND user_id = $2`,
      params: [organizationId, userId],
    });
    const row = rows[0];
    return row ? mapMembership(row as MembershipRow) : null;
  }

  /**
   * The authorization gate at the service boundary (WORK-003 §8). Every
   * mutating operation calls this before touching the DB. The check is
   * server-side and uses the /auth hasPermission primitive against the
   * SAME org the mutation targets — a caller who has admin in Org A
   * cannot use that to mutate Org B.
   */
  private requirePermission(
    principal: Principal,
    permission: string,
    organizationId: string,
  ): void {
    if (!hasPermission(principal, permission, organizationId)) {
      throw policyBlocked(
        `principal lacks permission "${permission}" in this organization`,
        { reason: "insufficient_permission", permission, organization_id: organizationId },
      );
    }
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
