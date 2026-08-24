// /capabilities/internal/identifiers.ts
// Canonical capability identifier validation (architecture §2.2, WORK-005 §5).
//
// A capability identifier is a globally-stable, normalized, human-readable,
// API-safe, graph-reference-safe string of the form:
//
//     namespace.action
//
// e.g. `payment.accept`, `ai.generate`, `identity.verify`, `message.send`,
// `compute.run`, `storage.put`, `search.query`, `document.extract`.
//
// Validation rules (WORK-005 §5):
//   - exactly one '.' separating a non-empty namespace and a non-empty action
//   - lowercase ASCII letters and digits only (no uppercase — uppercase is
//     REJECTED, not silently lowercased, so two inputs that differ only by
//     case can never collide after canonicalization)
//   - each segment must start with a letter
//   - no whitespace, no multiple dots, no leading/trailing dots, no
//     underscores, no hyphens (these would make the identifier ambiguous as
//     a graph reference or could collide with other dotted conventions)
//   - bounded length so the id stays legible and URL-safe
//
// The application layer is authoritative for validation; the DB UNIQUE is on
// lower(capability_id) as a defense-in-depth safety net (the stored value is
// always already lowercase because uppercase is rejected here).

import { AppError } from "@cp/platform";

export const CAPABILITY_ID_MAX_LEN = 80;
const SEGMENT_MAX_LEN = 40;

// namespace.action where each segment is [a-z][a-z0-9]* and there is exactly
// one dot. No uppercase, no underscores, no hyphens.
const CAPABILITY_ID_RE = /^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/;

export function isValidCapabilityId(id: string): boolean {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > CAPABILITY_ID_MAX_LEN) return false;
  // Reject any uppercase, whitespace, or non-ASCII outright — do NOT silently
  // canonicalize (WORK-005 §5: "Do not silently canonicalize identifiers in
  // ways that could produce collisions").
  if (/[A-Z]/.test(id)) return false;
  if (/\s/.test(id)) return false;
  if (!CAPABILITY_ID_RE.test(id)) return false;
  const [ns, action] = id.split(".");
  if (!ns || !action) return false;
  if (ns.length === 0 || ns.length > SEGMENT_MAX_LEN) return false;
  if (action.length === 0 || action.length > SEGMENT_MAX_LEN) return false;
  return true;
}

/**
 * Validate a capability id. Throws a structured POLICY_BLOCKED on malformed
 * input so callers learn WHY the id was rejected (which rule) rather than a
 * bare boolean. Used by the service's createCapability path.
 */
export function validateCapabilityId(id: string): string {
  if (typeof id !== "string" || id.length === 0) {
    throw invalidId("empty", "capability id is required");
  }
  if (id.length > CAPABILITY_ID_MAX_LEN) {
    throw invalidId("too_long", `capability id exceeds ${CAPABILITY_ID_MAX_LEN} characters`);
  }
  if (/[A-Z]/.test(id)) {
    throw invalidId(
      "uppercase",
      "capability id must be lowercase; uppercase is rejected (not silently canonicalized)",
    );
  }
  if (/\s/.test(id)) {
    throw invalidId("whitespace", "capability id must not contain whitespace");
  }
  if (!CAPABILITY_ID_RE.test(id)) {
    throw invalidId(
      "malformed",
      "capability id must be 'namespace.action' (lowercase letters/digits, exactly one dot, each segment starting with a letter)",
    );
  }
  const [ns, action] = id.split(".");
  if (!ns || !action) {
    throw invalidId("empty_segment", "namespace and action must both be non-empty");
  }
  if (ns.length > SEGMENT_MAX_LEN || action.length > SEGMENT_MAX_LEN) {
    throw invalidId("segment_too_long", `a segment exceeds ${SEGMENT_MAX_LEN} characters`);
  }
  return id;
}

// ---- Version validation ----------------------------------------------
// A capability version is a positive-integer string (1, 2, 3, ...). This is
// deterministic, lexicographically sortable once zero-padded, human-readable
// ("v3"), and matches the §2.2/§6 examples ("v1 v2 v3"). Semver is not
// required by the frozen architecture and would add ambiguity (is 1.0.0 the
// same as 1?); a monotonic integer per capability is the minimal stable form.

const VERSION_RE = /^[0-9]+$/;

export function isValidVersion(v: string): boolean {
  if (typeof v !== "string") return false;
  if (!VERSION_RE.test(v)) return false;
  // Reject leading zeros ("01") so 1 and 01 cannot be two different versions.
  if (v.length > 1 && v.startsWith("0")) return false;
  // Guard against absurdly large version strings.
  if (v.length > 10) return false;
  return true;
}

export function validateVersion(v: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw invalidVersion("empty", "version is required");
  }
  if (!VERSION_RE.test(v)) {
    throw invalidVersion("malformed", "version must be a positive integer string (e.g. '1', '2')");
  }
  if (v.length > 1 && v.startsWith("0")) {
    throw invalidVersion("leading_zero", "version must not have leading zeros");
  }
  if (v.length > 10) {
    throw invalidVersion("too_long", "version is unrealistically large");
  }
  return v;
}

// ---- Shared error factory --------------------------------------------

function invalidId(reason: string, message: string): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "capability.id.invalid",
    message,
    retryable: false,
    details: { reason, field: "capability_id" },
  });
}

function invalidVersion(reason: string, message: string): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "capability.version.invalid",
    message,
    retryable: false,
    details: { reason, field: "version" },
  });
}
