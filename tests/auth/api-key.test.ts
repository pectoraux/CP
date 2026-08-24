// tests/auth/api-key.test.ts — opaque API key generation + hashing
// (WORK-003 §13, §14). Pure-function tests: no DB.
//   - generateApiKey returns {id, rawKey, keyHash}
//   - raw key has the cpkey_ prefix and a delimiter
//   - keyHash is the SHA-256 hex of the raw key
//   - parseApiKeyId extracts the public id from a raw key
//   - malformed keys parse to null (never throw)
//   - two generated keys are unique
//   - constant-time hex compare works
import { describe, expect, it } from "bun:test";
import {
  generateApiKey,
  hashApiKey,
  parseApiKeyId,
  constantTimeHexEqual,
} from "@cp/auth";
import { createHash } from "node:crypto";

describe("api key generation + verification", () => {
  it("generates a well-formed key with cpkey_ prefix and delimiter", () => {
    const { id, rawKey, keyHash } = generateApiKey();
    expect(id.startsWith("key_")).toBe(true);
    expect(rawKey.startsWith("cpkey_")).toBe(true);
    expect(rawKey.includes(".")).toBe(true);
    // The id portion (after cpkey_ and before .) is the ULID.
    const ulidPart = rawKey.slice("cpkey_".length).split(".")[0];
    expect(id).toBe(`key_${ulidPart}`);
    // keyHash is 64 hex chars (SHA-256).
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keyHash is the SHA-256 of the raw key", () => {
    const { rawKey, keyHash } = generateApiKey();
    const expected = createHash("sha256").update(rawKey, "utf8").digest("hex");
    expect(keyHash).toBe(expected);
  });

  it("parseApiKeyId extracts the public id from a raw key", () => {
    const { id, rawKey } = generateApiKey();
    expect(parseApiKeyId(rawKey)).toBe(id);
  });

  it("parseApiKeyId returns null for malformed keys (never throws)", () => {
    expect(parseApiKeyId("")).toBeNull();
    expect(parseApiKeyId("not-a-key")).toBeNull();
    expect(parseApiKeyId("cpkey_no_delimiter")).toBeNull();
    expect(parseApiKeyId("cpkey_.secret-only")).toBeNull();
    expect(parseApiKeyId("cpkey_BADULID.secret")).toBeNull();
  });

  it("two generated keys are unique", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.id).not.toBe(b.id);
    expect(a.rawKey).not.toBe(b.rawKey);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it("constantTimeHexEqual: equal hashes match; different do not", () => {
    const a = hashApiKey("cpkey_01H.test1");
    const b = hashApiKey("cpkey_01H.test1");
    const c = hashApiKey("cpkey_01H.test2");
    expect(constantTimeHexEqual(a, b)).toBe(true);
    expect(constantTimeHexEqual(a, c)).toBe(false);
    expect(constantTimeHexEqual(a, "")).toBe(false);
  });
});
