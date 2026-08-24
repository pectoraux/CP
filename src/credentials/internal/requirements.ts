// /credentials/internal/requirements.ts
// Provider credential REQUIREMENT metadata (WORK-006, architecture §2.17,
// §30, §36). This is the DECLARATION side of the credentials boundary:
// a provider records WHICH credentials it requires; the actual secret
// VALUES are stored and accessed through a separate secret-access boundary
// (the tenant/connection layer, WORK-010) and NEVER appear in provider
// rows, capability contracts, API responses, or logs.
//
// The /credentials module owns "secret access boundary and provider
// credential metadata" (architecture §36). WORK-006 delivers the
// requirement vocabulary + validation used by /providers; the concrete
// tenant-scoped credential storage and revocation belong to WORK-010
// (connections) and are intentionally NOT implemented here.

/**
 * The kinds of credential a provider adapter may require. The kind drives
 * how the future connection layer validates and presents the secret to the
 * adapter (e.g. an api_key becomes a provider-specific header; an
 * hmac_secret is used for request signing). Kinds are provider-neutral —
 * provider-specific details (which header, which signing scheme) live
 * inside the adapter, never in this vocabulary.
 */
export type CredentialKind =
  | "api_key"
  | "bearer_token"
  | "basic_username_password"
  | "hmac_secret"
  | "oauth_client_credentials";

export const CREDENTIAL_KINDS: readonly CredentialKind[] = [
  "api_key",
  "bearer_token",
  "basic_username_password",
  "hmac_secret",
  "oauth_client_credentials",
] as const;

export function isCredentialKind(v: string): v is CredentialKind {
  return (CREDENTIAL_KINDS as readonly string[]).includes(v);
}

/**
 * A single credential requirement declared by a provider adapter.
 * This is metadata: it names the secret the adapter needs and why —
 * it never contains the secret itself.
 */
export interface CredentialRequirement {
  /** Machine name used to resolve the secret at invocation time. */
  name: string;
  kind: CredentialKind;
  /** Human-facing explanation of what this credential is used for. */
  description?: string;
  /** Optional capability-scoped permissions the credential grants. */
  scopes?: string[];
  /** Whether the adapter can operate without it (rare; e.g. public APIs). */
  optional?: boolean;
}

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Validate a credential-requirement list. Returns a list of problems
 * (empty list = valid). Enforces:
 *   - non-empty list items with valid kind
 *   - name is a lowercase identifier (letter-first, [a-z0-9_], ≤64 chars)
 *   - names are unique within the list
 *   - scopes (when present) are non-empty strings
 */
export function validateCredentialRequirements(
  requirements: unknown,
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(requirements)) {
    return ["credential requirements must be an array"];
  }
  if (requirements.length === 0) {
    problems.push("credential requirements must declare at least one requirement");
  }
  const seen = new Set<string>();
  for (const raw of requirements) {
    if (raw === null || typeof raw !== "object") {
      problems.push("each credential requirement must be an object");
      continue;
    }
    const req = raw as Record<string, unknown>;
    const name = typeof req.name === "string" ? req.name : "";
    if (!NAME_RE.test(name)) {
      problems.push(
        `credential requirement name must be a lowercase identifier (letter-first, [a-z0-9_], <=64 chars); got "${name}"`,
      );
      continue;
    }
    if (seen.has(name)) {
      problems.push(`duplicate credential requirement name "${name}"`);
      continue;
    }
    seen.add(name);
    if (typeof req.kind !== "string" || !isCredentialKind(req.kind)) {
      problems.push(
        `credential requirement "${name}" has invalid kind "${String(req.kind)}" (expected one of ${CREDENTIAL_KINDS.join("|")})`,
      );
    }
    if (
      req.description !== undefined &&
      (typeof req.description !== "string" || req.description.length > 512)
    ) {
      problems.push(`credential requirement "${name}" description must be a string <=512 chars`);
    }
    if (req.scopes !== undefined) {
      if (
        !Array.isArray(req.scopes) ||
        req.scopes.some((s) => typeof s !== "string" || s.length === 0)
      ) {
        problems.push(`credential requirement "${name}" scopes must be an array of non-empty strings`);
      }
    }
    if (req.optional !== undefined && typeof req.optional !== "boolean") {
      problems.push(`credential requirement "${name}" optional must be a boolean`);
    }
  }
  return problems;
}
