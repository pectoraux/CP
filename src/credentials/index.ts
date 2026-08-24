// /credentials — public interface.
//
// Responsibility (architecture §2.17, §30, §36; WORK-006): secret access
// boundary and provider credential metadata.
//
// WORK-006 delivers the DECLARATION vocabulary (CredentialRequirement —
// which credentials a provider adapter requires) and the ACCESS boundary
// interface (CredentialResolver — capability-scoped secret access at
// invocation time). The concrete tenant-scoped credential storage,
// connection lifecycle, and revocation belong to WORK-010 (connections)
// and are intentionally not implemented here.
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import ONLY
// from this file. Importing @cp/credentials/internal/* from outside this
// module is a forbidden cross-module internal import (architecture-lock
// §8) and is rejected by the static architecture check.
//
// Dependency direction: /credentials depends only on node builtins. It
// does not import /providers (the requirement vocabulary is consumed BY
// providers, not derived from them) — the dependency arrow is
// /providers → /credentials.

// ---- Credential requirement metadata (declarations, never secrets) ----
export type {
  CredentialRequirement,
  CredentialKind,
} from "./internal/requirements.ts";
export {
  CREDENTIAL_KINDS,
  isCredentialKind,
  validateCredentialRequirements,
} from "./internal/requirements.ts";

// ---- Secret-access boundary (invocation-time, capability-scoped) ------
export type {
  CredentialResolver,
  ResolvedCredential,
} from "./internal/access.ts";
export { StaticCredentialResolver } from "./internal/access.ts";

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "credentials" as const;
