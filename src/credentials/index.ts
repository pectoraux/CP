// /credentials — public interface.
//
// Responsibility (architecture §2.17, §30, §36; lock §10; WORK-006
// declaration vocabulary + WORK-010 secret boundary): secret access
// boundary and provider credential metadata.
//
// WORK-010 delivers the tenant-scoped secret boundary:
//   - CredentialMetadata (cp_credentials, project-scoped) — the SAFE
//     shape ordinary APIs may see (kind/name/status/version — never
//     values)
//   - SecretMaterial — encrypted (AES-256-GCM, HKDF-derived per-record
//     key, deployment master key) in the PLATFORM ObjectStorage
//     boundary; never in PostgreSQL, never in connection rows, never in
//     logs, errors, API responses, or idempotency records
//   - CredentialsService: create / replace (rotate) / revoke / metadata
//     reads / resolveForAdapter (the ONLY secret-returning operation,
//     gated on the branded AdapterCredentialGrant reserved for the
//     future execution/provider-adapter seam — architecture §30)
//   - Rotation keeps the credential identity stable (new version, old
//     blob deleted — old versions cannot be resurrected); revoked
//     credentials never resolve
//
// TENANCY (lock §10): credentials are project-scoped. Callers resolve
// the authorized (organization, project) pair through the /projects
// public interface before any operation; this module never queries
// project tables itself.
//
// DEPENDENCY DIRECTION (WORK-010 §26, §30): /credentials imports ONLY
// @cp/platform (+ node builtins) — enforced by the static architecture
// check. /providers imports the declaration vocabulary from here
// (established in WORK-006); /connections consumes the service through
// this public interface.
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

// ---- CredentialsService (WORK-010 secret boundary) ------------------------
export { CredentialsService } from "./internal/service.ts";
export type {
  CredentialStatus,
  CredentialMetadata,
  ResolvedSecret,
  AdapterCredentialGrant,
  CreateCredentialInput,
  ReplaceSecretInput,
  RevokeCredentialInput,
  ResolveCredentialInput,
  ListCredentialsOptions,
  CredentialPage,
  CredentialsServiceOptions,
} from "./internal/service.ts";
export { CREDENTIAL_STATUSES } from "./internal/service.ts";

// ---- Schema migration --------------------------------------------------------
export { CREDENTIALS_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateCredentialsSchema } from "./internal/schema-runner.ts";

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "credentials" as const;
