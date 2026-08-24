// /organizations — public interface.
//
// Responsibility (architecture §36, §34, §30, §2.16, WORK-003 §5, §6, §7):
//   - organization identity
//   - organization membership
//   - roles
//   - membership state
//   - organization-level permissions
//   - organization membership lifecycle
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import ONLY
// from this file. Importing @cp/organizations/internal/* from outside this
// module is a forbidden cross-module internal import (architecture-lock §8)
// and is rejected by the static architecture check.
//
// Dependency direction (WORK-003): /organizations imports @cp/auth for the
// shared Principal/Role/MembershipStatus/Permission vocabulary and the
// hasPermission primitive. /auth does NOT import /organizations. No infra
// SDK (pg/ioredis/aws4fetch) is imported here — only @cp/platform's
// provider-neutral Database interface and @cp/auth's types.

// ---- OrganizationsService (DB-backed) ------------------------------
export { OrganizationsService } from "./internal/service.ts";
export type {
  OrganizationsServiceOptions,
  Organization,
  OrganizationMembership,
  OrgContext,
  CreateOrganizationInput,
  AddMemberInput,
  UpdateMembershipStateInput,
  UpdateRoleInput,
  RemoveMemberInput,
} from "./internal/service.ts";

// ---- Org-level permission vocabulary --------------------------------
export { ORG_PERMISSIONS, ROLE_PERMISSIONS, permissionsForRole } from "./internal/permissions.ts";
export type { OrgPermission } from "./internal/permissions.ts";

// ---- Schema migration ------------------------------------------------
export { ORG_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateOrganizationsSchema } from "./internal/schema-runner.ts";
