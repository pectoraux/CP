// /auth/internal/principal.ts
// Authorization primitive vocabulary (architecture §36, §30, §2.16,
// WORK-003 §3, §4, §8). /auth owns:
//   - the Principal type (authenticated caller + resolved organization
//     memberships + roles + permissions)
//   - the role / membership-status / permission types
//   - buildPrincipal() — assemble a Principal from identity + memberships
//   - hasPermission() — the reusable authorization primitive other modules
//     call to make policy decisions
//
// /organizations owns the concrete ORG-level role→permission mapping and the
// membership data; it imports these types from @cp/auth and populates them.
// This keeps the dependency one-way (organizations → auth) and avoids any
// circular import.
//
// Authentication ≠ Authorization ≠ Tenant isolation (WORK-003 §3):
//   - Authentication answers "who is this caller?" → userId (verified by
//     password credential or API key)
//   - Authorization answers "what may this caller do?" → hasPermission()
//   - Tenant isolation answers "which organization's data may this caller
//     access?" → resolveOrgContext() (lives in /organizations because it
//     owns tenant ownership)

export type Role = "owner" | "admin" | "member";

export type MembershipStatus = "active" | "invited" | "suspended" | "removed";

/**
 * Permission is an opaque string. Concrete permission values are defined by
 * the module that owns that resource family (e.g. /organizations defines
 * `organization.*` permissions). The Principal's memberships carry the
 * resolved permission set so that `hasPermission` is a pure, deterministic
 * evaluation with no DB lookup.
 */
export type Permission = string;

/**
 * A single organization membership as carried on a Principal. The
 * `permissions` field is the fully-resolved set this membership grants (role
 * → permissions resolved by the owning module at load time). Only ACTIVE
 * memberships are considered for authorization decisions.
 */
export interface OrgMembership {
  readonly organizationId: string;
  readonly role: Role;
  readonly status: MembershipStatus;
  readonly permissions: readonly Permission[];
}

/**
 * The authenticated principal. Constructed by /auth's `buildPrincipal()`
 * from a verified userId + memberships loaded by /organizations. The
 * Principal is the explicit authenticated-context object passed to domain
 * operations — never collapse it into a boolean `isAuthenticated`.
 */
export interface Principal {
  readonly userId: string;
  readonly memberships: readonly OrgMembership[];
}

/**
 * Assemble a Principal from a verified user id and the memberships loaded
 * for that user. This is the boundary where Authentication (userId) meets
 * Authorization (memberships). The memberships must already have their
 * `permissions` resolved by the owning module.
 */
export function buildPrincipal(
  userId: string,
  memberships: readonly OrgMembership[],
): Principal {
  return { userId, memberships };
}

/**
 * The reusable authorization primitive. Returns true iff the principal has
 * an ACTIVE membership (optionally in the specified organization) that
 * grants the requested permission.
 *
 * - Only `active` memberships are considered; `invited`, `suspended`, and
 *   `removed` memberships never grant access (WORK-003 §15).
 * - When `orgId` is omitted, the principal is authorized if ANY active
 *   membership grants the permission (used for global/cross-org operations).
 * - When `orgId` is provided, only that org's active membership is checked
 *   (used for tenant-scoped operations).
 * - Deterministic and pure: no DB lookup, no side effects.
 */
export function hasPermission(
  principal: Principal,
  permission: Permission,
  orgId?: string,
): boolean {
  for (const m of principal.memberships) {
    if (m.status !== "active") continue;
    if (orgId !== undefined && m.organizationId !== orgId) continue;
    if (m.permissions.includes(permission)) return true;
  }
  return false;
}

/**
 * Resolve the principal's active membership in a specific organization.
 * Returns the membership if the principal is an ACTIVE member, otherwise
 * null. This is the server-side tenant-membership check (WORK-003 §7):
 * the caller's claim to act "as Org X" must be backed by an authenticated,
 * active membership in Org X.
 */
export function activeMembershipIn(
  principal: Principal,
  organizationId: string,
): OrgMembership | null {
  for (const m of principal.memberships) {
    if (m.organizationId === organizationId && m.status === "active") {
      return m;
    }
  }
  return null;
}

/**
 * The set of membership statuses. Kept here (in /auth) as the canonical
 * vocabulary; /organizations imports it.
 */
export const MEMBERSHIP_STATUSES: readonly MembershipStatus[] = [
  "active",
  "invited",
  "suspended",
  "removed",
] as const;

export const ROLES: readonly Role[] = ["owner", "admin", "member"] as const;
