// /providers/internal/adapter.ts
// The stable provider adapter contract (WORK-006, architecture §2.10,
// §2.11, §7, §8, lock §7).
//
// A ProviderAdapter is the provider-side half of the capability model:
// the capability layer (WORK-005) is authoritative for WHAT can be done;
// the provider layer is authoritative for WHO implements it; the ADAPTER
// is authoritative for HOW that provider is translated into the CP
// contract (WORK-006 §29 final rule). This file defines that stable
// boundary so that:
//   - a NEW provider can be implemented without modifying capability
//     semantics or execution domain internals (WORK-006 definition of
//     done)
//   - platform-operated and provider-operated integrations use the SAME
//     normalized contract (lock §7)
//   - provider-specific code is ISOLATED behind this interface (lock §7:
//     provider SDKs are allowed only inside provider adapters)
//
// WORK-006 deliberately does NOT build the execution engine: `invoke` is
// the minimal normalized invocation seam required by future execution
// work (WORK-014) — nothing in this module routes, ranks, retries, or
// orchestrates.
//
// Provider SDK imports (stripe, openai, twilio, ...) are permitted ONLY
// in files under src/providers/internal/adapters/ — enforced by the
// static architecture check (provider-sdk-isolation rule).

import type {
  CredentialRequirement,
  CredentialResolver,
} from "@cp/credentials";

// ---- Descriptor ---------------------------------------------------------

/** How the integration was produced (architecture §8). */
export type IntegrationPath = "platform_operated" | "provider_operated";

/**
 * The runtime environment an adapter executes against. `fixture` adapters
 * are deterministic test implementations — they can produce
 * CONTRACT-TESTED evidence but NEVER live certification evidence
 * (WORK-006 §14: never claim a live certification based on a mock).
 */
export type AdapterEnvironment = "fixture" | "live";

/** A capability this adapter declares it implements. */
export interface AdapterCapabilityDeclaration {
  /** Canonical capability id, e.g. `demo.echo`. */
  capabilityId: string;
  /** EXACT capability contract version(s) supported — compatibility is
   * contract/version based, never name-based (WORK-006 §12). */
  capabilityVersions: string[];
  /**
   * A deterministic sample input used by the contract-test harness. Must
   * conform to the capability version's input schema. This is test
   * fixture data — never a live request.
   */
  sampleInput: unknown;
  /** Non-secret provider mapping notes (e.g. "maps output.x → charge_id"). */
  notes?: string;
}

/** Immutable adapter self-description. */
export interface ProviderAdapterDescriptor {
  /** Canonical provider id this adapter implements (e.g. `demo.echo`). */
  providerId: string;
  name: string;
  description: string;
  integrationPath: IntegrationPath;
  environment: AdapterEnvironment;
  /** MAJOR.MINOR.PATCH revision of the adapter itself. */
  adapterVersion: string;
  documentationUrl?: string;
  /** Which credentials this adapter requires (metadata only). */
  credentialRequirements: CredentialRequirement[];
  capabilities: AdapterCapabilityDeclaration[];
}

// ---- Configuration verification -----------------------------------------

export interface AdapterConfigurationCheck {
  /** True when the adapter's configuration surface is well-formed. */
  ok: boolean;
  /** Named problems (never secret values). */
  problems: string[];
}

// ---- Normalized invocation boundary (seam for future execution) --------

/**
 * A normalized provider invocation request. The future execution engine
 * (WORK-014) constructs these AFTER capability-contract validation and
 * eligibility; the adapter receives an already-validated request and
 * must not re-implement capability semantics.
 */
export interface AdapterInvocationRequest {
  capabilityId: string;
  capabilityVersion: string;
  /** Input conforming to the capability version's input schema. */
  input: unknown;
  /** Execution-scoped idempotency key when the capability supports it. */
  idempotencyKey?: string;
  /** Values for the capability contract's required_context, if any. */
  context?: Record<string, unknown>;
}

/**
 * A normalized provider invocation result. `output` must conform to the
 * capability version's OUTPUT schema — provider response shapes are the
 * adapter's private concern and must never leak raw (architecture §2.10).
 */
export interface AdapterInvocationResult {
  output: unknown;
  /** Provider-stable request identifier for tracing (non-secret). */
  providerRequestId?: string;
  /** Non-secret provider response metadata. */
  metadata?: Record<string, unknown>;
}

// ---- The contract --------------------------------------------------------

/**
 * The stable provider adapter contract (WORK-006). Implementations:
 *   - describe()            — identity, integration path, environment,
 *                             credential requirements, declared capabilities
 *   - verifyConfiguration() — validate the adapter's configuration
 *                             surface WITHOUT secrets and WITHOUT live
 *                             calls (auth boundary self-check)
 *   - invoke()              — the normalized invocation seam (translated
 *                             input → provider call → normalized output;
 *                             provider errors surface as AppErrors via the
 *                             /providers error-normalization surface)
 *
 * Adapters are registered in an AdapterRegistry keyed by canonical
 * provider id; the registry (not the adapter) is what the service layer
 * consumes.
 */
export interface ProviderAdapter {
  descriptor(): ProviderAdapterDescriptor;
  verifyConfiguration(): Promise<AdapterConfigurationCheck>;
  /**
   * Invoke the provider for one declared capability version. MUST throw
   * (POLICY_BLOCKED provider.capability.unsupported) when asked for a
   * capability/version not declared in the descriptor. MUST surface
   * provider-side failures as normalized AppErrors (never raw SDK
   * errors). MUST accept a CredentialResolver for secret access when the
   * descriptor declares credential requirements.
   */
  invoke(
    request: AdapterInvocationRequest,
    credentials: CredentialResolver,
  ): Promise<AdapterInvocationResult>;
}

// ---- Registry ------------------------------------------------------------

/**
 * An in-process registry of available provider adapters. Adapters are
 * keyed by canonical provider id. The registry is the ONLY way domain
 * code reaches an adapter — provider-specific code stays behind the
 * ProviderAdapter boundary.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    const d = adapter.descriptor();
    if (this.adapters.has(d.providerId)) {
      throw new Error(`adapter registry: duplicate adapter for provider "${d.providerId}"`);
    }
    this.adapters.set(d.providerId, adapter);
  }

  get(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  has(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  list(): ProviderAdapterDescriptor[] {
    return [...this.adapters.values()].map((a) => a.descriptor());
  }
}
