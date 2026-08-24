// tests/providers/certification.test.ts — WORK-006 certification evidence
// against REAL PostgreSQL. Proves the first-party integration path
// (WORK-006 §8, §13, §14):
//
//   provider docs/API → CP adapter → normalized provider contract
//        → contract tests → certification evidence
//
//   - runContractTests() executes the deterministic contract suite through
//     the adapter and persists EVERY outcome as an evidence row
//     (test, result, capability, provider, adapter version, timestamp,
//     environment, artifact reference)
//   - passing gate tests advance a declaration registered →
//     contract_verified (fixture evidence is sufficient for contract
//     VERIFICATION)
//   - fixture evidence can NEVER advance a declaration to certified —
//     "contract verified" and "live provider certified" are distinct, and
//     a mock is never a live certification (WORK-006 §14)
//   - a FAILING adapter produces fail evidence rows and does NOT advance
//     the declaration (certification is evidence-backed, not
//     record-says-so — architecture §32)
//   - re-running the suite appends new evidence (append-only trail) and
//     is stable
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
  AdapterRegistry,
  type ProviderAdapter,
  DEMO_ECHO_PROVIDER_ID,
} from "@cp/providers";

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

async function setup(
  handle: { pg: { connectionString: string } },
  adapters: AdapterRegistry = createDefaultAdapterRegistry(),
) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-providers-cert",
  });
  await migrateAuthSchema(db);
  await migrateOrganizationsSchema(db);
  await migrateProjectsSchema(db);
  await migrateCapabilitiesSchema(db);
  await migrateProvidersSchema(db);
  const auth = new AuthService({ db });
  const capabilities = new CapabilitiesService({ db });
  const providers = new ProvidersService({ db, capabilities, adapters });
  const cleanup = async () => { await db.close(); };
  return { db, auth, capabilities, providers, cleanup };
}

async function makeAdmin(auth: AuthService, capabilities: CapabilitiesService) {
  const u = await auth.createUser({
    email: `certadmin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: "password123",
  });
  await capabilities.bootstrapCapabilityAdmin({ userId: u.id });
  return buildPrincipal(u.id, []);
}

async function seed(providerCapability: {
  capabilities: CapabilitiesService;
  providers: ProvidersService;
  adminP: ReturnType<typeof buildPrincipal>;
}) {
  const { capabilities, providers, adminP } = providerCapability;
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
  await providers.createProvider({
    providerId: DEMO_ECHO_PROVIDER_ID,
    name: "Echo Demo Provider",
    actingPrincipal: adminP,
  });
  await providers.declareProviderCapability({
    providerId: DEMO_ECHO_PROVIDER_ID,
    capabilityId: "demo.echo",
    capabilityVersion: "1",
    actingPrincipal: adminP,
  });
}

/**
 * A deliberately BROKEN adapter for the same demo.echo provider id: it
 * declares the right capability/version but its invocation returns output
// that does NOT conform and rejects valid input — proving the harness
 * records FAIL evidence and refuses to advance certification.
 */
function createBrokenEchoAdapter(): ProviderAdapter {
  return {
    descriptor() {
      return {
        providerId: "demo.echo",
        name: "Broken Echo (test)",
        description: "deliberately non-conforming adapter",
        integrationPath: "platform_operated",
        environment: "fixture",
        adapterVersion: "0.0.1",
        credentialRequirements: [
          { name: "api_key", kind: "api_key", description: "test" },
        ],
        capabilities: [
          {
            capabilityId: "demo.echo",
            capabilityVersions: ["1"],
            sampleInput: { message: "hello" },
          },
        ],
      };
    },
    async verifyConfiguration() {
      return { ok: true, problems: [] };
    },
    async invoke() {
      // Non-conforming output: wrong root type entirely.
      return { output: "not-an-object" };
    },
  };
}

describe("WORK-006 certification evidence (real PostgreSQL)", () => {
  it("first-party path: contract tests produce evidence rows (environment=fixture) and advance registered → contract_verified; fixture can NEVER reach certified", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities);
        await seed({ capabilities, providers, adminP });

        const run = await providers.runContractTests({
          providerId: DEMO_ECHO_PROVIDER_ID,
          actingPrincipal: adminP,
        });
        expect(run.environment).toBe("fixture");
        expect(run.adapterVersion).toBe("1.0.0");
        expect(run.declarationResults.length).toBe(1);
        const dr = run.declarationResults[0]!;
        expect(dr.capabilityId).toBe("demo.echo");
        expect(dr.capabilityVersion).toBe("1");
        expect(dr.statusBefore).toBe("registered");
        // Fixture evidence verifies the CONTRACT but cannot certify LIVE.
        expect(dr.statusAfter).toBe("contract_verified");
        // Every test in the deterministic suite ran and passed.
        expect(dr.outcomes.length).toBe(7);
        for (const o of dr.outcomes) {
          expect(o.result).toBe("pass");
        }
        const testNames: string[] = dr.outcomes.map((o) => o.testName);
        expect([...testNames].sort()).toEqual(
          [
            "capability.declared",
            "capability.version_exists",
            "credentials.declared",
            "error.normalized",
            "input.accepted",
            "output.conforms",
            "unsupported.rejected",
          ].sort(),
        );

        // Evidence rows persisted with the full evidence shape
        // (test/result/capability/provider/adapter/timestamp/environment/
        // artifact reference) — the future optimization system's evidence
        // foundation (WORK-006 §13).
        const evidence = await providers.listCertificationEvidence(DEMO_ECHO_PROVIDER_ID);
        expect(evidence.length).toBe(7);
        for (const e of evidence) {
          expect(e.capabilityCanonicalId).toBe("demo.echo");
          expect(e.capabilityVersion).toBe("1");
          expect(e.adapterVersion).toBe("1.0.0");
          expect(e.environment).toBe("fixture"); // explicitly NOT live
          expect(e.result).toBe("pass");
          expect(e.artifactRef).toBe("contract-suite:1.0.0");
          expect(e.createdAt instanceof Date).toBe(true);
          // Evidence detail is non-secret.
          expect(JSON.stringify(e.detail).includes("fixture-contract-test-credential")).toBe(false);
        }

        // Re-running appends a second complete evidence trail
        // (append-only) and stays contract_verified (never certified).
        await providers.runContractTests({
          providerId: DEMO_ECHO_PROVIDER_ID,
          actingPrincipal: adminP,
        });
        const evidence2 = await providers.listCertificationEvidence(DEMO_ECHO_PROVIDER_ID);
        expect(evidence2.length).toBe(14);
        const decls = await providers.listProviderCapabilities(DEMO_ECHO_PROVIDER_ID);
        expect(decls[0]!.status).toBe("contract_verified");
        expect(decls[0]!.certificationEnvironment).toBe("fixture");
      } finally {
        await cleanup();
      }
    });
  });

  it("failing adapter: FAIL evidence recorded; certification does not advance (evidence-backed, not record-says-so)", async () => {
    await withInfra(async (handle) => {
      const registry = new AdapterRegistry();
      registry.register(createBrokenEchoAdapter());
      const { auth, capabilities, providers, cleanup } = await setup(handle, registry);
      try {
        const adminP = await makeAdmin(auth, capabilities);
        await seed({ capabilities, providers, adminP });

        const run = await providers.runContractTests({
          providerId: DEMO_ECHO_PROVIDER_ID,
          actingPrincipal: adminP,
        });
        const dr = run.declarationResults[0]!;
        expect(dr.statusBefore).toBe("registered");
        // The broken adapter fails output.conformance and error
        // normalization — the declaration must NOT advance.
        expect(dr.statusAfter).toBe("registered");
        const failed = dr.outcomes.filter((o) => o.result === "fail");
        expect(failed.length).toBeGreaterThan(0);
        expect(failed.map((o) => o.testName)).toContain("output.conforms");

        // Evidence rows include the FAILURES (failures are evidence too).
        const evidence = await providers.listCertificationEvidence(DEMO_ECHO_PROVIDER_ID);
        expect(evidence.length).toBe(7);
        expect(evidence.some((e) => e.result === "fail")).toBe(true);

        // And the provider-level contract_tested gate still refuses.
        let threw = false;
        try {
          await providers.transitionProvider({
            providerId: DEMO_ECHO_PROVIDER_ID,
            toStatus: "integrating",
            actingPrincipal: adminP,
          });
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
      } finally {
        await cleanup();
      }
    });
  });

  it("runContractTests requires a registered adapter and at least one declaration", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities);
        // Provider with NO adapter registered under its id.
        await providers.createProvider({
          providerId: "adapterless.provider",
          name: "Adapterless",
          actingPrincipal: adminP,
        });
        let threw = false;
        try {
          await providers.runContractTests({
            providerId: "adapterless.provider",
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.adapter.missing");
        }
        expect(threw).toBe(true);

        // demo.echo provider (adapter exists) but NO declarations.
        await providers.createProvider({
          providerId: DEMO_ECHO_PROVIDER_ID,
          name: "Echo",
          actingPrincipal: adminP,
        });
        threw = false;
        try {
          await providers.runContractTests({
            providerId: DEMO_ECHO_PROVIDER_ID,
            actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.declarations.missing");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("non-admin cannot run certification tests (provider.admin.required)", async () => {
    await withInfra(async (handle) => {
      const { auth, capabilities, providers, cleanup } = await setup(handle);
      try {
        const adminP = await makeAdmin(auth, capabilities);
        await seed({ capabilities, providers, adminP });
        const u = await auth.createUser({
          email: `certuser-${Date.now()}@example.com`,
          password: "password123",
        });
        const userP = buildPrincipal(u.id, []);
        let threw = false;
        try {
          await providers.runContractTests({
            providerId: DEMO_ECHO_PROVIDER_ID,
            actingPrincipal: userP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("provider.admin.required");
        }
        expect(threw).toBe(true);
        // No evidence was recorded for the refused run.
        const evidence = await providers.listCertificationEvidence(DEMO_ECHO_PROVIDER_ID);
        expect(evidence.length).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });
});
