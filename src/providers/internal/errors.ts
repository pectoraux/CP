// /providers/internal/errors.ts
// Provider error normalization (WORK-006, architecture §2.10, §31).
//
// Provider APIs produce arbitrary errors (SDK exceptions, HTTP status
// codes, HTML error pages, network drops). The ADAPTER owns translation
// (architecture §2.10: "provider-specific behavior resides behind
// adapters"): a raw provider error must never leak outside the adapter
// boundary as a StripeError/OpenAIError/AxiosError or an unclassified
// Error. This module provides the normalized translation surface every
// adapter uses.
//
// Classification follows the CP failure model (architecture §31):
//   provider error → PROVIDER_FAILURE   (the provider answered, badly)
//   network error  → NETWORK_FAILURE    (could not reach the provider)
//   rate limiting  → RATE_LIMITED
//   timeout        → TIMEOUT
//   bad credential → CREDENTIAL_FAILURE (never PROVIDER_FAILURE, and a
//                    provider failure is never represented as a policy
//                    failure)
//
// Normalized errors are AppErrors — the existing platform failure model —
// so downstream layers (future execution engine, eligibility, routing)
// consume ONE error vocabulary regardless of provider.

import { AppError, type FailureCategory } from "@cp/platform";

/** The provider-side error kinds an adapter can normalize. */
export type ProviderErrorKind =
  | "provider_failure"
  | "network_failure"
  | "rate_limited"
  | "timeout"
  | "credential_failure";

const KIND_TO_CATEGORY: ReadonlyMap<ProviderErrorKind, FailureCategory> = new Map([
  ["provider_failure", "PROVIDER_FAILURE"],
  ["network_failure", "NETWORK_FAILURE"],
  ["rate_limited", "RATE_LIMITED"],
  ["timeout", "TIMEOUT"],
  ["credential_failure", "CREDENTIAL_FAILURE"],
]);

export function isProviderErrorKind(v: string): v is ProviderErrorKind {
  return (KIND_TO_CATEGORY as Map<string, FailureCategory>).has(v);
}

/**
 * A normalized provider error: everything the platform needs to reason
 * about the failure (kind, provider-stable error code, retryability)
 * with NOTHING provider-SDK-shaped leaking through.
 */
export interface NormalizedProviderError {
  kind: ProviderErrorKind;
  /**
   * Provider-stable error identifier (e.g. "insufficient_funds"). Chosen
   * by the adapter from the provider's documented error space. Free-form
   * SDK messages belong in `detail`, never in `code`.
   */
  code: string;
  message: string;
  retryable: boolean;
  /** Optional non-secret context (HTTP status, provider request id). */
  detail?: Record<string, unknown>;
}

/** Builder helpers adapters use to raise normalized errors. */
export function providerError(
  kind: ProviderErrorKind,
  code: string,
  message: string,
  opts: { retryable?: boolean; detail?: Record<string, unknown> } = {},
): AppError {
  return new AppError({
    category: KIND_TO_CATEGORY.get(kind) ?? "PROVIDER_FAILURE",
    code: `provider.${code}`,
    message,
    retryable: opts.retryable ?? (kind === "network_failure" || kind === "rate_limited"),
    details: {
      provider_error_kind: kind,
      ...(opts.detail ?? {}),
    },
  });
}

/**
 * Translate an unknown caught value into a normalized AppError. Used at
 * the adapter boundary as the last line of defense: whatever the SDK
 * threw, the platform sees an AppError with a proper failure category.
 * Raw SDK error objects/messages are wrapped — never rethrown as-is —
 * and stack traces / SDK-specific fields are dropped from the details.
 */
export function normalizeProviderError(
  err: unknown,
  context: { providerId: string; operation: string },
): AppError {
  if (err instanceof AppError) {
    // Already normalized (or a platform error) — pass through untouched.
    return err;
  }
  const rawMessage = err instanceof Error ? err.message : String(err);
  const rawCode = (err as { code?: string } | undefined)?.code;
  const rawStatus = (err as { status?: number; statusCode?: number } | undefined);
  const status = rawStatus?.status ?? rawStatus?.statusCode;

  // Classification from common signal shapes. Adapters SHOULD classify
  // precisely themselves; this is the defensive default.
  let kind: ProviderErrorKind = "provider_failure";
  if (typeof status === "number") {
    if (status === 429) kind = "rate_limited";
    else if (status === 401 || status === 403) kind = "credential_failure";
    else if (status >= 500) kind = "provider_failure";
    else if (status === 408) kind = "timeout";
  }
  if (typeof rawCode === "string") {
    const c = rawCode.toUpperCase();
    if (c === "ECONNREFUSED" || c === "ECONNRESET" || c === "ENOTFOUND" || c === "EAI_AGAIN") {
      kind = "network_failure";
    } else if (c === "ETIMEDOUT" || c === "EPIPE") {
      kind = "timeout";
    }
  }
  if (/timeout|timed out/i.test(rawMessage)) kind = "timeout";
  if (/rate limit|too many requests/i.test(rawMessage)) kind = "rate_limited";

  return providerError(kind, "error.not_normalized", `provider "${context.providerId}" failed during ${context.operation}: ${rawMessage}`, {
    retryable: kind === "network_failure" || kind === "rate_limited",
    detail: {
      provider_id: context.providerId,
      operation: context.operation,
      ...(typeof status === "number" ? { http_status: status } : {}),
    },
  });
}

/**
 * Assert that an error is properly normalized (an AppError whose category
 * is a provider-side failure category). Contract tests use this to prove
 * an adapter never leaks raw SDK errors (architecture §2.10).
 */
export function isNormalizedProviderFailure(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  return (
    err.category === "PROVIDER_FAILURE" ||
    err.category === "NETWORK_FAILURE" ||
    err.category === "RATE_LIMITED" ||
    err.category === "TIMEOUT" ||
    err.category === "CREDENTIAL_FAILURE"
  );
}
