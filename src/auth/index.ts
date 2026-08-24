// /auth — public interface.
//
// Responsibility (architecture §36, §30, §2.16, §2.17, WORK-003 §4):
//   - user identity
//   - authentication credentials/tokens
//   - session/access-token verification
//   - principal construction
//   - authentication failures
//   - authorization primitives that are reusable by other modules
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import ONLY
// from this file. Importing @cp/auth/internal/* from outside this module
// is a forbidden cross-module internal import (architecture-lock §8) and
// is rejected by the static architecture check.
//
// Dependency direction (WORK-003): /organizations imports @cp/auth for the
// shared Principal/Role/MembershipStatus/Permission vocabulary and the
// hasPermission primitive. /auth does NOT import @cp/organizations. No
// infra SDK (pg/ioredis/aws4fetch) is imported here — only @cp/platform's
// provider-neutral Database interface.

// ---- Authorization primitive vocabulary ------------------------------
// The Principal is the explicit authenticated-context object passed to
// domain operations. Authentication (userId) and authorization (memberships)
// are kept distinct from tenant isolation (resolveOrgContext, in
// /organizations). Never collapse into a boolean isAuthenticated.
export type {
  Principal,
  OrgMembership,
  Role,
  MembershipStatus,
  Permission,
} from "./internal/principal.ts";
export {
  buildPrincipal,
  hasPermission,
  activeMembershipIn,
  MEMBERSHIP_STATUSES,
  ROLES,
} from "./internal/principal.ts";

// ---- Password + API key primitives (pure, no DB) --------------------
export {
  hashPassword,
  verifyPasswordHash,
  verifyDummyPassword,
} from "./internal/password.ts";
export {
  generateApiKey,
  hashApiKey,
  parseApiKeyId,
  constantTimeHexEqual,
} from "./internal/api-key.ts";

// ---- AuthService (DB-backed) ----------------------------------------
export { AuthService } from "./internal/service.ts";
export type {
  AuthServiceOptions,
  UserRecord,
  ApiKeyRecord,
  CreatedApiKey,
  CreateUserInput,
  CreateApiKeyInput,
  VerifiedCredential,
} from "./internal/service.ts";

// ---- Schema migration ------------------------------------------------
export { AUTH_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateAuthSchema } from "./internal/schema-runner.ts";
