// /connections — public interface.
//
// Responsibility (architecture §34, §36; lock §10; WORK-010 CONN-001..004):
// tenant/provider connection lifecycle. The tenant-scoped layer between
// the GLOBAL provider/catalog layers and the credential boundary:
//
//     /providers  = WHO the platform/provider is       (global)
//     /catalog    = WHAT the provider offers           (global)
//     /connections = HOW THIS TENANT IS CONNECTED      (project-scoped)
//     /credentials = WHERE THE SECRET MATERIAL LIVES   (narrow boundary)
//
// WORK-010 delivers:
//   - PROJECT-SCOPED connections (frozen §34) referencing a global
//     provider (validated via the /providers public interface) with
//     optional exact capability+version scoping (validated via
//     /capabilities + /providers public interfaces)
//   - the lifecycle draft → active → paused → revoked with ACTIVATION
//     GATED ON STRUCTURAL VERIFICATION (a connection never becomes
//     active merely because it exists)
//   - non-secret, bounded, provider-neutral configuration (secret-ish
//     keys rejected outright — secrets only through the credential
//     endpoint)
//   - credential ATTACH/DETACH through the /credentials public service:
//     the connection stores ONLY an opaque credential reference; secret
//     material lives encrypted behind /credentials (rotation = new
//     credential with the connection identity stable; detach revokes)
//   - STRUCTURAL verification only (provider/declaration/credential/
//     configuration checks — NO live provider calls, NO adapter
//     invocation: execution belongs to the future ProviderAdapter
//     boundary)
//
// Connection existence NEVER mutates catalog/eligibility/routing state
// (§34): the connection layer is downstream tenant infrastructure.
//
// Dependency direction (§30): /connections → @cp/platform, @cp/auth,
// @cp/projects, @cp/providers, @cp/capabilities, @cp/credentials public
// interfaces ONLY — never /routing, /optimization, or any downstream
// module (enforced by the static architecture check).
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import
// ONLY from this file.

// ---- ConnectionsService (DB-backed) ---------------------------------------
export { ConnectionsService } from "./internal/service.ts";
export type {
  ConnectionsServiceOptions,
  Connection,
  VerificationOutcome,
  CreateConnectionInput,
  UpdateConnectionInput,
  TransitionConnectionInput,
  AttachCredentialInput,
  DetachCredentialInput,
  VerifyConnectionInput,
  ListConnectionsOptions,
  ConnectionPage,
} from "./internal/service.ts";
export { validateConfiguration } from "./internal/service.ts";

// ---- Lifecycle (WORK-010 §4) ------------------------------------------------
export type { ConnectionStatus } from "./internal/service.ts";
export {
  CONNECTION_STATUSES,
  CONNECTION_LIFECYCLE,
  isConnectionStatus,
} from "./internal/service.ts";

// ---- Schema migration --------------------------------------------------------
export { CONNECTIONS_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateConnectionsSchema } from "./internal/schema-runner.ts";

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "connections" as const;
