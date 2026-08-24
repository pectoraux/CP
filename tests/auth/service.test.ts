// tests/auth/service.test.ts — AuthService against REAL PostgreSQL
// (WORK-003 §17 AUTHENTICATION). Uses the WORK-002 withInfra harness that
// spawns a real PostgreSQL 17 on a random port. No mocks for persistence.
//
// Covers:
//   - valid authentication succeeds
//   - invalid credentials fail
//   - duplicate email fails (DB unique constraint, not silent)
//   - API key issuance + verification + revocation
//   - expired key fails
//   - malformed key fails safely
//   - disabled user fails
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase, AppError } from "@cp/platform";
import {
  AuthService,
  migrateAuthSchema,
  hashPassword,
  verifyPasswordHash,
} from "@cp/auth";

async function setupAuth(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-auth",
  });
  await migrateAuthSchema(db);
  const auth = new AuthService({ db });
  return { db, auth, async cleanup() { await db.close(); } };
}

describe("AuthService (real PostgreSQL)", () => {
  it("creates a user and verifies the password credential", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        const email = `alice-${Date.now()}@example.com`;
        const user = await auth.createUser({ email, password: "password123" });
        expect(user.id.startsWith("usr_")).toBe(true);
        expect(user.email).toBe(email);
        expect(user.status).toBe("active");

        const verified = await auth.verifyPasswordCredential({
          email,
          password: "password123",
        });
        expect(verified.userId).toBe(user.id);
      } finally {
        await cleanup();
      }
    });
  });

  it("rejects a wrong password with CREDENTIAL_FAILURE", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        const email = `bob-${Date.now()}@example.com`;
        await auth.createUser({ email, password: "password123" });
        await expect(
          auth.verifyPasswordCredential({ email, password: "wrong-password" }),
        ).rejects.toMatchObject({
          category: "CREDENTIAL_FAILURE",
        });
      } finally {
        await cleanup();
      }
    });
  });

  it("rejects an unknown email with the SAME CREDENTIAL_FAILURE (no enumeration)", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        // No user created for this email.
        await expect(
          auth.verifyPasswordCredential({
            email: `nobody-${Date.now()}@example.com`,
            password: "password123",
          }),
        ).rejects.toMatchObject({
          category: "CREDENTIAL_FAILURE",
        });
      } finally {
        await cleanup();
      }
    });
  });

  it("rejects a duplicate email (DB unique constraint → CREDENTIAL_FAILURE)", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        const email = `dup-${Date.now()}@example.com`;
        await auth.createUser({ email, password: "password123" });
        await expect(
          auth.createUser({ email, password: "password456" }),
        ).rejects.toMatchObject({
          category: "CREDENTIAL_FAILURE",
        });
      } finally {
        await cleanup();
      }
    });
  });

  it("issues an API key, verifies it, and revokes it", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        const email = `carol-${Date.now()}@example.com`;
        const user = await auth.createUser({ email, password: "password123" });
        const { rawKey, record } = await auth.createApiKey({
          userId: user.id,
          name: "test-key",
        });
        expect(rawKey.startsWith("cpkey_")).toBe(true);
        expect(record.userId).toBe(user.id);

        // Verification succeeds.
        const verified = await auth.verifyApiKey(rawKey);
        expect(verified.userId).toBe(user.id);
        expect(verified.keyId).toBe(record.id);

        // Revoke.
        await auth.revokeApiKey(record.id);
        // Now verification fails with CREDENTIAL_FAILURE.
        await expect(auth.verifyApiKey(rawKey)).rejects.toMatchObject({
          category: "CREDENTIAL_FAILURE",
        });
      } finally {
        await cleanup();
      }
    });
  });

  it("rejects an expired API key", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        const email = `dave-${Date.now()}@example.com`;
        const user = await auth.createUser({ email, password: "password123" });
        const { rawKey, record } = await auth.createApiKey({
          userId: user.id,
          expiresAt: new Date(Date.now() - 1000), // already expired
        });
        await expect(auth.verifyApiKey(rawKey)).rejects.toMatchObject({
          category: "CREDENTIAL_FAILURE",
        });
        // last_used_at should NOT be updated for an expired key.
        const keys = await auth.listApiKeys(user.id);
        expect(keys.find((k) => k.id === record.id)?.lastUsedAt).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });

  it("rejects a malformed API key safely (CREDENTIAL_FAILURE)", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        await expect(auth.verifyApiKey("not-a-real-key")).rejects.toMatchObject({
          category: "CREDENTIAL_FAILURE",
        });
        await expect(auth.verifyApiKey("")).rejects.toMatchObject({
          category: "CREDENTIAL_FAILURE",
        });
      } finally {
        await cleanup();
      }
    });
  });

  it("rejects a disabled user's API key", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        const email = `eve-${Date.now()}@example.com`;
        const user = await auth.createUser({ email, password: "password123" });
        const { rawKey } = await auth.createApiKey({ userId: user.id });
        // Disable the user.
        await auth.disableUser(user.id);
        await expect(auth.verifyApiKey(rawKey)).rejects.toMatchObject({
          category: "CREDENTIAL_FAILURE",
        });
      } finally {
        await cleanup();
      }
    });
  });

  it("listApiKeys returns keys without raw key material", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        const email = `frank-${Date.now()}@example.com`;
        const user = await auth.createUser({ email, password: "password123" });
        const { rawKey } = await auth.createApiKey({
          userId: user.id,
          name: "k1",
        });
        const keys = await auth.listApiKeys(user.id);
        expect(keys.length).toBe(1);
        // The raw key must never appear in the listing.
        const serialized = JSON.stringify(keys);
        expect(serialized.includes(rawKey)).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  it("password hash round-trips via the service (not plaintext in DB)", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        const pw = "very-secret-password-999";
        const email = `gina-${Date.now()}@example.com`;
        const user = await auth.createUser({ email, password: pw });
        // Read the raw row to confirm the hash is stored, not the plaintext.
        const rows = await db.query({
          text: "SELECT password_hash FROM cp_users WHERE id = $1",
          params: [user.id],
        });
        const stored = rows[0]?.password_hash as string;
        expect(stored.startsWith("cp1$scrypt$")).toBe(true);
        expect(stored.includes(pw)).toBe(false);
        expect(verifyPasswordHash(pw, stored)).toBe(true);
        // The exported hashPassword is the same primitive the service uses.
        void hashPassword;
      } finally {
        await cleanup();
      }
    });
  });

  it("rejects a weak password (< 8 chars) with CREDENTIAL_FAILURE", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        await expect(
          auth.createUser({
            email: `weak-${Date.now()}@example.com`,
            password: "short",
          }),
        ).rejects.toMatchObject({ category: "CREDENTIAL_FAILURE" });
      } finally {
        await cleanup();
      }
    });
  });

  it("AppError is the thrown type (distinguishable failure model)", async () => {
    await withInfra(async (handle) => {
      const { db, auth, cleanup } = await setupAuth(handle);
      try {
        try {
          await auth.verifyPasswordCredential({
            email: `x-${Date.now()}@example.com`,
            password: "whatever123",
          });
          throw new Error("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(AppError);
          expect((err as AppError).category).toBe("CREDENTIAL_FAILURE");
          expect((err as AppError).code).toBe("auth.credential");
        }
      } finally {
        await cleanup();
      }
    });
  });
});
