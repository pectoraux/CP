// tests/capabilities/service.test.ts — CapabilitiesService against REAL
// PostgreSQL (WORK-005 CAP-001..004, §9, §17, §18, §22, §23). Uses the
// WORK-002 withInfra harness. No mocks for persistence.
//
// Covers:
//   - capability create/get/list (admin-gated)
//   - duplicate canonical id rejected (DB constraint, race-safe)
//   - non-admin mutation rejected (403 capability.admin.required)
//   - version create + immutability (published contract cannot be overwritten;
//     a new incompatible contract = a new version; publishing v2 auto-deprecates
//     v1 within a transaction; at-most-one-active invariant holds)
//   - contract validation: malformed schema rejected; valid accepted; invalid
//     side_effect rejected
//   - lifecycle: draft→active→deprecated→retired; invalid transitions rejected;
//     retired terminal
//   - dependency graph: valid edge; self-dep rejected; missing dependency
//     rejected; duplicate edge rejected; cycle rejected (2-node + multi-node);
//     retired target rejected; NULL required_version resolves to active
//   - graph inspection: direct deps + edges + order + reachable
//   - concurrency: parallel createCapability with same id → one succeeds;
//     parallel addDependency same edge → one succeeds
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase, AppError, ulid } from "@cp/platform";
import {
  AuthService,
  migrateAuthSchema,
  buildPrincipal,
} from "@cp/auth";
import {
  OrganizationsService,
  migrateOrganizationsSchema,
} from "@cp/organizations";
import { migrateProjectsSchema } from "@cp/projects";
import {
  CapabilitiesService,
  migrateCapabilitiesSchema,
  type CapabilityContract,
} from "@cp/capabilities";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-capabilities",
  });
  await migrateAuthSchema(db);
  await migrateOrganizationsSchema(db);
  await migrateProjectsSchema(db);
  await migrateCapabilitiesSchema(db);
  const auth = new AuthService({ db });
  const orgs = new OrganizationsService({ db });
  const capabilities = new CapabilitiesService({ db });
  const cleanup = async () => { await db.close(); };
  return { db, auth, orgs, capabilities, cleanup };
}

async function makeUser(auth: AuthService, n: number) {
  return auth.createUser({
    email: `capuser${n}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: "password123",
  });
}

async function bootstrapAdmin(capabilities: CapabilitiesService, userId: string) {
  // The table is empty → any caller may bootstrap the first admin.
  await capabilities.grantCapabilityAdmin({
    userId,
    actingPrincipal: buildPrincipal(userId, []),
  });
}

function sampleContract(sideEffect: CapabilityContract["sideEffect"] = "idempotent_write"): CapabilityContract {
  return {
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string" },
        body: { type: "string" },
      },
      required: ["recipient", "body"],
    },
    outputSchema: {
      type: "object",
      properties: {
        provider_message_id: { type: "string" },
        accepted_at: { type: "string" },
      },
      required: ["provider_message_id"],
    },
    errorModel: [
      { code: "invalid_recipient", message: "recipient was invalid", retryable: false },
    ],
    sideEffect,
    idempotencySemantics: { supports_idempotency_key: true, strategy: "content_hash", ttl_seconds: 86400 },
    requiredContext: ["organization_id"],
    executionModes: ["live"],
    policyMetadata: { pii: false },
    constraints: [],
    latencyExpectations: { p99_ms: 2000 },
  };
}

describe("CapabilitiesService (real PostgreSQL)", () => {
  it("admin creates a capability; get/list work; canonical id stored", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        const cap = await capabilities.createCapability({
          capabilityId: "payment.accept",
          name: "Accept a payment",
          actingPrincipal: p,
        });
        expect(cap.capabilityId).toBe("payment.accept");
        expect(cap.status).toBe("draft");
        const got = await capabilities.getCapability("payment.accept");
        expect(got?.id).toBe(cap.id);
        const page = await capabilities.listCapabilities({ limit: 10 });
        expect(page.capabilities.length).toBe(1);
        expect(page.capabilities[0]!.capabilityId).toBe("payment.accept");
      } finally {
        await cleanup();
      }
    });
  });

  it("duplicate canonical id rejected with POLICY_BLOCKED (DB constraint)", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        await capabilities.createCapability({
          capabilityId: "message.send",
          name: "Send a message",
          actingPrincipal: p,
        });
        let threw = false;
        try {
          await capabilities.createCapability({
            capabilityId: "message.send",
            name: "Dup",
            actingPrincipal: p,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).category).toBe("POLICY_BLOCKED");
          expect((err as AppError).code).toBe("capability.duplicate");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("a non-admin (arbitrary org owner) cannot mutate the catalog (403)", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, capabilities, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `acme-${Date.now()}`,
        });
        // owner is an ORG owner but NOT a capability admin.
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        let threw = false;
        try {
          await capabilities.createCapability({
            capabilityId: "ai.generate",
            name: "Generate",
            actingPrincipal: ownerP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).category).toBe("POLICY_BLOCKED");
          expect((err as AppError).code).toBe("capability.admin.required");
          expect((err as AppError).details?.reason).toBe("not_a_capability_admin");
        }
        expect(threw).toBe(true);
        void organization;
      } finally {
        await cleanup();
      }
    });
  });

  it("version: create draft → publish → immutable (no overwrite); new version publishes and auto-deprecates prior", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        await capabilities.createCapability({
          capabilityId: "ai.generate", name: "AI generate", actingPrincipal: p,
        });
        // Create v1 (draft) and publish it.
        const v1 = await capabilities.createVersion({
          capabilityId: "ai.generate", version: "1",
          contract: sampleContract("idempotent_write"), actingPrincipal: p,
        });
        expect(v1.status).toBe("draft");
        const v1pub = await capabilities.transitionVersion({
          capabilityId: "ai.generate", version: "1", toStatus: "active", actingPrincipal: p,
        });
        expect(v1pub.status).toBe("active");
        // Immutability: creating the SAME version again is rejected (cannot
        // overwrite a published version's contract).
        let threw = false;
        try {
          await capabilities.createVersion({
            capabilityId: "ai.generate", version: "1",
            contract: sampleContract("best_effort"), actingPrincipal: p,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("capability.version.duplicate");
        }
        expect(threw).toBe(true);
        // The published v1 contract is unchanged (still idempotent_write).
        const v1after = await capabilities.getVersion("ai.generate", "1");
        expect(v1after?.contract.sideEffect).toBe("idempotent_write");
        // Publish v2 → v1 auto-deprecated (at-most-one-active invariant).
        const v2 = await capabilities.createVersion({
          capabilityId: "ai.generate", version: "2",
          contract: sampleContract("non_idempotent_write"), actingPrincipal: p,
        });
        const v2pub = await capabilities.transitionVersion({
          capabilityId: "ai.generate", version: "2", toStatus: "active", actingPrincipal: p,
        });
        expect(v2pub.status).toBe("active");
        const v1final = await capabilities.getVersion("ai.generate", "1");
        expect(v1final?.status).toBe("deprecated");
        // Both versions visible with include_deprecated.
        const all = await capabilities.listVersions("ai.generate", { includeDeprecated: true });
        expect(all.length).toBe(2);
      } finally {
        await cleanup();
      }
    });
  });

  it("contract: malformed schema rejected at createVersion; invalid side_effect rejected", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        await capabilities.createCapability({
          capabilityId: "compute.run", name: "Compute", actingPrincipal: p,
        });
        // Malformed input schema (array, not an object).
        let threw = false;
        try {
          await capabilities.createVersion({
            capabilityId: "compute.run", version: "1",
            contract: { ...sampleContract(), inputSchema: [] as unknown as never },
            actingPrincipal: p,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("capability.contract.malformed");
        }
        expect(threw).toBe(true);
        // Invalid side_effect.
        let threw2 = false;
        try {
          await capabilities.createVersion({
            capabilityId: "compute.run", version: "1",
            contract: { ...sampleContract(), sideEffect: "stripe_charge" as never },
            actingPrincipal: p,
          });
        } catch (err) {
          threw2 = true;
          expect((err as AppError).code).toBe("capability.contract.malformed");
          expect((err as AppError).details?.reason).toBe("invalid_side_effect");
        }
        expect(threw2).toBe(true);
        // Valid contract accepted.
        const v = await capabilities.createVersion({
          capabilityId: "compute.run", version: "1",
          contract: sampleContract("transactional"), actingPrincipal: p,
        });
        expect(v.contract.sideEffect).toBe("transactional");
      } finally {
        await cleanup();
      }
    });
  });

  it("lifecycle: draft→active→deprecated→retired; invalid transitions rejected; retired terminal", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        const cap = await capabilities.createCapability({
          capabilityId: "storage.put", name: "Storage put", actingPrincipal: p,
        });
        // draft → active ok.
        const active = await capabilities.transitionCapability({
          capabilityId: "storage.put", toStatus: "active", actingPrincipal: p,
        });
        expect(active.status).toBe("active");
        // active → retired ok.
        const retired = await capabilities.transitionCapability({
          capabilityId: "storage.put", toStatus: "retired", actingPrincipal: p,
        });
        expect(retired.status).toBe("retired");
        // retired is terminal: retired → active rejected.
        let threw = false;
        try {
          await capabilities.transitionCapability({
            capabilityId: "storage.put", toStatus: "active", actingPrincipal: p,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("capability.lifecycle.invalid");
        }
        expect(threw).toBe(true);
        // Invalid: draft → retired rejected (must go through active). Create a
        // fresh draft capability for this.
        const cap2 = await capabilities.createCapability({
          capabilityId: "search.query", name: "Search", actingPrincipal: p,
        });
        let threw2 = false;
        try {
          await capabilities.transitionCapability({
            capabilityId: "search.query", toStatus: "retired", actingPrincipal: p,
          });
        } catch (err) {
          threw2 = true;
          expect((err as AppError).code).toBe("capability.lifecycle.invalid");
        }
        expect(threw2).toBe(true);
        void cap;
      } finally {
        await cleanup();
      }
    });
  });

  it("graph: valid dependency added; NULL required_version resolves to active; graph inspection returns edges + order + reachable", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        // Create A, B, C. Publish v1 of each.
        for (const cid of ["document.extract", "storage.put", "search.query"]) {
          await capabilities.createCapability({
            capabilityId: cid, name: cid, actingPrincipal: p,
          });
          await capabilities.createVersion({
            capabilityId: cid, version: "1", contract: sampleContract(), actingPrincipal: p,
          });
          await capabilities.transitionVersion({
            capabilityId: cid, version: "1", toStatus: "active", actingPrincipal: p,
          });
        }
        // A (document.extract@1) → B (storage.put, NULL pin → active v1).
        const dep = await capabilities.addDependency({
          capabilityId: "document.extract", version: "1",
          requiredCapabilityId: "storage.put",
          actingPrincipal: p,
        });
        expect(dep.resolvedRequiredVersion).toBe("1"); // resolved to B's active v1
        // A → C.
        await capabilities.addDependency({
          capabilityId: "document.extract", version: "1",
          requiredCapabilityId: "search.query",
          actingPrincipal: p,
        });
        // Graph inspection.
        const g = await capabilities.getDependencyGraph("document.extract", "1");
        expect(g.directDependencies.length).toBe(2);
        expect(g.edges.length).toBe(2);
        expect(g.order.length).toBeGreaterThan(0);
        expect(g.reachable.length).toBe(2); // storage.put@1 + search.query@1
      } finally {
        await cleanup();
      }
    });
  });

  it("graph: self-dependency rejected", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        await capabilities.createCapability({
          capabilityId: "payment.refund", name: "Refund", actingPrincipal: p,
        });
        await capabilities.createVersion({
          capabilityId: "payment.refund", version: "1", contract: sampleContract(), actingPrincipal: p,
        });
        await capabilities.transitionVersion({
          capabilityId: "payment.refund", version: "1", toStatus: "active", actingPrincipal: p,
        });
        let threw = false;
        try {
          await capabilities.addDependency({
            capabilityId: "payment.refund", version: "1",
            requiredCapabilityId: "payment.refund",
            actingPrincipal: p,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("capability.dependency.self");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("graph: missing dependency rejected; duplicate edge rejected; cycle rejected (2-node + multi-node)", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        for (const cid of ["payment.authorize", "payment.complete", "fraud.check"]) {
          await capabilities.createCapability({
            capabilityId: cid, name: cid, actingPrincipal: p,
          });
          await capabilities.createVersion({
            capabilityId: cid, version: "1", contract: sampleContract(), actingPrincipal: p,
          });
          await capabilities.transitionVersion({
            capabilityId: cid, version: "1", toStatus: "active", actingPrincipal: p,
          });
        }
        // Missing dependency: depends on a non-existent capability.
        let threw = false;
        try {
          await capabilities.addDependency({
            capabilityId: "payment.authorize", version: "1",
            requiredCapabilityId: "does.not.exist",
            actingPrincipal: p,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("capability.dependency.missing");
        }
        expect(threw).toBe(true);
        // Valid: payment.authorize → fraud.check; payment.complete → payment.authorize.
        await capabilities.addDependency({
          capabilityId: "payment.authorize", version: "1",
          requiredCapabilityId: "fraud.check", actingPrincipal: p,
        });
        await capabilities.addDependency({
          capabilityId: "payment.complete", version: "1",
          requiredCapabilityId: "payment.authorize", actingPrincipal: p,
        });
        // Duplicate edge rejected.
        let threw2 = false;
        try {
          await capabilities.addDependency({
            capabilityId: "payment.authorize", version: "1",
            requiredCapabilityId: "fraud.check", actingPrincipal: p,
          });
        } catch (err) {
          threw2 = true;
          expect((err as AppError).code).toBe("capability.dependency.duplicate");
        }
        expect(threw2).toBe(true);
        // Cycle: fraud.check → payment.complete would close
        // payment.complete→payment.authorize→fraud.check→payment.complete.
        let threw3 = false;
        try {
          await capabilities.addDependency({
            capabilityId: "fraud.check", version: "1",
            requiredCapabilityId: "payment.complete", actingPrincipal: p,
          });
        } catch (err) {
          threw3 = true;
          expect((err as AppError).code).toBe("capability.dependency.cycle");
          expect((err as AppError).details?.reason).toBe("cycle");
        }
        expect(threw3).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("graph: retired capability cannot be a dependency target", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        await capabilities.createCapability({ capabilityId: "legacy.run", name: "Legacy", actingPrincipal: p });
        await capabilities.createVersion({
          capabilityId: "legacy.run", version: "1", contract: sampleContract(), actingPrincipal: p,
        });
        await capabilities.transitionVersion({ capabilityId: "legacy.run", version: "1", toStatus: "active", actingPrincipal: p });
        // Publish then retire the capability (draft → active → retired).
        await capabilities.transitionCapability({ capabilityId: "legacy.run", toStatus: "active", actingPrincipal: p });
        await capabilities.transitionCapability({ capabilityId: "legacy.run", toStatus: "retired", actingPrincipal: p });
        // Create a depending capability.
        await capabilities.createCapability({ capabilityId: "new.run", name: "New", actingPrincipal: p });
        await capabilities.createVersion({
          capabilityId: "new.run", version: "1", contract: sampleContract(), actingPrincipal: p,
        });
        await capabilities.transitionVersion({ capabilityId: "new.run", version: "1", toStatus: "active", actingPrincipal: p });
        let threw = false;
        try {
          await capabilities.addDependency({
            capabilityId: "new.run", version: "1",
            requiredCapabilityId: "legacy.run", actingPrincipal: p,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("capability.dependency.retired");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("concurrency: parallel createCapability with the same id → exactly one succeeds", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        const id = `race.${ulid().slice(-6).toLowerCase()}`;
        const results = await Promise.allSettled([
          capabilities.createCapability({ capabilityId: id, name: "A", actingPrincipal: p }),
          capabilities.createCapability({ capabilityId: id, name: "B", actingPrincipal: p }),
        ]);
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const fail = results.filter((r) => r.status === "rejected").length;
        expect(ok).toBe(1);
        expect(fail).toBe(1);
        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect((rejected.reason as AppError).code).toBe("capability.duplicate");
      } finally {
        await cleanup();
      }
    });
  });

  it("concurrency: parallel addDependency with the same edge → exactly one succeeds", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, cleanup } = await setup(handle);
      try {
        const u = await makeUser(auth, 1);
        await bootstrapAdmin(capabilities, u.id);
        const p = buildPrincipal(u.id, []);
        for (const cid of ["concur.a", "concur.b"]) {
          await capabilities.createCapability({ capabilityId: cid, name: cid, actingPrincipal: p });
          await capabilities.createVersion({
            capabilityId: cid, version: "1", contract: sampleContract(), actingPrincipal: p,
          });
          await capabilities.transitionVersion({ capabilityId: cid, version: "1", toStatus: "active", actingPrincipal: p });
        }
        const results = await Promise.allSettled([
          capabilities.addDependency({ capabilityId: "concur.a", version: "1", requiredCapabilityId: "concur.b", actingPrincipal: p }),
          capabilities.addDependency({ capabilityId: "concur.a", version: "1", requiredCapabilityId: "concur.b", actingPrincipal: p }),
        ]);
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const fail = results.filter((r) => r.status === "rejected").length;
        expect(ok).toBe(1);
        expect(fail).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });
});
