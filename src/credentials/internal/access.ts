// /credentials/internal/access.ts
// The secret-access boundary (WORK-006, architecture §2.17, §30).
//
// Adapters must receive only the credentials/scopes required for their
// provider operation (architecture §30). This file defines the interface
// through which an adapter obtains a resolved credential AT INVOCATION
// TIME — capability-scoped access, never a bulk dump of tenant secrets.
//
// WORK-006 defines the boundary only. The concrete tenant-scoped
// implementation (storage, encryption, revocation, per-connection
// resolution) belongs to WORK-010 (connections) and is intentionally NOT
// implemented here. A static resolver is provided for deterministic
// contract testing of adapters without any secret storage.

/**
 * A resolved credential value. The `value` is SECRET MATERIAL: it must
 * never be logged, serialized into API responses, embedded in error
 * details, or persisted into provider rows. Adapters receive it only to
 * authenticate the specific provider operation being executed.
 */
export interface ResolvedCredential {
  /** The requirement name this value resolves (e.g. "api_key"). */
  name: string;
  /** The secret value. Never logged, never returned by APIs. */
  value: string;
  /** Optional additional non-secret fields (e.g. OAuth client id). */
  metadata?: Record<string, string>;
}

/**
 * Capability-scoped secret access. An adapter receives a resolver bound
 * to a single provider operation; it can ask only for the requirements
 * it declared. Resolution failures surface as CREDENTIAL_FAILURE so a
 * missing/revoked credential is distinguishable from a provider failure
 * (architecture §31: a provider failure must not be represented as a
 * credential failure and vice versa).
 */
export interface CredentialResolver {
  /**
   * Resolve the declared requirement `name` for this provider operation.
   * Throws (CREDENTIAL_FAILURE) when the requirement is unknown to this
   * resolver or no credential has been connected for it.
   */
  resolve(name: string): Promise<ResolvedCredential>;
}

// A static resolver for contract tests and fixtures: deterministic
// in-memory values, never a production secret store.

import { AppError } from "@cp/platform";

/**
 * Deterministic in-memory resolver for contract tests and fixtures.
 * Accepts a plain name→value map. NOT a production secret store — the
 * values live only for the lifetime of the resolver instance.
 */
export class StaticCredentialResolver implements CredentialResolver {
  private readonly values: Map<string, string>;

  constructor(values: Record<string, string> = {}) {
    this.values = new Map(Object.entries(values));
  }

  async resolve(name: string): Promise<ResolvedCredential> {
    const value = this.values.get(name);
    if (value === undefined) {
      // CREDENTIAL_FAILURE, not PROVIDER_FAILURE (architecture §31: a
      // provider failure must not be represented as a credential failure
      // and vice versa). Real AppError so adapter-side normalization
      // passes it through with its category intact.
      throw new AppError({
        category: "CREDENTIAL_FAILURE",
        code: "credential.not_connected",
        message: `credential "${name}" is not available for this operation`,
        retryable: false,
      });
    }
    return { name, value };
  }
}
