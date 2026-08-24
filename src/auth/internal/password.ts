// /auth/internal/password.ts
// Password hashing and verification using Node's built-in `crypto.scrypt`
// (architecture WORK-003 §13: "Prefer an established, maintained
// cryptographic implementation. Do not invent cryptography."). scrypt is a
// modern, memory-hard password hashing KDF, part of the Node.js standard
// library — no external dependency, no arch-check concern.
//
// The stored format is `cp1$scrypt$N$r$p$saltB64$hashB64` so it is
// self-describing (versioned, parameterized) and can be migrated later.
//
// Security properties:
//   - salt is unique per password (32 random bytes)
//   - parameters are tunable (defaults: N=2^17, r=8, p=1 — ~128 MiB memory)
//   - verification is constant-time (`timingSafeEqual`)
//   - plaintext is never logged, never returned through any API
//   - unknown-user path runs a dummy hash comparison so that a login attempt
//     against a non-existent email has the same observable timing as a wrong
//     password attempt (mitigates account enumeration via timing)

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 1 << 17; // CPU/memory cost
const SCRYPT_R = 8; // block size
const SCRYPT_P = 1; // parallelism
const SCRYPT_DKLEN = 32; // derived key length
const SALT_LEN = 32;
const FORMAT_VERSION = "cp1";

export interface PasswordHash {
  /** Full stored string, e.g. `cp1$scrypt$131072$8$1$<saltB64>$<hashB64>`. */
  value: string;
}

function b64(buf: Buffer): string {
  return buf.toString("base64");
}

/**
 * Hash a plaintext password into the stored `cp1$scrypt$...` format.
 * The salt is randomly generated per call.
 */
export function hashPassword(plaintext: string): PasswordHash {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("hashPassword: plaintext must be a non-empty string");
  }
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(plaintext, salt, SCRYPT_DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
  const value = `${FORMAT_VERSION}$scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64(salt)}$${b64(hash)}`;
  return { value };
}

/**
 * Verify a plaintext password against a stored `cp1$scrypt$...` hash.
 * Returns `true` on match, `false` otherwise. Constant-time comparison.
 * Throws on a malformed hash (a malformed hash should never be in the DB).
 */
export function verifyPasswordHash(plaintext: string, stored: string): boolean {
  if (typeof plaintext !== "string" || plaintext.length === 0) return false;
  if (typeof stored !== "string" || stored.length === 0) return false;
  const parts = stored.split("$");
  // cp1$scrypt$N$r$p$saltB64$hashB64
  if (parts.length !== 7 || parts[0] !== FORMAT_VERSION || parts[1] !== "scrypt") {
    throw new Error(`verifyPasswordHash: malformed stored hash (expected ${FORMAT_VERSION}$scrypt$...)`);
  }
  const N = Number(parts[2]);
  const r = Number(parts[3]);
  const p = Number(parts[4]);
  const saltB64 = parts[5];
  const hashB64 = parts[6];
  if (saltB64 === undefined || hashB64 === undefined) {
    throw new Error(`verifyPasswordHash: malformed stored hash (expected ${FORMAT_VERSION}$scrypt$...)`);
  }
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    throw new Error("verifyPasswordHash: malformed scrypt parameters");
  }
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const computed = scryptSync(plaintext, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

/**
 * A pre-computed dummy hash used to equalize timing on the unknown-user path
 * (run a real comparison that will always fail, instead of returning
 * immediately). Reuses the standard format so the code path is identical.
 */
const DUMMY_HASH = hashPassword("__cp_dummy_user_never_matches__").value;

/**
 * Run a dummy verification that always returns false but takes the same
 * shape as a real verification. Used when a user lookup returns no row, so
 * the response time of an invalid-email login matches a wrong-password login.
 */
export function verifyDummyPassword(plaintext: string): boolean {
  return verifyPasswordHash(plaintext, DUMMY_HASH);
}
