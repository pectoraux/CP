// /credentials — public interface.
//
// Responsibility (architecture §2.17, §30, §36; lock §10; WORK-006
// declaration vocabulary + WORK-010 secret boundary): secret access
// boundary and provider credential metadata.
//
// WORK-010 delivers the tenant-scoped secret boundary with a RUNTIME
// OBJECT-CAPABILITY design (architect reviews #1 and #2 of PR #9):
//
//   - service (CredentialsService): METADATA-ONLY reads. No mutation,
//     no resolution, and NO grant-minting method exists anywhere —
//     holding the service grants nothing beyond safe metadata.
//   - mutationAuthority (CredentialMutationAuthority): create/rotate/
//     revoke — a separate frozen capability injected into the
//     /connections layer, which performs the tenant authorization
//     before every call. A future consumer holding only the metadata
//     service CANNOT mutate (the connection authorization boundary
//     cannot be bypassed).
//   - adapterResolver (AdapterCredentialResolver): the ONLY object in
//     the system that can resolve secret material. RESERVED for the
//     future execution/provider-adapter seam (WORK-014), which RECEIVES
//     it by injection from the composition root.
//
// CAPABILITY CONSTRUCTION IS NOT ON THIS INTERFACE (architect review
// #2): the factory that creates the privileged capabilities lives in
// ./composition.ts — a trusted construction entry importable ONLY by
// the composition root (src/api/internal/server.ts), enforced by the
// static architecture check (rule credentials-composition-restricted).
// Importing `@cp/credentials` — the ordinary public interface — can
// NEVER obtain the factory or either capability: an ordinary module
// cannot manufacture authority. This remains a genuine RUNTIME
// boundary, not a TypeScript brand: the capabilities are frozen objects
// whose references propagate only via explicit injection, and there is
// no minting method anywhere in the codebase.
//
//   Secret material is encrypted (AES-256-GCM, HKDF-derived per-record
//   key, deployment master key) in the PLATFORM ObjectStorage; never in
//   PostgreSQL, never in connection rows, never in logs, errors, API
//   responses, or idempotency records. Rotation keeps the credential
//   identity stable (new version, old blob deleted); revoked credentials
//   never resolve.
//
// TENANCY (lock §10): credentials are project-scoped. Callers resolve
// the authorized (organization, project) pair through the /projects
// public interface before any operation; this module never queries
// project tables itself.
//
// DEPENDENCY DIRECTION (WORK-010 §26, §30): /credentials imports ONLY
// @cp/platform (+ node builtins) — enforced by the static architecture
// check. /providers imports the declaration vocabulary from here
// (established in WORK-006); /connections consumes the service + the
// mutation capability through this public interface.
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import
// ONLY from this file.

// ---- Credential requirement metadata (declarations — WORK-006) ----------
export type {
  CredentialRequirement,
  CredentialKind,
} from "./internal/requirements.ts";
export {
  CREDENTIAL_KINDS,
  isCredentialKind,
  validateCredentialRequirements,
} from "./internal/requirements.ts";

// ---- Secret-access boundary (invocation-time, capability-scoped) --------
export type {
  CredentialResolver,
  ResolvedCredential,
} from "./internal/access.ts";
export { StaticCredentialResolver } from "./internal/access.ts";

// ---- The credentials boundary (WORK-010; architect review of PR #9) ------
export { CredentialsService, CREDENTIAL_STATUSES } from "./internal/service.ts";
export type {
  CredentialStatus,
  CredentialMetadata,
  ResolvedSecret,
  CredentialMutationAuthority,
  AdapterCredentialResolver,
  CreateCredentialInput,
  ReplaceSecretInput,
  RevokeCredentialInput,
  ResolveCredentialInput,
  ListCredentialsOptions,
  CredentialPage,
} from "./internal/service.ts";
// NOTE: the factory (createCredentialsBoundary) and its return/options
// types are deliberately NOT exported here — see ./composition.ts.

// ---- Schema migration --------------------------------------------------------
export { CREDENTIALS_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateCredentialsSchema } from "./internal/schema-runner.ts";

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "credentials" as const;
