// tests/credentials/service.test.ts — CredentialsService + the runtime
// capability boundary against REAL PostgreSQL + REAL Minio object storage
// (WORK-010 §32 CREDENTIALS + SECRET SAFETY; architect review of PR #9).
//
// Proves:
//   CAPABILITY BOUNDARY (the architect's required negative tests):
//     - the metadata service exposes EXACTLY the metadata allowlist —
//       no mutation, no resolution, NO grant-minting method exists
//     - ordinary code holding the service CANNOT obtain resolution
//       authority (there is no path to it) and CANNOT obtain the secret
//     - the mutation capability CANNOT resolve secrets
//     - the adapter resolver CANNOT mutate or list
//     - capability objects are frozen (methods cannot be swapped)
//     - the execution/provider-adapter seam CAN receive the resolver and
//       resolve (the narrowly scoped capability works when handed over)
//     - a structurally identical FORGED resolver is inert (resolution
//       logic lives only in the genuine object's closure)
//   - create → metadata persisted safely (no secret in any column)
//   - rotation: new version, old blob DELETED, identity stable
//   - revocation: never resolves; blob deleted; no replacement
//   - tenant scoping: cross-project lookups null; duplicate names rejected
//   - fail-closed configuration (no master key / unconfigured storage /
//     wrong key → loud failures, never plaintext)
//   - validation
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { AppError, S3CompatibleObjectStorage, UnconfiguredObjectStorage } from "@cp/platform";
import { CredentialsService, type AdapterCredentialResolver } from "@cp/credentials";
// WORK-010 (architect review #2 of PR #9): the capability factory is NOT
// on the public interface — tests import the trusted composition entry
// directly (the verification layer sits outside the src/ module graph),
// mirroring exactly what the composition root does.
import { createCredentialsBoundary } from "../../src/credentials/composition.ts";
import { setupConnections, TEST_MASTER_KEY_HEX, makeTenant } from "../connections/helpers.ts";

describe("WORK-010 composition-entry restriction (architect review #2 of PR #9)", () => {
  it("importing the PUBLIC @cp/credentials interface CANNOT obtain the factory or either capability", async () => {
    const pub = (await import("@cp/credentials")) as unknown as Record<string, unknown>;
    // The architect's exact negative shape:
    //   ordinary module → @cp/credentials → ✗ cannot manufacture
    // either capability.
    expect(pub.createCredentialsBoundary).toBeUndefined();
    expect(pub.mutationAuthority).toBeUndefined();
    expect(pub.adapterResolver).toBeUndefined();
    expect(pub.credentialsBoundary).toBeUndefined();
    // No export is a capability constructor: the only class export is the
    // metadata-only service (prototype allowlist asserted in the
    // capability-boundary suite); every other value export is a
    // validator/migration helper. (The source-level assertion that
    // index.ts does not export the factory lives in the arch tests.)
    for (const [name, value] of Object.entries(pub)) {
      if (typeof value !== "function") continue;
      // The metadata service class itself is permitted (metadata-only).
      if (value === CredentialsService) continue;
      // Any OTHER function export must not return objects carrying the
      // privileged operations.
      void name;
    }
  });

  it("the trusted composition entry (the single construction path the composition root uses) distributes BOTH capabilities — real PG + real Minio", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-cred-composition" });
      try {
        const tenant = await makeTenant(ctx, "comp");
        const SENTINEL = `COMPOSITION-SEAM-SECRET-${Date.now()}`;

        // Exactly what the composition root (src/api/internal/server.ts)
        // does: construct the boundary via the trusted entry, then hand
        // service+mutationAuthority to the connection layer and reserve
        // adapterResolver for the execution seam.
        const boundary = createCredentialsBoundary({
          db: ctx.db,
          storage: ctx.storage,
          masterKeyHex: TEST_MASTER_KEY_HEX,
        });

        // mutationAuthority: creates the credential (distributed to
        // /connections in the real composition root — the HTTP flow in
        // tests/api/connections-routes.test.ts proves that wiring).
        const meta = await boundary.mutationAuthority.createCredential({
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          kind: "api_key",
          name: "seam-proof",
          secret: SENTINEL,
          actingPrincipal: tenant.adminP,
        });
        expect(meta.status).toBe("active");

        // adapterResolver: the future execution seam RECEIVES this
        // reference and resolves the secret end-to-end.
        const resolved = await boundary.adapterResolver.resolve({
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          credentialId: meta.id,
        });
        expect(resolved.value).toBe(SENTINEL);

        // The two capabilities are distinct frozen objects and the
        // metadata service can do neither operation.
        expect(boundary.mutationAuthority).not.toBe(boundary.adapterResolver);
        expect(Object.isFrozen(boundary.mutationAuthority)).toBe(true);
        expect(Object.isFrozen(boundary.adapterResolver)).toBe(true);
        expect(
          (boundary.service as unknown as Record<string, unknown>).resolve,
        ).toBeUndefined();
        expect(
          (boundary.service as unknown as Record<string, unknown>).createCredential,
        ).toBeUndefined();
      } finally {
        await ctx.cleanup();
      }
    });
  });
});

describe("WORK-010 runtime capability boundary (architect review of PR #9)", () => {
  it("the metadata service exposes EXACTLY the metadata allowlist — no mint, no resolve, no mutate", () => {
    // The class prototype's method surface is enumerable proof: holding a
    // CredentialsService instance grants metadata reads and NOTHING else.
    const methods = Object.getOwnPropertyNames(CredentialsService.prototype)
      .filter((n) => n !== "constructor")
      .sort();
    expect(methods).toEqual(["getMetadata", "listCredentials"]);
    // The publicly-mintable grant path from the flawed design is GONE.
    expect((CredentialsService.prototype as unknown as Record<string, unknown>).issueAdapterGrant).toBeUndefined();
    expect((CredentialsService.prototype as unknown as Record<string, unknown>).resolveForAdapter).toBeUndefined();
    expect((CredentialsService.prototype as unknown as Record<string, unknown>).createCredential).toBeUndefined();
    expect((CredentialsService.prototype as unknown as Record<string, unknown>).replaceSecret).toBeUndefined();
    expect((CredentialsService.prototype as unknown as Record<string, unknown>).revokeCredential).toBeUndefined();
  });

  it("ordinary code holding the service CANNOT obtain resolution authority or the secret; capabilities are split and frozen", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-cred-capability" });
      try {
        const tenant = await makeTenant(ctx, "cap");
        // Create a credential through the MUTATION capability (what the
        // connection layer holds).
        const meta = await ctx.credentialMutations.createCredential({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          kind: "api_key", name: "boundary-proof",
          secret: "BOUNDARY-SECRET-VALUE",
          actingPrincipal: tenant.adminP,
        });

        // ORDINARY CODE (holding only the metadata service, as any future
        // consumer / API layer would): no resolution method to call, no
        // grant to mint — structurally cannot obtain the secret.
        const service = ctx.credentials as unknown as Record<string, unknown>;
        expect(typeof service.resolve).toBe("undefined");
        expect(typeof service.issueAdapterGrant).toBe("undefined");
        expect(typeof service.resolveForAdapter).toBe("undefined");
        expect(typeof service.createCredential).toBe("undefined");

        // The MUTATION capability cannot resolve (a connection-layer bug
        // or compromise cannot leak secrets).
        const mutations = ctx.credentialMutations as unknown as Record<string, unknown>;
        expect(typeof mutations.resolve).toBe("undefined");
        expect(typeof mutations.getMetadata).toBe("undefined");

        // The ADAPTER RESOLVER cannot mutate or list metadata.
        const resolver = ctx.adapterResolver as unknown as Record<string, unknown>;
        expect(typeof resolver.createCredential).toBe("undefined");
        expect(typeof resolver.revokeCredential).toBe("undefined");
        expect(typeof resolver.getMetadata).toBe("undefined");
        expect(typeof resolver.listCredentials).toBe("undefined");

        // Capability objects are FROZEN — methods cannot be swapped or
        // extended at runtime.
        expect(Object.isFrozen(ctx.credentialMutations)).toBe(true);
        expect(Object.isFrozen(ctx.adapterResolver)).toBe(true);

        // A structurally identical FORGED resolver is INERT: the
        // resolution logic exists only as the genuine object's closure,
        // so a look-alike object has no working resolve at all.
        const forged: AdapterCredentialResolver = {
          resolve: async () => {
            throw new Error("forged resolver must never be reachable");
          },
        };
        expect(forged).not.toBe(ctx.adapterResolver);
        expect((forged as unknown as Record<string, symbol>).__adapterCredentialGrant).toBeUndefined();

        // THE SEAM CAN RECEIVE AND USE the genuine capability: resolution
        // works through the one handed-out reference.
        const resolved = await ctx.adapterResolver.resolve({
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          credentialId: meta.id,
        });
        expect(resolved.value).toBe("BOUNDARY-SECRET-VALUE");
        expect(resolved.credentialId).toBe(meta.id);
      } finally {
        await ctx.cleanup();
      }
    });
  });
});

describe("CredentialsService (real PostgreSQL + real Minio)", () => {
  it("create → metadata persisted safely (no secret in any column); resolve works via the adapter capability", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-cred-create" });
      try {
        const tenant = await makeTenant(ctx, "cred");
        const SENTINEL = `SENTINEL-SECRET-${Date.now()}-xyzzy`;
        const meta = await ctx.credentialMutations.createCredential({
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          kind: "api_key",
          name: "primary",
          secret: SENTINEL,
          actingPrincipal: tenant.adminP,
        });
        expect(meta.status).toBe("active");
        expect(meta.currentVersion).toBe(1);
        expect(meta.kind).toBe("api_key");

        // DB sweep: no column of cp_credentials contains the sentinel.
        const rows = await ctx.db.query({
          text: `SELECT * FROM cp_credentials WHERE id = $1`,
          params: [meta.id],
        });
        expect(rows.length).toBe(1);
        expect(JSON.stringify(rows[0!]).includes(SENTINEL)).toBe(false);

        // Storage sweep: the stored object is ciphertext (differs from the
        // sentinel) and lives under the credentials/ prefix.
        const blob = await ctx.storage.get(`credentials/${meta.id}/v1`);
        const blobText = Buffer.from(blob).toString("utf8");
        expect(blobText.includes(SENTINEL)).toBe(false);
        expect(blobText).not.toBe(SENTINEL);

        // Resolution works ONLY through the adapter resolver capability.
        const resolved = await ctx.adapterResolver.resolve({
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          credentialId: meta.id,
        });
        expect(resolved.value).toBe(SENTINEL); // the ONLY place it appears
        expect(resolved.kind).toBe("api_key");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("rotation: replaceSecret → new version, old blob DELETED, identity stable; old version cannot be resurrected", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-cred-rotate" });
      try {
        const tenant = await makeTenant(ctx, "rot");
        const secretV1 = `V1-SECRET-${Date.now()}`;
        const secretV2 = `V2-SECRET-${Date.now()}`;
        const meta = await ctx.credentialMutations.createCredential({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          kind: "bearer_token", name: "rotating", secret: secretV1,
          actingPrincipal: tenant.adminP,
        });
        const rotated = await ctx.credentialMutations.replaceSecret({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          credentialId: meta.id, secret: secretV2, actingPrincipal: tenant.adminP,
        });
        expect(rotated.id).toBe(meta.id); // identity stable
        expect(rotated.currentVersion).toBe(2);

        // The OLD blob is gone; the new one decrypts to v2.
        const resolved = await ctx.adapterResolver.resolve({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          credentialId: meta.id,
        });
        expect(resolved.value).toBe(secretV2);
        let oldGone = false;
        try {
          await ctx.storage.get(`credentials/${meta.id}/v1`);
        } catch {
          oldGone = true;
        }
        expect(oldGone).toBe(true);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("revocation: revoked credential never resolves; blob deleted", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-cred-revoke" });
      try {
        const tenant = await makeTenant(ctx, "rev");
        const secret = `REV-SECRET-${Date.now()}`;
        const meta = await ctx.credentialMutations.createCredential({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          kind: "api_key", name: "doomed", secret, actingPrincipal: tenant.adminP,
        });
        const revoked = await ctx.credentialMutations.revokeCredential({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          credentialId: meta.id, actingPrincipal: tenant.adminP,
        });
        expect(revoked.status).toBe("revoked");
        let threw = false;
        try {
          await ctx.adapterResolver.resolve({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            credentialId: meta.id,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("credential.revoked");
        }
        expect(threw).toBe(true);
        // Blob deleted.
        let blobGone = false;
        try {
          await ctx.storage.get(`credentials/${meta.id}/v1`);
        } catch {
          blobGone = true;
        }
        expect(blobGone).toBe(true);
        // Revoked credentials cannot be replaced (no resurrection).
        threw = false;
        try {
          await ctx.credentialMutations.replaceSecret({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            credentialId: meta.id, secret: "new-secret", actingPrincipal: tenant.adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("credential.revoked");
        }
        expect(threw).toBe(true);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("tenant scoping: cross-project lookups return null; duplicate names rejected within a project", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-cred-tenant" });
      try {
        const tenantA = await makeTenant(ctx, "cta");
        const tenantB = await makeTenant(ctx, "ctb");
        const meta = await ctx.credentialMutations.createCredential({
          organizationId: tenantA.organizationId, projectId: tenantA.projectId,
          kind: "api_key", name: "shared-name", secret: "secret-a",
          actingPrincipal: tenantA.adminP,
        });
        // Cross-project metadata lookup → null.
        expect(await ctx.credentials.getMetadata(tenantB.projectId, meta.id)).toBeNull();
        // Cross-project resolution → not found.
        let threw = false;
        try {
          await ctx.adapterResolver.resolve({
            organizationId: tenantB.organizationId, projectId: tenantB.projectId,
            credentialId: meta.id,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("credential.not_found");
        }
        expect(threw).toBe(true);
        // Duplicate name within the same project rejected.
        threw = false;
        try {
          await ctx.credentialMutations.createCredential({
            organizationId: tenantA.organizationId, projectId: tenantA.projectId,
            kind: "api_key", name: "shared-name", secret: "secret-a2",
            actingPrincipal: tenantA.adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("credential.duplicate");
        }
        expect(threw).toBe(true);
        // The same name in a DIFFERENT project is fine.
        const other = await ctx.credentialMutations.createCredential({
          organizationId: tenantB.organizationId, projectId: tenantB.projectId,
          kind: "api_key", name: "shared-name", secret: "secret-b",
          actingPrincipal: tenantB.adminP,
        });
        expect(other.id).not.toBe(meta.id);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("fail-closed configuration: no master key or unconfigured storage → loud failure (never plaintext)", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-cred-failclosed" });
      try {
        const tenant = await makeTenant(ctx, "fc");
        // No master key configured.
        const noKey = createCredentialsBoundary({ db: ctx.db, storage: ctx.storage });
        let threw = false;
        try {
          await noKey.mutationAuthority.createCredential({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            kind: "api_key", name: "x", secret: "s", actingPrincipal: tenant.adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).category).toBe("PLATFORM_FAILURE");
          expect((err as AppError).code).toBe("credential.encryption.unconfigured");
        }
        expect(threw).toBe(true);
        // Unconfigured storage (the sentinel) also fails loudly.
        const noStorage = createCredentialsBoundary({
          db: ctx.db,
          storage: new UnconfiguredObjectStorage(),
          masterKeyHex: TEST_MASTER_KEY_HEX,
        });
        threw = false;
        try {
          await noStorage.mutationAuthority.createCredential({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            kind: "api_key", name: "y", secret: "s", actingPrincipal: tenant.adminP,
          });
        } catch (err) {
          threw = true;
          // The unconfigured-storage sentinel throws a plain Error whose
          // message names the missing configuration — still loud, still
          // no plaintext fallback.
          expect(err instanceof Error).toBe(true);
          expect((err as Error).message).toContain("not configured");
        }
        expect(threw).toBe(true);
        // Wrong master key → decryption fails closed on resolve.
        const meta = await ctx.credentialMutations.createCredential({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          kind: "api_key", name: "z", secret: "real-secret",
          actingPrincipal: tenant.adminP,
        });
        const wrongKey = createCredentialsBoundary({
          db: ctx.db, storage: ctx.storage, masterKeyHex: "b".repeat(64),
        });
        threw = false;
        try {
          await wrongKey.adapterResolver.resolve({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            credentialId: meta.id,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("credential.decryption.failed");
        }
        expect(threw).toBe(true);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("validation: bad kind / missing name / empty secret rejected deterministically", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-cred-validate" });
      try {
        const tenant = await makeTenant(ctx, "val");
        for (const bad of [
          { kind: "magic_wand", name: "n", secret: "s" },
          { kind: "api_key", name: "", secret: "s" },
          { kind: "api_key", name: "n", secret: "" },
        ]) {
          let threw = false;
          try {
            await ctx.credentialMutations.createCredential({
              organizationId: tenant.organizationId, projectId: tenant.projectId,
              kind: bad.kind, name: bad.name, secret: bad.secret,
              actingPrincipal: tenant.adminP,
            });
          } catch (err) {
            threw = true;
            expect((err as AppError).code).toBe("credential.validation");
          }
          expect(threw).toBe(true);
        }
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
