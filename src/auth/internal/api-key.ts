// /auth/internal/api-key.ts
// Opaque API key generation, hashing, and verification (architecture
// WORK-003 §13, §14, §2.17). API keys are long-lived bearer credentials
// used for programmatic access. The raw key is returned to the caller
// EXACTLY ONCE at creation time; only the SHA-256 hash is persisted. A DB
// compromise does not yield usable keys.
//
// Format: `cpkey_<ulid>.<secret>` where:
//   - `cpkey_` is a recognizable prefix (safe to grep for in logs/accidental commits)
//   - `<ulid>` (26 chars) is the public identifier stored in `cp_api_keys.id`
//     and used for O(1) lookup by id-prefix
//   - `.` is a delimiter
//   - `<secret>` (32 chars base32) is the random secret material
//
// Verification: split the key, look up by id, SHA-256 the full raw key,
// constant-time compare to the stored hash. This means the secret is never
// stored and never indexed.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "cpkey_";
const SECRET_LEN = 20; // 160 bits of entropy in base32 ≈ 32 chars

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

function randomBase32(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += B32[bytes[i]! % B32.length];
  }
  return out;
}

// ULID regex (Crockford base32, 26 chars, first char 0-7 for time sort).
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface GeneratedApiKey {
  /** Public identifier (stored in cp_api_keys.id), e.g. `key_01H...`. */
  id: string;
  /** The full raw key returned ONCE to the caller, e.g. `cpkey_01H....<secret>`. */
  rawKey: string;
  /** SHA-256 hex of `rawKey`, stored in cp_api_keys.key_hash. */
  keyHash: string;
}

function newUlid(): string {
  // Reuse the platform ULID generator's approach (timestamp + random).
  const now = Date.now();
  const ENCODING = B32;
  let ts = Math.floor(now);
  let timePart = "";
  for (let i = 9; i >= 0; i--) {
    const mod = ts % ENCODING.length;
    timePart = ENCODING[mod]! + timePart;
    ts = Math.floor(ts / ENCODING.length);
  }
  const randPart = randomBase32(16);
  return timePart + randPart;
}

/**
 * Generate a new opaque API key. Returns the public id, the raw key (shown
 * once), and the hash to persist. The id is prefixed `key_` so it is
 * distinguishable from other ULID-prefixed identifiers in the system.
 */
export function generateApiKey(): GeneratedApiKey {
  const ulid = newUlid();
  if (!ULID_RE.test(ulid)) {
    // Should never happen; guards against a future change to newUlid.
    throw new Error("generateApiKey: internal ULID generation failed");
  }
  const id = `key_${ulid}`;
  const secret = randomBase32(SECRET_LEN);
  const rawKey = `${KEY_PREFIX}${ulid}.${secret}`;
  const keyHash = hashApiKey(rawKey);
  return { id, rawKey, keyHash };
}

/**
 * Hash a raw API key with SHA-256 and return the hex digest. The hash is
 * what is stored in `cp_api_keys.key_hash` and indexed for lookup.
 */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/**
 * Parse a raw API key and return its public id (the ULID portion), without
 * verifying the secret. Returns `null` if the key is structurally invalid
 * (wrong prefix, missing delimiter, malformed ULID). Never throws.
 */
export function parseApiKeyId(rawKey: string): string | null {
  if (typeof rawKey !== "string" || rawKey.length === 0) return null;
  if (!rawKey.startsWith(KEY_PREFIX)) return null;
  const rest = rawKey.slice(KEY_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const ulid = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!ULID_RE.test(ulid) || secret.length === 0) return null;
  return `key_${ulid}`;
}

/**
 * Constant-time comparison of two equal-length hex strings. Returns false
 * if lengths differ (and thus is not perfectly constant across length
 * differences, but the hash length is fixed by SHA-256 so this never varies
 * in practice for legitimate stored hashes).
 */
export function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}
