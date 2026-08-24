// /providers/internal/identifiers.ts
// Canonical provider identifier + adapter-version validation (WORK-006,
// architecture §7). A provider id is a globally stable, deterministic,
// normalized, human-readable identifier (e.g. `paystack`,
// `provider.openai`) — safe for API use and suitable as a registry key.
//
// Rules (mirroring the WORK-005 capability-id discipline):
//   - one or more dot-separated segments (`paystack`, `provider.openai`)
//   - each segment: lowercase letters/digits/underscores, letter-first,
//     1..63 chars
//   - total length <= 200 chars
//   - no whitespace, no uppercase (rejected, not silently canonicalized),
//     no leading/trailing dots, no empty segments
// Provider ids MUST NOT encode capability names — a provider is an
// implementation source for MANY capabilities (architecture §7).

import { AppError } from "@cp/platform";

export const PROVIDER_ID_MAX_LEN = 200;
const SEGMENT_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function isValidProviderId(v: string): boolean {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > PROVIDER_ID_MAX_LEN) return false;
  if (v !== v.trim()) return false;
  const segments = v.split(".");
  if (segments.length === 0) return false;
  return segments.every((seg) => SEGMENT_RE.test(seg));
}

/**
 * Validate a canonical provider id. Returns the normalized id on success;
 * throws POLICY_BLOCKED (provider.id.invalid) with a precise reason on
 * failure. Uppercase input is REJECTED (no silent canonicalization) so a
 * mis-typed id can never silently alias a different provider.
 */
export function validateProviderId(v: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw invalidProviderId("provider id is required", v);
  }
  if (v !== v.trim()) {
    throw invalidProviderId("provider id must not contain leading/trailing whitespace", v);
  }
  if (v.length > PROVIDER_ID_MAX_LEN) {
    throw invalidProviderId(`provider id exceeds ${PROVIDER_ID_MAX_LEN} characters`, v);
  }
  if (/[A-Z]/.test(v)) {
    throw invalidProviderId("provider id must be lowercase (no silent canonicalization)", v);
  }
  if (/\s/.test(v)) {
    throw invalidProviderId("provider id must not contain whitespace", v);
  }
  const segments = v.split(".");
  for (const seg of segments) {
    if (seg.length === 0) {
      throw invalidProviderId("provider id must not contain empty dot segments", v);
    }
    if (!SEGMENT_RE.test(seg)) {
      throw invalidProviderId(
        "each provider id segment must start with a letter and contain only [a-z0-9_] (<=63 chars)",
        v,
      );
    }
  }
  return v;
}

// Adapter versions follow MAJOR.MINOR.PATCH (all numeric, no pre-release
// tags in the registry key — an adapter version identifies a published
// contract-tested revision).
const ADAPTER_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function isValidAdapterVersion(v: string): boolean {
  return typeof v === "string" && ADAPTER_VERSION_RE.test(v);
}

export function validateAdapterVersion(v: string): string {
  if (!isValidAdapterVersion(v)) {
    throw new AppError({
      category: "POLICY_BLOCKED",
      code: "provider.adapter_version.invalid",
      message: `adapter version must be MAJOR.MINOR.PATCH (numeric), got "${v}"`,
      retryable: false,
      details: { reason: "invalid_adapter_version", value: v },
    });
  }
  return v;
}

function invalidProviderId(reason: string, value: string): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "provider.id.invalid",
    message: `invalid provider id: ${reason}`,
    retryable: false,
    details: { reason, value: typeof value === "string" ? value.slice(0, 64) : String(value) },
  });
}
