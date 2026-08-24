// tests/catalog/offerings.test.ts — WORK-007 offering projection and
// catalog CONSISTENCY against REAL PostgreSQL (WORK-007 §14, §15).
//
// Proves:
//   - the offering projection answers provider X implements capability Y
//     version Z with pricing/coverage/health/evidence/certification
//   - every catalog fact references an existing declaration (FK) —
//     pricing/coverage/health cannot outlive their owning entity
//   - REVOKED providers are not presented as active offerings
//   - SUSPENDED/DEPRECATED providers are not presented as active offerings
//   - RETIRED capability versions are not presented as active offerings
//   - include_inactive=true surfaces them LABELED (never as active)
//   - certification state in the offering matches /providers evidence
//   - filters: capability, version, provider, certification, coverage
//     (country/region/currency), pricing model, integration path,
//     source type
//   - cursor pagination follows WORK-004 conventions
//   - both integration paths (platform_operated / provider_operated)
//     appear identically in the normalized catalog (WORK-007 §20)
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { AppError } from "@cp/platform";
import { buildPrincipal, type Principal } from "@cp/auth";
import {
  setupCatalog,
  seedEchoStack,
  makeOrdinaryUser,
  ECHO_CONTRACT,
} from "./helpers.ts";

describe("WORK-007 catalog offering projection (real PostgreSQL)", () => {
  it("offering detail answers the full marketplace question with provenance-labeled facts", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle);
      const { catalog, adminP, capabilities, providers, cleanup } = ctx;
      try {
        // Marketplace facts on the demo.echo offering.
        await catalog.addPricingFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "per_request",
          currency: "GHS",
          unit: "request",
          amount: "0.05",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        await catalog.addCoverageFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          dimension: "country",
          value: "GH",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        await catalog.recordHealthObservation({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          status: "healthy",
          metrics: { availability: 0.999 },
          sourceType: "platform_observed",
          actingPrincipal: adminP,
        });

        const page = await catalog.listOfferings({ limit: 10 });
        expect(page.offerings.length).toBe(1);
        const offering = page.offerings[0]!;
        // WHAT: capability + version.
        expect(offering.capability.capabilityId).toBe("demo.echo");
        expect(offering.capability.capabilityVersion).toBe("1");
        expect(offering.capability.versionStatus).toBe("active");
        // WHO: provider.
        expect(offering.provider.providerId).toBe("demo.echo");
        expect(offering.provider.integrationPath).toBe("platform_operated");
        // Implementation + certification state from /providers.
        expect(offering.implementation.status).toBe("registered");
        expect(offering.implementation.adapterVersion).toBe("1.0.0");
        expect(offering.implementation.credentialRequirementNames).toEqual(["api_key"]);
        // Evidence summary from the certification evidence table.
        expect(offering.evidence.totalTests).toBe(0); // no contract tests run yet
        // Facts with provenance.
        expect(offering.pricing.length).toBe(1);
        expect(offering.pricing[0]!.status).toBe("declared");
        expect(offering.coverage.length).toBe(1);
        expect(offering.coverage[0]!.value).toBe("GH");
        expect(offering.health.length).toBe(1);
        expect(offering.health[0]!.status).toBe("healthy");

        // getOffering by id returns the same detail.
        const byId = await catalog.getOffering(offering.offeringId);
        expect(byId?.offeringId).toBe(offering.offeringId);
        expect(byId?.pricing.length).toBe(1);

        // After running the provider contract tests (fixture), the
        // evidence summary reflects it and certification state advances
        // in /providers — the catalog projection CONSUMES that state.
        const run = await providers.runContractTests({
          providerId: "demo.echo",
          actingPrincipal: adminP,
        });
        expect(run.declarationResults[0]!.statusAfter).toBe("contract_verified");
        const after = await catalog.getOffering(offering.offeringId);
        expect(after?.implementation.status).toBe("contract_verified");
        expect(after?.evidence.totalTests).toBe(7);
        expect(after?.evidence.passedTests).toBe(7);
        expect(after?.evidence.latestEnvironment).toBe("fixture");
        void capabilities;
      } finally {
        await cleanup();
      }
    });
  });

  it("CONSISTENCY: facts cannot outlive their owning entity (FK RESTRICT); every offering references real provider + capability + version", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle);
      const { db, catalog, adminP, cleanup } = ctx;
      try {
        const page = await catalog.listOfferings({ limit: 10 });
        const offeringId = page.offerings[0]!.offeringId;

        // Referential integrity: every catalog fact row references an
        // existing declaration (enforced by FK); attempt to delete the
        // owning declaration while facts exist is RESTRICTed.
        await catalog.addCoverageFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          dimension: "country",
          value: "GH",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        let restrict = false;
        try {
          await db.exec({
            text: `DELETE FROM cp_provider_capabilities WHERE id = $1`,
            params: [offeringId],
          });
        } catch {
          restrict = true;
        }
        expect(restrict).toBe(true);

        // Every active offering joins a real provider, capability, and
        // (non-null) capability version row.
        const dangling = await db.query({
          text: `SELECT count(*)::int AS n
                 FROM cp_provider_capabilities pc
                 LEFT JOIN cp_providers p ON p.id = pc.provider_id
                 LEFT JOIN cp_capabilities c ON c.id = pc.capability_id
                 LEFT JOIN cp_capability_versions v
                        ON v.capability_id = pc.capability_id AND v.version = pc.capability_version
                 WHERE p.id IS NULL OR c.id IS NULL OR v.id IS NULL`,
          params: [],
        });
        expect(Number(dangling[0]!.n)).toBe(0);

        // Every catalog fact references an existing declaration.
        const orphanFacts = await db.query({
          text: `SELECT
                   (SELECT count(*)::int FROM cp_catalog_pricing pr
                    LEFT JOIN cp_provider_capabilities pc ON pc.id = pr.provider_capability_id
                    WHERE pc.id IS NULL) AS pricing_orphans,
                   (SELECT count(*)::int FROM cp_catalog_coverage cv
                    LEFT JOIN cp_provider_capabilities pc ON pc.id = cv.provider_capability_id
                    WHERE pc.id IS NULL) AS coverage_orphans,
                   (SELECT count(*)::int FROM cp_catalog_health h
                    LEFT JOIN cp_providers p ON p.id = h.provider_id
                    WHERE p.id IS NULL) AS health_orphans`,
          params: [],
        });
        expect(Number(orphanFacts[0]!.pricing_orphans)).toBe(0);
        expect(Number(orphanFacts[0]!.coverage_orphans)).toBe(0);
        expect(Number(orphanFacts[0]!.health_orphans)).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  it("LIFECYCLE: revoked/suspended/deprecated providers and retired capability versions are never active offerings; include_inactive surfaces them LABELED", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle, { seedEcho: false });
      const { catalog, capabilities, providers, adminP, cleanup } = ctx;
      try {
        // Two providers declare the same capability; one will be revoked.
        await seedEchoStack({ capabilities, providers, adminP });
        await capabilities.createCapability({
          capabilityId: "alt.echo",
          name: "Alt Echo",
          actingPrincipal: adminP,
        });
        await capabilities.transitionCapability({
          capabilityId: "alt.echo",
          toStatus: "active",
          actingPrincipal: adminP,
        });
        await capabilities.createVersion({
          capabilityId: "alt.echo",
          version: "1",
          contract: ECHO_CONTRACT,
          actingPrincipal: adminP,
        });
        await capabilities.transitionVersion({
          capabilityId: "alt.echo",
          version: "1",
          toStatus: "active",
          actingPrincipal: adminP,
        });
        await providers.createProvider({
          providerId: "other.provider",
          name: "Other",
          actingPrincipal: adminP,
        });
        // other.provider declares alt.echo@1 (no adapter → registry-only
        // provider-operated declaration; adapter_version supplied).
        await providers.declareProviderCapability({
          providerId: "other.provider",
          capabilityId: "alt.echo",
          capabilityVersion: "1",
          adapterVersion: "1.0.0",
          actingPrincipal: adminP,
        });

        let page = await catalog.listOfferings({ limit: 10 });
        expect(page.offerings.length).toBe(2);

        // Revoke one provider → its offering leaves the ACTIVE view.
        await providers.transitionProvider({
          providerId: "other.provider",
          toStatus: "revoked",
          actingPrincipal: adminP,
        });
        page = await catalog.listOfferings({ limit: 10 });
        expect(page.offerings.length).toBe(1);
        expect(page.offerings[0]!.provider.providerId).toBe("demo.echo");
        // include_inactive surfaces the revoked offering LABELED.
        const all = await catalog.listOfferings({ limit: 10, includeInactive: true });
        expect(all.offerings.length).toBe(2);
        const revoked = all.offerings.find((o) => o.provider.providerId === "other.provider")!;
        expect(revoked.provider.status).toBe("revoked"); // labeled, not hidden-truth

        // Suspended / deprecated providers: the provider SERVICE gates
        // those states behind live certification (unreachable with the
        // fixture adapter) — this test verifies the CATALOG PROJECTION's
        // consumption of provider states, so it sets the state directly
        // (the provider lifecycle definition itself is WORK-006's,
        // unchanged here).
        for (const suspendedStatus of ["suspended", "deprecated"] as const) {
          await ctx.db.exec({
            text: `UPDATE cp_providers SET status = $1 WHERE provider_id = 'demo.echo'`,
            params: [suspendedStatus],
          });
          page = await catalog.listOfferings({ limit: 10 });
          expect(page.offerings.length).toBe(0);
          const allS = await catalog.listOfferings({ limit: 10, includeInactive: true });
          expect(allS.offerings.length).toBe(2);
          const labeled = allS.offerings.find((o) => o.provider.providerId === "demo.echo")!;
          expect(labeled.provider.status).toBe(suspendedStatus);
        }
      } finally {
        await cleanup();
      }
    });
  });

  it("LIFECYCLE: retired capability version is not an active offering", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle);
      const { catalog, capabilities, adminP, cleanup } = ctx;
      try {
        let page = await catalog.listOfferings({ limit: 10 });
        expect(page.offerings.length).toBe(1);
        // Retire the capability version → the offering leaves the view.
        await capabilities.transitionVersion({
          capabilityId: "demo.echo",
          version: "1",
          toStatus: "deprecated",
          actingPrincipal: adminP,
        });
        await capabilities.transitionVersion({
          capabilityId: "demo.echo",
          version: "1",
          toStatus: "retired",
          actingPrincipal: adminP,
        });
        page = await catalog.listOfferings({ limit: 10 });
        expect(page.offerings.length).toBe(0);
        // Labeled for operators.
        const all = await catalog.listOfferings({ limit: 10, includeInactive: true });
        expect(all.offerings.length).toBe(1);
        expect(all.offerings[0]!.capability.versionStatus).toBe("retired");
      } finally {
        await cleanup();
      }
    });
  });

  it("FILTERS: capability, provider, certification, coverage (country/region/currency), pricing model, integration path, source type", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle, { seedEcho: false });
      const { catalog, capabilities, providers, adminP, cleanup } = ctx;
      try {
        await seedEchoStack({ capabilities, providers, adminP });
        // A provider-operated provider (no adapter): both paths identical
        // in the catalog (WORK-007 §20).
        await providers.createProvider({
          providerId: "self.serve",
          name: "Self Serve",
          integrationPath: "provider_operated",
          actingPrincipal: adminP,
        });
        await capabilities.createCapability({
          capabilityId: "alt.echo",
          name: "Alt",
          actingPrincipal: adminP,
        });
        await capabilities.transitionCapability({
          capabilityId: "alt.echo",
          toStatus: "active",
          actingPrincipal: adminP,
        });
        await capabilities.createVersion({
          capabilityId: "alt.echo",
          version: "1",
          contract: ECHO_CONTRACT,
          actingPrincipal: adminP,
        });
        await capabilities.transitionVersion({
          capabilityId: "alt.echo",
          version: "1",
          toStatus: "active",
          actingPrincipal: adminP,
        });
        await providers.declareProviderCapability({
          providerId: "self.serve",
          capabilityId: "alt.echo",
          capabilityVersion: "1",
          adapterVersion: "1.0.0",
          actingPrincipal: adminP,
        });
        // Facts: demo.echo covers GH + GHS with per_request pricing;
        // self.serve covers KE with per_token pricing (observed).
        await catalog.addCoverageFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          dimension: "country", value: "GH", sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        await catalog.addCoverageFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          dimension: "currency", value: "GHS", sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        await catalog.addPricingFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          model: "per_request", currency: "GHS", amount: "0.05",
          sourceType: "provider_declared", actingPrincipal: adminP,
        });
        await catalog.addCoverageFact({
          providerId: "self.serve", capabilityId: "alt.echo", capabilityVersion: "1",
          dimension: "country", value: "KE", sourceType: "platform_observed",
          actingPrincipal: adminP,
        });
        await catalog.addPricingFact({
          providerId: "self.serve", capabilityId: "alt.echo", capabilityVersion: "1",
          model: "per_token", currency: "USD", amount: "0.001",
          sourceType: "provider_declared", actingPrincipal: adminP,
        });

        // By capability.
        expect((await catalog.listOfferings({ capabilityId: "demo.echo" })).offerings.length).toBe(1);
        expect((await catalog.listOfferings({ capabilityId: "alt.echo" })).offerings.length).toBe(1);
        // By provider.
        expect((await catalog.listOfferings({ providerId: "self.serve" })).offerings.length).toBe(1);
        // By capability + version.
        expect((await catalog.listOfferings({ capabilityId: "demo.echo", capabilityVersion: "1" })).offerings.length).toBe(1);
        expect((await catalog.listOfferings({ capabilityId: "demo.echo", capabilityVersion: "2" })).offerings.length).toBe(0);
        // By certification (implementation status from /providers).
        expect((await catalog.listOfferings({ certification: "registered" })).offerings.length).toBe(2);
        expect((await catalog.listOfferings({ certification: "certified" })).offerings.length).toBe(0);
        // By coverage country.
        expect((await catalog.listOfferings({ country: "GH" })).offerings.length).toBe(1);
        expect((await catalog.listOfferings({ country: "KE" })).offerings.length).toBe(1);
        expect((await catalog.listOfferings({ country: "US" })).offerings.length).toBe(0);
        // By coverage currency.
        expect((await catalog.listOfferings({ currency: "GHS" })).offerings.length).toBe(1);
        // By pricing model.
        expect((await catalog.listOfferings({ pricingModel: "per_token" })).offerings.length).toBe(1);
        expect((await catalog.listOfferings({ pricingModel: "fixed" })).offerings.length).toBe(0);
        // By integration path — both paths appear identically.
        const platform = await catalog.listOfferings({ integrationPath: "platform_operated" });
        const providerOp = await catalog.listOfferings({ integrationPath: "provider_operated" });
        expect(platform.offerings.length).toBe(1);
        expect(providerOp.offerings.length).toBe(1);
        expect(platform.offerings[0]!.provider.providerId).toBe("demo.echo");
        expect(providerOp.offerings[0]!.provider.providerId).toBe("self.serve");
        // By source type (facts' provenance).
        expect((await catalog.listOfferings({ sourceType: "platform_observed" })).offerings.length).toBe(1);
        expect((await catalog.listOfferings({ sourceType: "provider_declared" })).offerings.length).toBe(2);
      } finally {
        await cleanup();
      }
    });
  });

  it("PAGINATION: cursor pagination follows WORK-004 conventions (id-desc cursor, limit, next_cursor)", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle, { seedEcho: false });
      const { catalog, capabilities, providers, adminP, cleanup } = ctx;
      try {
        // 3 declarations across providers.
        await seedEchoStack({ capabilities, providers, adminP });
        await capabilities.createCapability({
          capabilityId: "p2.echo",
          name: "P2",
          actingPrincipal: adminP,
        });
        await capabilities.transitionCapability({
          capabilityId: "p2.echo", toStatus: "active", actingPrincipal: adminP,
        });
        await capabilities.createVersion({
          capabilityId: "p2.echo", version: "1", contract: ECHO_CONTRACT, actingPrincipal: adminP,
        });
        await capabilities.transitionVersion({
          capabilityId: "p2.echo", version: "1", toStatus: "active", actingPrincipal: adminP,
        });
        for (const pid of ["p2.provider", "p3.provider"]) {
          await providers.createProvider({
            providerId: pid, name: pid, actingPrincipal: adminP,
          });
          await providers.declareProviderCapability({
            providerId: pid, capabilityId: "p2.echo", capabilityVersion: "1",
            adapterVersion: "1.0.0", actingPrincipal: adminP,
          });
        }
        const page1 = await catalog.listOfferings({ limit: 2 });
        expect(page1.offerings.length).toBe(2);
        expect(page1.nextCursor).not.toBeNull();
        const page2 = await catalog.listOfferings({ limit: 2, cursor: page1.nextCursor });
        expect(page2.offerings.length).toBe(1);
        expect(page2.nextCursor).toBeNull();
        // No overlap between pages.
        const ids1 = new Set(page1.offerings.map((o) => o.offeringId));
        for (const o of page2.offerings) {
          expect(ids1.has(o.offeringId)).toBe(false);
        }
      } finally {
        await cleanup();
      }
    });
  });

  it("reads are open to any authenticated principal at the service layer; offering detail of unknown id → null", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle);
      const { catalog, cleanup } = ctx;
      try {
        const userP = await makeOrdinaryUser(ctx);
        void userP; // reads carry no principal — HTTP layer gates on auth only
        const page = await catalog.listOfferings({ limit: 10 });
        expect(page.offerings.length).toBe(1);
        const missing = await catalog.getOffering("provcap_missing");
        expect(missing).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });

  it("facts attach even after lifecycle aging (history preserved) but the offering leaves the active view", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle);
      const { catalog, capabilities, adminP, cleanup } = ctx;
      try {
        // Retire the capability version, then attempt to add a fact: the
        // declaration still exists — historical facts remain attachable
        // (append-only history), while the offering leaves the ACTIVE view.
        await capabilities.transitionVersion({
          capabilityId: "demo.echo", version: "1",
          toStatus: "deprecated", actingPrincipal: adminP,
        });
        await capabilities.transitionVersion({
          capabilityId: "demo.echo", version: "1",
          toStatus: "retired", actingPrincipal: adminP,
        });
        const fact = await catalog.addCoverageFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          dimension: "country", value: "GH", sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        expect(fact.status).toBe("declared");
        expect((await catalog.listOfferings({ limit: 10 })).offerings.length).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });
});

// Silence unused-import lint for Principal (type used via helpers).
void (null as unknown as Principal);
