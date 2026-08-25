// tests/connections/service.test.ts — ConnectionsService against REAL
// PostgreSQL + REAL Minio (WORK-010 §32 CONNECTIONS + PROVIDER
// COMPATIBILITY + TENANCY + CONCURRENCY). Proves:
//   - create/get/list/update/revoke lifecycle; duplicate constraints
//   - activation GATED on verification (a connection never becomes active
//     merely because it exists)
//   - provider/capability compatibility validation (unknown provider,
//     revoked provider, unsupported capability/version)
//   - configuration validation (secret-ish keys rejected, bounded)
//   - credential attach/detach via the /credentials boundary (connection
//     stores ONLY the reference; rotation revokes the old credential)
//   - structural verification (credential complete/kind-compatible; no
//     provider execution)
//   - TENANCY: cross-org/cross-project rejected; suspended member loses
//     access; member reads but cannot mutate
//   - CONCURRENCY: duplicate connection creation resolves via DB uniqueness
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { AppError } from "@cp/platform";
import {
  setupConnections,
  makeTenant,
  seedEchoOffering,
  TEST_MASTER_KEY_HEX,
} from "./helpers.ts";

async function expectRejected(code: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    expect((err as AppError).code).toBe(code);
  }
  expect(threw).toBe(true);
}

describe("ConnectionsService (real PostgreSQL + real Minio)", () => {
  it("lifecycle: create (draft) → attach credential → verify → activate → pause → revoke; activation gated on verification", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-conn-lifecycle" });
      try {
        await seedEchoOffering(ctx);
        const tenant = await makeTenant(ctx, "lc");

        // Create: starts as draft (never active merely by existing).
        const conn = await ctx.connections.createConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          providerId: "demo.echo",
          capabilityId: "demo.echo", capabilityVersion: "1",
          environment: "production",
          label: "prod connection",
          configuration: { region: "eu-west", default_currency: "GHS" },
          actingPrincipal: tenant.adminP,
        });
        expect(conn.status).toBe("draft");
        expect(conn.providerId).toBe("demo.echo");
        expect(conn.capabilityCanonicalId).toBe("demo.echo");
        expect(conn.credentialConfigured).toBe(false);

        // Activation REFUSED before verification.
        await expectRejected("connection.activation.unverified", () =>
          ctx.connections.transitionConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            connectionId: conn.id, toStatus: "active", actingPrincipal: tenant.adminP,
          }),
        );

        // Verification without a credential FAILS (the provider requires one).
        let verified = await ctx.connections.verifyConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id, actingPrincipal: tenant.adminP,
        });
        expect(verified.verificationResult!.passed).toBe(false);
        expect(verified.verificationResult!.checks.find((c) => c.checkId === "credential.configured")!.result).toBe("fail");

        // Attach the credential (kind must match the declared api_key).
        await expectRejected("connection.credential.kind_mismatch", () =>
          ctx.connections.attachCredential({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            connectionId: conn.id, kind: "bearer_token", name: "wrong-kind",
            secret: "s", actingPrincipal: tenant.adminP,
          }),
        );
        const withCred = await ctx.connections.attachCredential({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id, kind: "api_key", name: "primary",
          secret: "prod-secret-value", actingPrincipal: tenant.adminP,
        });
        expect(withCred.credentialConfigured).toBe(true);
        expect(withCred.credentialKind).toBe("api_key");
        // The connection row carries only the opaque reference.
        expect(withCred.credentialId).toMatch(/^cred_/);

        // Verify again → passes → activate works.
        verified = await ctx.connections.verifyConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id, actingPrincipal: tenant.adminP,
        });
        expect(verified.verificationResult!.passed).toBe(true);
        const active = await ctx.connections.transitionConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id, toStatus: "active", actingPrincipal: tenant.adminP,
        });
        expect(active.status).toBe("active");

        // pause → active (re-activation still requires the recorded verification).
        const paused = await ctx.connections.transitionConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id, toStatus: "paused", actingPrincipal: tenant.adminP,
        });
        expect(paused.status).toBe("paused");
        // Invalidate: detach the credential + re-verify → fails.
        const detached = await ctx.connections.detachCredential({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id, actingPrincipal: tenant.adminP,
        });
        expect(detached.credentialConfigured).toBe(false);
        const reVerified = await ctx.connections.verifyConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id, actingPrincipal: tenant.adminP,
        });
        expect(reVerified.verificationResult!.passed).toBe(false);

        // revoke terminal.
        const revoked = await ctx.connections.transitionConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id, toStatus: "revoked", actingPrincipal: tenant.adminP,
        });
        expect(revoked.status).toBe("revoked");
        await expectRejected("connection.transition.invalid", () =>
          ctx.connections.transitionConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            connectionId: conn.id, toStatus: "active", actingPrincipal: tenant.adminP,
          }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("duplicate constraints: same (project, provider, environment) rejected; different environments coexist", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-conn-dup" });
      try {
        await seedEchoOffering(ctx);
        const tenant = await makeTenant(ctx, "dup");
        await ctx.connections.createConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          providerId: "demo.echo", environment: "production",
          actingPrincipal: tenant.adminP,
        });
        await expectRejected("connection.duplicate", () =>
          ctx.connections.createConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            providerId: "demo.echo", environment: "production",
            actingPrincipal: tenant.adminP,
          }),
        );
        // A sandbox connection for the same provider coexists (§14).
        const sandbox = await ctx.connections.createConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          providerId: "demo.echo", environment: "sandbox",
          actingPrincipal: tenant.adminP,
        });
        expect(sandbox.environment).toBe("sandbox");
        // Another project may have its own production connection.
        const tenantB = await makeTenant(ctx, "dupb");
        const other = await ctx.connections.createConnection({
          organizationId: tenantB.organizationId, projectId: tenantB.projectId,
          providerId: "demo.echo", environment: "production",
          actingPrincipal: tenantB.adminP,
        });
        expect(other.id).not.toBe(sandbox.id);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("provider compatibility: unknown provider / revoked provider / unsupported capability / unsupported version rejected", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-conn-compat" });
      try {
        await seedEchoOffering(ctx);
        const tenant = await makeTenant(ctx, "compat");

        // Unknown provider.
        await expectRejected("connection.provider.unknown", () =>
          ctx.connections.createConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            providerId: "ghost.provider", actingPrincipal: tenant.adminP,
          }),
        );
        // Revoked provider.
        await ctx.providers.createProvider({
          providerId: "dead.provider", name: "Dead", actingPrincipal: ctx.platformAdminP,
        });
        await ctx.providers.transitionProvider({
          providerId: "dead.provider", toStatus: "revoked", actingPrincipal: ctx.platformAdminP,
        });
        await expectRejected("connection.provider.revoked", () =>
          ctx.connections.createConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            providerId: "dead.provider", actingPrincipal: tenant.adminP,
          }),
        );
        // Unknown capability.
        await expectRejected("connection.capability.unknown", () =>
          ctx.connections.createConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            providerId: "demo.echo", capabilityId: "missing.capability", capabilityVersion: "1",
            actingPrincipal: tenant.adminP,
          }),
        );
        // Unknown version.
        await expectRejected("connection.capability.version_unknown", () =>
          ctx.connections.createConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "9",
            actingPrincipal: tenant.adminP,
          }),
        );
        // Provider does not declare this capability at all (the capability
        // and version exist — the DECLARATION is what fails).
        await ctx.capabilities.createCapability({
          capabilityId: "other.thing", name: "Other", actingPrincipal: ctx.platformAdminP,
        });
        await ctx.capabilities.transitionCapability({
          capabilityId: "other.thing", toStatus: "active", actingPrincipal: ctx.platformAdminP,
        });
        await ctx.capabilities.createVersion({
          capabilityId: "other.thing", version: "1", contract: {
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            errorModel: [],
            sideEffect: "pure",
            idempotencySemantics: { supports_idempotency_key: false },
            requiredContext: [],
            executionModes: ["live"],
            policyMetadata: {},
            constraints: [],
            latencyExpectations: {},
          },
          actingPrincipal: ctx.platformAdminP,
        });
        await expectRejected("connection.capability.unsupported", () =>
          ctx.connections.createConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            providerId: "demo.echo", capabilityId: "other.thing", capabilityVersion: "1",
            actingPrincipal: tenant.adminP,
          }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("configuration validation: secret-ish keys rejected; depth/size bounded; updates apply", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-conn-config" });
      try {
        await seedEchoOffering(ctx);
        const tenant = await makeTenant(ctx, "cfg");
        // Secret-ish keys rejected outright (§13).
        for (const badKey of ["api_key", "secret", "password", "private_key", "refresh_token"]) {
          await expectRejected("connection.validation", () =>
            ctx.connections.createConnection({
              organizationId: tenant.organizationId, projectId: tenant.projectId,
              providerId: "demo.echo",
              configuration: { [badKey]: "value" },
              actingPrincipal: tenant.adminP,
            }),
          );
        }
        // Nested secret-ish keys also rejected.
        await expectRejected("connection.validation", () =>
          ctx.connections.createConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            providerId: "demo.echo",
            configuration: { auth: { password: "x" } },
            actingPrincipal: tenant.adminP,
          }),
        );
        // Create with valid config, then update.
        const conn = await ctx.connections.createConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          providerId: "demo.echo",
          configuration: { webhook_mode: "async", limits: { qps: 100 } },
          actingPrincipal: tenant.adminP,
        });
        const updated = await ctx.connections.updateConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id,
          label: "renamed",
          configuration: { webhook_mode: "sync" },
          actingPrincipal: tenant.adminP,
        });
        expect(updated.label).toBe("renamed");
        expect(updated.configuration).toEqual({ webhook_mode: "sync" });
        // Deeply nested config rejected.
        await expectRejected("connection.validation", () =>
          ctx.connections.updateConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            connectionId: conn.id,
            configuration: { a: { b: { c: { d: { e: 1 } } } } },
            actingPrincipal: tenant.adminP,
          }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("credential rotation via attach: old credential revoked, connection identity stable", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-conn-rotate" });
      try {
        await seedEchoOffering(ctx);
        const tenant = await makeTenant(ctx, "rot");
        const conn = await ctx.connections.createConnection({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          actingPrincipal: tenant.adminP,
        });
        const first = await ctx.connections.attachCredential({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id, kind: "api_key", name: "v1-cred",
          secret: "first-secret", actingPrincipal: tenant.adminP,
        });
        const firstCredId = first.credentialId!;
        const second = await ctx.connections.attachCredential({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          connectionId: conn.id, kind: "api_key", name: "v2-cred",
          secret: "second-secret", actingPrincipal: tenant.adminP,
        });
        // Identity stable, reference switched.
        expect(second.id).toBe(conn.id);
        expect(second.credentialId).not.toBe(firstCredId);
        expect(second.credentialConfigured).toBe(true);
        // The OLD credential is revoked (never resolvable — even through
        // the adapter resolver capability).
        const oldMeta = await ctx.credentials.getMetadata(tenant.projectId, firstCredId);
        expect(oldMeta?.status).toBe("revoked");
        await expectRejected("credential.revoked", () =>
          ctx.adapterResolver.resolve({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            credentialId: firstCredId,
          }),
        );
        // The NEW credential resolves via the adapter resolver capability
        // (the ONLY path that returns secret material).
        const resolved = await ctx.adapterResolver.resolve({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          credentialId: second.credentialId!,
        });
        expect(resolved.value).toBe("second-secret");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("TENANCY: cross-org/cross-project rejected; member reads but cannot mutate; suspended member loses access", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-conn-tenant" });
      try {
        await seedEchoOffering(ctx);
        const tenantA = await makeTenant(ctx, "tna");
        const tenantB = await makeTenant(ctx, "tnb");
        const conn = await ctx.connections.createConnection({
          organizationId: tenantA.organizationId, projectId: tenantA.projectId,
          providerId: "demo.echo", actingPrincipal: tenantA.adminP,
        });
        // Cross-org: org B's admin cannot even establish scope against
        // org A's project — the project does not belong to org B, so the
        // defense-in-depth scope check throws (no leak either way).
        await expectRejected("connection.project.not_found", () =>
          ctx.connections.getConnection(
            tenantB.organizationId, tenantA.projectId, conn.id, tenantB.adminP,
          ).then((c) => { void c; }),
        );
        // Cross-project within the same org: does not resolve.
        const otherProject = await ctx.projects.createProject({
          organizationId: tenantA.organizationId, name: "Other", slug: `other-${Date.now()}`,
          createdByUserId: tenantA.ownerUserId, actingPrincipal: tenantA.ownerP,
        });
        expect(
          await ctx.connections.getConnection(
            tenantA.organizationId, otherProject.id, conn.id, tenantA.adminP,
          ),
        ).toBeNull();
        // Non-member mutation refused.
        await expectRejected("connection.membership.required", () =>
          ctx.connections.createConnection({
            organizationId: tenantA.organizationId, projectId: tenantA.projectId,
            providerId: "demo.echo", environment: "intrusion",
            actingPrincipal: tenantB.adminP,
          }),
        );
        // MEMBER can read/list but cannot mutate.
        const read = await ctx.connections.getConnection(
          tenantA.organizationId, tenantA.projectId, conn.id, tenantA.memberP,
        );
        expect(read?.id).toBe(conn.id);
        const page = await ctx.connections.listConnections(
          tenantA.organizationId, tenantA.projectId, tenantA.memberP, {},
        );
        expect(page.connections.length).toBe(1);
        await expectRejected("connection.role.required", () =>
          ctx.connections.createConnection({
            organizationId: tenantA.organizationId, projectId: tenantA.projectId,
            providerId: "demo.echo", environment: "member-made",
            actingPrincipal: tenantA.memberP,
          }),
        );
        // Suspended member loses access entirely.
        await ctx.orgs.updateMembershipState({
          organizationId: tenantA.organizationId, userId: tenantA.memberUserId,
          status: "suspended", actingPrincipal: tenantA.ownerP,
        });
        const suspendedP = await ctx.orgs.buildPrincipalForUser(tenantA.memberUserId);
        await expectRejected("connection.membership.required", () =>
          ctx.connections.getConnection(
            tenantA.organizationId, tenantA.projectId, conn.id, suspendedP,
          ).then((c) => { void c; }),
        );
        // Removed member likewise.
        await ctx.orgs.updateMembershipState({
          organizationId: tenantA.organizationId, userId: tenantA.memberUserId,
          status: "removed", actingPrincipal: tenantA.ownerP,
        });
        const removedP = await ctx.orgs.buildPrincipalForUser(tenantA.memberUserId);
        await expectRejected("connection.membership.required", () =>
          ctx.connections.getConnection(
            tenantA.organizationId, tenantA.projectId, conn.id, removedP,
          ).then((c) => { void c; }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("CONCURRENCY: duplicate connection creation resolves via DB uniqueness (exactly one wins)", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupConnections(handle, { applicationName: "cp-test-conn-conc" });
      try {
        await seedEchoOffering(ctx);
        const tenant = await makeTenant(ctx, "conc");
        // Warm the pool so the inserts genuinely overlap.
        await Promise.all([
          ctx.credentials.getMetadata(tenant.projectId, "warmup"),
          ctx.credentials.getMetadata(tenant.projectId, "warmup"),
          ctx.credentials.getMetadata(tenant.projectId, "warmup"),
          ctx.credentials.getMetadata(tenant.projectId, "warmup"),
        ]);
        const results = await Promise.allSettled([
          ctx.connections.createConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            providerId: "demo.echo", environment: "production",
            actingPrincipal: tenant.adminP,
          }),
          ctx.connections.createConnection({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            providerId: "demo.echo", environment: "production",
            actingPrincipal: tenant.adminP,
          }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
        expect(results.filter((r) => r.status === "rejected").length).toBe(1);
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
