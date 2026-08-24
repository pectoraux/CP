// /organizations/internal/permissions.ts
// Organization-level role → permission mapping (architecture §36, §30,
// §2.16, WORK-003 §5, §8). /organizations owns the org-level permission
// SEMANTICS (which role can do what at the organization level); /auth owns
// the reusable hasPermission primitive that evaluates a Principal against
// the resolved permission set.
//
// The mapping is intentionally small (WORK-003 §8: "keep the
// implementation intentionally small"):
//   owner  — full control, including delete + transfer + manage members
//   admin  — manage members + update org, cannot delete org
//   member — read org + list members (read-only)
//
// Only ACTIVE memberships grant any permission. INVITED/SUSPENDED/REMOVED
// memberships grant nothing (enforced by hasPermission in /auth).

import type { Permission, Role } from "@cp/auth";

export const ORG_PERMISSIONS = {
  /** Read the organization's own metadata. */
  READ: "organization.read" as const,
  /** Update the organization's own metadata (name, etc.). */
  UPDATE: "organization.update" as const,
  /** Delete the organization. */
  DELETE: "organization.delete" as const,
  /** Invite a new member. */
  MEMBER_INVITE: "organization.member.invite" as const,
  /** Manage existing members (change role, suspend, remove, reinstate). */
  MEMBER_MANAGE: "organization.member.manage" as const,
  /** List the organization's members. */
  MEMBER_LIST: "organization.member.list" as const,
} as const;

export type OrgPermission = typeof ORG_PERMISSIONS[keyof typeof ORG_PERMISSIONS];

/**
 * The organization-level role → permission mapping. This is the resolved
 * permission set for each membership's role; /organizations uses it when
 * constructing OrgMembership records returned to /auth's buildPrincipal.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    ORG_PERMISSIONS.READ,
    ORG_PERMISSIONS.UPDATE,
    ORG_PERMISSIONS.DELETE,
    ORG_PERMISSIONS.MEMBER_INVITE,
    ORG_PERMISSIONS.MEMBER_MANAGE,
    ORG_PERMISSIONS.MEMBER_LIST,
  ],
  admin: [
    ORG_PERMISSIONS.READ,
    ORG_PERMISSIONS.UPDATE,
    ORG_PERMISSIONS.MEMBER_INVITE,
    ORG_PERMISSIONS.MEMBER_MANAGE,
    ORG_PERMISSIONS.MEMBER_LIST,
  ],
  member: [
    ORG_PERMISSIONS.READ,
    ORG_PERMISSIONS.MEMBER_LIST,
  ],
};

/**
 * Resolve a role into its full permission set. Used when loading
 * memberships to build the Principal.
 */
export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
