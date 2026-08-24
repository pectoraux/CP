// tests/auth/password.test.ts — scrypt password hashing (WORK-003 §13).
// Pure-function tests: no DB. Security properties:
//   - hash/verify round-trip succeeds
//   - wrong password fails
//   - hash is not plaintext (does not contain the password)
//   - constant-time (different salts produce different hashes for the same
//     password — the salt is random per call)
//   - malformed stored hash throws (never silently accepts)
import { describe, expect, it } from "bun:test";
import {
  hashPassword,
  verifyPasswordHash,
  verifyDummyPassword,
} from "@cp/auth";

describe("password hashing (scrypt)", () => {
  it("verifies a correct password against its hash", () => {
    const { value } = hashPassword("correct horse battery staple");
    expect(verifyPasswordHash("correct horse battery staple", value)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const { value } = hashPassword("correct horse battery staple");
    expect(verifyPasswordHash("wrong password", value)).toBe(false);
  });

  it("never stores the plaintext in the hash", () => {
    const pw = "super-secret-12345";
    const { value } = hashPassword(pw);
    expect(value.includes(pw)).toBe(false);
    // The hash is the cp1$scrypt$... format, not the plaintext.
    expect(value.startsWith("cp1$scrypt$")).toBe(true);
  });

  it("uses a random salt per call (same password → different hashes)", () => {
    const a = hashPassword("same-password").value;
    const b = hashPassword("same-password").value;
    expect(a).not.toBe(b);
  });

  it("rejects empty plaintext", () => {
    expect(() => hashPassword("")).toThrow();
    expect(verifyPasswordHash("", hashPassword("x").value)).toBe(false);
  });

  it("throws on a malformed stored hash", () => {
    expect(() => verifyPasswordHash("x", "not-a-real-hash")).toThrow();
    expect(() => verifyPasswordHash("x", "cp1$scrypt$bad")).toThrow();
  });

  it("verifyDummyPassword always returns false (unknown-user timing equalization)", () => {
    expect(verifyDummyPassword("any-password")).toBe(false);
    expect(verifyDummyPassword("another-attempt")).toBe(false);
  });
});
