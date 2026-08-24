// tests/providers/registry.test.ts — ProvidersService against REAL
// PostgreSQL (WORK-006 §24 registry tests). Uses the WORK-002 withInfra
// harness; no mocks for persistence.
//
// Covers:
//   - create provider (admin-gated) / get / list
//   - duplicate provider rejected (DB constraint, race-safe)
//   - invalid provider ids rejected (uppercase, whitespace, empty segments)
//   - non-admin mutation rejected (provider.admin.required)
//   - lifecycle transitions: valid path, invalid transitions rejected,
//     evidence gates (contract_tested needs verified declarations;
//     certified needs a certified implementation), revoked terminal
//   - declare capability: valid (with adapter consistency), duplicate
//     rejected, unknown capability rejected, unknown version rejected,
//     retired version rejected, adapter mismatch rejected, credential
//     requirements persisted from the adapter descriptor
//   - revoked provider cannot declare
//   - concurrency: parallel createProvider with same id → one succeeds
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase, AppError } from "@cp/platform";
import {
  AuthService,
  migrateAuthSchema,
  buildPrincipal,
} from "@cp/auth";
import { migrateOrganizationsSchema } from "@cp/organizations";
import { migrateProjectsSchema } from "@cp/projects";
import {
  CapabilitiesService,
  migrateCapabilitiesSchema,
  type CapabilityContract,
} from "@cp/capabilities";
import {
  ProvidersService,
  migrateProvidersSchema,
  createDefaultAdapterRegistry,
  DEMO_ECHO_PROVIDER_ID,
} from "@cp/providers";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-providers-registry",
  });
  await migrateAuthSchema(db);
  await migrateOrganizationsSchema(db);
  await migrateProjectsSchema(db);
  await migrateCapabilitiesSchema(db);
  await migrateProvidersSchema(db);
  const auth = new AuthService({ db });
  const capabilities = new CapabilitiesService({ db });
  const providers = new ProvidersService({
    db,
    capabilities,
    adapters: createDefaultAdapterRegistry(),
  });
  const cleanup = async () => { await db.close(); };
  return { db, auth, capabilities, providers, cleanup };
}

async function makeAdmin(auth: AuthService, capabilities: CapabilitiesService, n: number) {
  const u = await auth.createUser({
    email: `provadmin${n}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: "password123",
  });
  // Deployment-authority bootstrap (WORK-005 review): grant the first
  // capability admin through the operator path, not the tenant API.
  await capabilities.bootstrapCapabilityAdmin({ userId: u.id });
  return buildPrincipal(u.id, []);
}

async function makeUser(auth: AuthService, n: number) {
  const u = await auth.createUser({
    email: `provuser${n}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: "password123",
  });
  return buildPrincipal(u.id, []);
}

const SAMPLE_CONTRACT: CapabilityContract = {
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  outputSchema: {
    type: "object",
    properties: {
      echoed: { type: "string" },
      echo_id: { type: "string" },
      echoed_at: { type: "string" },
    },
    required: ["echoed", "echo_id", "echoed_at"],
  },
  errorModel: [],
  sideEffect: "pure",
  idempotencySemantics: { supports_idempotency_key: false },
  requiredContext: [],
  executionModes: ["live"],
  policyMetadata: {},
  constraints: [],
  latencyExpectations: {},
};

/** Create the demo.echo capability + active version 1 (catalog side). */
async function seedEchoCapability(
  capabilities: CapabilitiesService,
  adminP: ReturnType<typeof buildPrincipal>,
) {
  await capabilities.createCapability({
    capabilityId: "demo.echo",
    name: "Echo",
    actingPrincipal: adminP,
  });
  await capabilities.transitionCapability({
    capabilityId: "demo.echo",
    toStatus: "active",
    actingPrincipal: adminP,
  });
  await capabilities.createVersion({
    capabilityId: "demo.echo",
    version: "1",
    contract: SAMPLE_CONTRACT,
    actingPrincipal: adminP,
  });
  await capabilities.transitionVersion({
    capabilityId: "demo.echo",
    version: "1",
    toStatus: "active",
    actingPrincipal: adminP,
  });
}

describe("ProvidersService registry (real PostgreSQL)", () => {
  it("admin creates a provider; get/list work; canonical id stored", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities, 1);
        const p = await providers.createProvider({
          providerId: DEMO_ECHO_PROVIDER_ID,
          name: "Echo Demo Provider",
          description: "deterministic fixture",
          actingPrincipal: adminP,
        });
        expect(p.providerId).toBe("demo.echo");
        expect(p.status).toBe("discovered");
        expect(p.integrationPath).toBe("platform_operated");
        const got = await providers.getProvider("demo.echo");
        expect(got?.id).toBe(p.id);
        const page = await providers.listProviders({ limit: 10 });
        expect(page.providers.length).toBe(1);
        expect(page.nextCursor).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });

  it("duplicate provider rejected (DB constraint); invalid ids rejected", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities, 1);
        await providers.createProvider({
          providerId: "dup.provider",
          name: "First",
          actingPrincipal: adminP,
        });
        let threw = false;
        try {
          await providers.createProvider({
            providerId: "dup.provider",
            name: "Second",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.duplicate");
        }
        expect(threw).toBe(true);
        // Case-insensitive uniqueness (defense-in-depth): DUP.provider.
        threw = false;
        try {
          await providers.createProvider({
            providerId: "DUP.provider",
            name: "Case",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.id.invalid");
        }
        expect(threw).toBe(true);
        for (const bad of ["Paystack", "pay stack", "paystack.", "1paystack", ""]) {
          threw = false;
          try {
            await providers.createProvider({
              providerId: bad,
              name: "Bad",
              actingPrincipal: adminP,
            });
          } catch (err) {
            threw = true;
            expect((err as AppError).code).toBe("provider.id.invalid");
          }
          expect(threw, `id "${bad}" should be rejected`).toBe(true);
        }
      } finally {
        await cleanup();
      }
    });
  });

  it("a non-admin (any ordinary user) cannot mutate the provider registry (403 provider.admin.required)", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const userP = await makeUser(auth, 1);
        let threw = false;
        try {
          await providers.createProvider({
            providerId: "nope.provider",
            name: "Nope",
            actingPrincipal: userP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).category).toBe("POLICY_BLOCKED");
          expect((err as AppError).code).toBe("provider.admin.required");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("declare capability: valid declaration persists credential requirements + adapter version from the descriptor", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities, 1);
        await seedEchoCapability(capabilities, adminP);
        await providers.createProvider({
          providerId: DEMO_ECHO_PROVIDER_ID,
          name: "Echo Demo Provider",
          actingPrincipal: adminP,
        });
        const decl = await providers.declareProviderCapability({
          providerId: DEMO_ECHO_PROVIDER_ID,
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          actingPrincipal: adminP,
        });
        expect(decl.capabilityCanonicalId).toBe("demo.echo");
        expect(decl.capabilityVersion).toBe("1");
        expect(decl.adapterVersion).toBe("1.0.0"); // from the adapter descriptor
        expect(decl.status).toBe("registered");
        expect(decl.certificationEnvironment).toBe("none");
        // Credential REQUIREMENTS persisted as metadata — no values.
        expect(decl.credentialRequirements.length).toBe(1);
        expect(decl.credentialRequirements[0]!.name).toBe("api_key");
        expect(decl.credentialRequirements[0]!.kind).toBe("api_key");
        expect(
          JSON.stringify(decl.credentialRequirements).includes("value"),
        ).toBe(false);
        const list = await providers.listProviderCapabilities(DEMO_ECHO_PROVIDER_ID);
        expect(list.length).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  it("duplicate declaration rejected (DB constraint)", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities, 1);
        await seedEchoCapability(capabilities, adminP);
        await providers.createProvider({ providerId: DEMO_ECHO_PROVIDER_ID, name: "Echo", actingPrincipal: adminP });
        await providers.declareProviderCapability({
          providerId: DEMO_ECHO_PROVIDER_ID,
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          actingPrincipal: adminP,
        });
        let threw = false;
        try {
          await providers.declareProviderCapability({
            providerId: DEMO_ECHO_PROVIDER_ID,
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.capability.duplicate");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("unknown capability / unknown version / retired version rejected (contract/version-based compatibility)", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities, 1);
        await seedEchoCapability(capabilities, adminP);
        await providers.createProvider({ providerId: DEMO_ECHO_PROVIDER_ID, name: "Echo", actingPrincipal: adminP });

        // Unknown capability.
        let threw = false;
        try {
          await providers.declareProviderCapability({
            providerId: DEMO_ECHO_PROVIDER_ID,
            capabilityId: "missing.capability",
            capabilityVersion: "1",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.capability.unknown");
        }
        expect(threw).toBe(true);

        // Known capability, unknown version.
        threw = false;
        try {
          await providers.declareProviderCapability({
            providerId: DEMO_ECHO_PROVIDER_ID,
            capabilityId: "demo.echo",
            capabilityVersion: "9",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.capability.version_unknown");
        }
        expect(threw).toBe(true);

        // Retired version: retire version 1 then declare it again via a
        // second provider — refused.
        await capabilities.transitionVersion({
          capabilityId: "demo.echo",
          version: "1",
          toStatus: "retired",
          actingPrincipal: adminP,
        });
        await providers.createProvider({ providerId: "other.provider", name: "Other", actingPrincipal: adminP });
        threw = false;
        try {
          await providers.declareProviderCapability({
            providerId: "other.provider",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.capability.version_retired");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("adapter mismatch rejected: adapter does not declare the capability / version (name match is not compatibility)", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities, 1);
        await seedEchoCapability(capabilities, adminP);
        // A second capability in the catalog that the demo.echo adapter
        // does NOT implement.
        await capabilities.createCapability({
          capabilityId: "other.thing",
          name: "Other",
          actingPrincipal: adminP,
        });
        await capabilities.transitionCapability({
          capabilityId: "other.thing",
          toStatus: "active",
          actingPrincipal: adminP,
        });
        await capabilities.createVersion({
          capabilityId: "other.thing",
          version: "1",
          contract: SAMPLE_CONTRACT,
          actingPrincipal: adminP,
        });
        await capabilities.transitionVersion({
          capabilityId: "other.thing",
          version: "1",
          toStatus: "active",
          actingPrincipal: adminP,
        });
        await providers.createProvider({ providerId: DEMO_ECHO_PROVIDER_ID, name: "Echo", actingPrincipal: adminP });

        // Same NAME as the provider, but the adapter does not implement it.
        let threw = false;
        try {
          await providers.declareProviderCapability({
            providerId: DEMO_ECHO_PROVIDER_ID,
            capabilityId: "other.thing",
            capabilityVersion: "1",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.capability.unsupported");
          expect((err as AppError).details?.reason).toBe("adapter_capability_mismatch");
        }
        expect(threw).toBe(true);

        // Version the adapter does not declare (demo.echo@2).
        await capabilities.createVersion({
          capabilityId: "demo.echo",
          version: "2",
          contract: SAMPLE_CONTRACT,
          actingPrincipal: adminP,
        });
        await capabilities.transitionVersion({
          capabilityId: "demo.echo",
          version: "2",
          toStatus: "active",
          actingPrincipal: adminP,
        });
        threw = false;
        try {
          await providers.declareProviderCapability({
            providerId: DEMO_ECHO_PROVIDER_ID,
            capabilityId: "demo.echo",
            capabilityVersion: "2",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.capability.unsupported");
          expect((err as AppError).details?.reason).toBe("adapter_version_mismatch");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("lifecycle: valid transitions; invalid rejected; contract_tested and certified are evidence-gated; revoked terminal", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities, 1);
        await seedEchoCapability(capabilities, adminP);
        const p = await providers.createProvider({
          providerId: DEMO_ECHO_PROVIDER_ID,
          name: "Echo",
          actingPrincipal: adminP,
        });
        expect(p.status).toBe("discovered");

        // discovered → integrating (no gate).
        let cur = await providers.transitionProvider({
          providerId: DEMO_ECHO_PROVIDER_ID,
          toStatus: "integrating",
          actingPrincipal: adminP,
        });
        expect(cur.status).toBe("integrating");

        // integrating → contract_tested REQUIRES declarations + passing
        // evidence (none yet).
        let threw = false;
        try {
          await providers.transitionProvider({
            providerId: DEMO_ECHO_PROVIDER_ID,
            toStatus: "contract_tested",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.transition.gate");
        }
        expect(threw).toBe(true);

        // Declare + run contract tests (fixture) → declaration becomes
        // contract_verified → transition now allowed.
        await providers.declareProviderCapability({
          providerId: DEMO_ECHO_PROVIDER_ID,
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          actingPrincipal: adminP,
        });
        threw = false;
        try {
          await providers.transitionProvider({
            providerId: DEMO_ECHO_PROVIDER_ID,
            toStatus: "contract_tested",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.transition.gate");
          expect((err as AppError).details?.reason).toBe("declaration_not_verified");
        }
        expect(threw).toBe(true);
        const run = await providers.runContractTests({
          providerId: DEMO_ECHO_PROVIDER_ID,
          actingPrincipal: adminP,
        });
        expect(run.environment).toBe("fixture");
        cur = await providers.transitionProvider({
          providerId: DEMO_ECHO_PROVIDER_ID,
          toStatus: "contract_tested",
          actingPrincipal: adminP,
        });
        expect(cur.status).toBe("contract_tested");

        // contract_tested → observed (operator action; no automated gate
        // yet — observations belong to later work).
        cur = await providers.transitionProvider({
          providerId: DEMO_ECHO_PROVIDER_ID,
          toStatus: "observed",
          actingPrincipal: adminP,
        });
        expect(cur.status).toBe("observed");

        // observed → certified REQUIRES a certified implementation, which
        // by construction requires LIVE evidence. The fixture run cannot
        // certify (WORK-006 §14: never claim live certification from a
        // fixture) — so this gate refuses.
        threw = false;
        try {
          await providers.transitionProvider({
            providerId: DEMO_ECHO_PROVIDER_ID,
            toStatus: "certified",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.transition.gate");
          expect((err as AppError).details?.reason).toBe("no_certified_implementation");
        }
        expect(threw).toBe(true);

        // Invalid transition: observed → active (must pass certified).
        threw = false;
        try {
          await providers.transitionProvider({
            providerId: DEMO_ECHO_PROVIDER_ID,
            toStatus: "active",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.transition.invalid");
        }
        expect(threw).toBe(true);

        // observed → revoked; revoked terminal; revoked cannot declare.
        cur = await providers.transitionProvider({
          providerId: DEMO_ECHO_PROVIDER_ID,
          toStatus: "revoked",
          actingPrincipal: adminP,
        });
        expect(cur.status).toBe("revoked");
        threw = false;
        try {
          await providers.transitionProvider({
            providerId: DEMO_ECHO_PROVIDER_ID,
            toStatus: "discovered",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.transition.invalid");
        }
        expect(threw).toBe(true);
        threw = false;
        try {
          await providers.declareProviderCapability({
            providerId: DEMO_ECHO_PROVIDER_ID,
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.revoked");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("concurrency: parallel createProvider with the same id → exactly one succeeds", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities, 1);
        // Warm the pool so the two creates genuinely overlap.
        await Promise.all([
          capabilities.isCapabilityAdmin("warmup"),
          capabilities.isCapabilityAdmin("warmup"),
          capabilities.isCapabilityAdmin("warmup"),
        ]);
        const results = await Promise.allSettled([
          providers.createProvider({ providerId: "race.provider", name: "A", actingPrincipal: adminP }),
          providers.createProvider({ providerId: "race.provider", name: "B", actingPrincipal: adminP }),
        ]);
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const fail = results.filter((r) => r.status === "rejected").length;
        expect(ok).toBe(1);
        expect(fail).toBe(1);
        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect((rejected.reason as AppError).code).toBe("provider.duplicate");
      } finally {
        await cleanup();
      }
    });
  });
});
