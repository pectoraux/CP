// /providers — public interface.
//
// Responsibility (architecture §2.10, §2.11, §7, §8, §32, §36, lock §7,
// WORK-006): provider integrations and adapter contracts.
//
// WORK-006 delivers the Provider Adapter Framework:
//   - provider identity + the frozen §7 lifecycle (discovered →
//     integrating → contract_tested → observed → certified → active, with
//     suspended/deprecated/revoked)
//   - provider-capability implementation declarations ("provider P
//     implements capability C at EXACTLY version V via adapter A") with
//     contract/version-based compatibility against /capabilities
//   - the stable ProviderAdapter contract + AdapterRegistry
//   - the deterministic contract-test harness and evidence-backed
//     certification foundation (fixture evidence is NEVER live evidence)
//   - the first-party reference adapter (demo.echo, fixture environment)
//
// Provider independence (lock §7): provider-specific SDKs are allowed ONLY
// inside provider adapters (src/providers/internal/adapters/*) — enforced
// by the static architecture check. Both platform-operated and
// provider-operated integrations use the SAME normalized contracts
// (integration_path on the provider record distinguishes the origin).
//
// Dependency direction (WORK-006 §20): /providers → @cp/capabilities (the
// capability graph is UPSTREAM of providers), @cp/credentials (credential
// requirement metadata), @cp/platform, @cp/auth. It NEVER imports
// /routing, /optimization, /experiments (routing/execution belong to
// later work) — enforced by the static architecture check.
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import ONLY
// from this file.

// ---- ProvidersService (DB-backed registry) ------------------------------
export { ProvidersService } from "./internal/service.ts";
export type {
  ProvidersServiceOptions,
  Provider,
  ProviderCapability,
  CertificationEvidenceRecord,
  CreateProviderInput,
  ListProvidersOptions,
  ProviderPage,
  TransitionProviderInput,
  DeclareCapabilityInput,
  RunContractTestsInput,
  RunContractTestsResult,
} from "./internal/service.ts";

// ---- Provider lifecycle (frozen architecture §7) ------------------------
export type { ProviderStatus, ImplementationStatus } from "./internal/service.ts";
export {
  PROVIDER_STATUSES,
  PROVIDER_LIFECYCLE_TRANSITIONS,
  isProviderStatus,
} from "./internal/service.ts";

// ---- Canonical identifiers (WORK-006) ------------------------------------
export {
  isValidProviderId,
  validateProviderId,
  isValidAdapterVersion,
  validateAdapterVersion,
  PROVIDER_ID_MAX_LEN,
} from "./internal/identifiers.ts";

// ---- Adapter contract (the stable provider boundary) ----------------------
import { AdapterRegistry } from "./internal/adapter.ts";
export type {
  ProviderAdapter,
  ProviderAdapterDescriptor,
  AdapterCapabilityDeclaration,
  AdapterConfigurationCheck,
  AdapterInvocationRequest,
  AdapterInvocationResult,
  AdapterEnvironment,
  IntegrationPath,
} from "./internal/adapter.ts";
export { AdapterRegistry } from "./internal/adapter.ts";

// ---- Error normalization (architecture §2.10, §31) ------------------------
export type { ProviderErrorKind, NormalizedProviderError } from "./internal/errors.ts";
export {
  providerError,
  normalizeProviderError,
  isNormalizedProviderFailure,
  isProviderErrorKind,
} from "./internal/errors.ts";

// ---- Contract-test harness + certification gates ---------------------------
export type {
  ContractTestName,
  ContractTestOutcome,
  ContractTestDeclarationInput,
  ContractTestDeclarationResult,
  ContractTestRunInput,
  ContractTestRunResult,
} from "./internal/contract-tests.ts";
export {
  CONTRACT_TEST_NAMES,
  CONTRACT_VERIFIED_GATE,
  runAdapterContractTests,
  validateTopLevelAgainstSchema,
} from "./internal/contract-tests.ts";

// ---- First-party reference adapter (deterministic fixture) -----------------
// Fixture environment: contract-tested, never live-certified (WORK-006 §14).
import { createDemoEchoAdapter } from "./internal/adapters/demo-echo-adapter.ts";
export {
  createDemoEchoAdapter,
  DEMO_ECHO_PROVIDER_ID,
  DEMO_ECHO_ADAPTER_VERSION,
} from "./internal/adapters/demo-echo-adapter.ts";
export type {
  DemoEchoInput,
  DemoEchoOutput,
  DemoEchoFailureMode,
} from "./internal/adapters/demo-echo-adapter.ts";

/**
 * The default in-process adapter registry: every first-party adapter
 * shipped with the platform, keyed by canonical provider id. Currently
 * contains ONLY the deterministic demo.echo fixture adapter (WORK-006
 * scopes out individual production provider integrations).
 */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(createDemoEchoAdapter());
  return registry;
}

// ---- Schema migration -------------------------------------------------------
export { PROVIDER_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateProvidersSchema } from "./internal/schema-runner.ts";

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "providers" as const;
