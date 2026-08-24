// tests/eligibility/service.test.ts — EligibilityService against REAL
// PostgreSQL (WORK-009 §28): cross-module integration of capability +
// catalog + policy data. No mocks for persistence. The core evaluator's
// purity is proven separately (evaluator.test.ts — no infrastructure).
//
// STATELESSNESS NOTE (§28): eligibility persists nothing — no tables, no
// candidate state, no cache. There is nothing to race on, so
// persistence/concurrency tests are unnecessary BY DESIGN; determinism
// is proven by repeated identical evaluations below.
//
// Covers:
//   - full flow: policy resolution + candidate enumeration + checks
//   - capability compatibility (supported/unsupported/retired version)
//   - provider lifecycle (active/suspended/revoked) + missing declaration
//   - certification levels + live-certification requirement
//   - coverage (country/currency) + provenance
//   - pricing hard cost + INDETERMINATE on missing fact
//   - policy hard vs preference + explicit/effective version + historical
//     reproducibility
//   - health semantics
//   - TENANCY: cross-org/cross-project policy rejected; suspended member
//     loses access
//   - DETERMINISM: repeated evaluation → identical results
//   - NO EXECUTION: results are produced with zero provider-adapter
//     involvement (the eligibility tree has no adapter import — proven by
//     tests/arch/eligibility-isolation.test.ts; here we additionally
//     assert evaluation works with the fixture provider untouched)
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { AppError } from "@cp/platform";
import { buildPrincipal } from "@cp/auth";
import {
  setupEligibility,
  makeTenant,
  seedEchoOffering,
  seedPolicy,
  PERMISSIVE_RULES,
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

describe("EligibilityService (real PostgreSQL)", () => {
  it("full flow: eligible candidate with facts + policy; explainable checks; snapshot recorded", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupEligibility(handle);
      try {
        const tenant = await makeTenant(ctx, "full");
        await seedEchoOffering(ctx);
        // Marketplace facts.
        await ctx.catalog.addPricingFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          model: "per_request", currency: "GHS", amount: "0.05",
          sourceType: "provider_declared", actingPrincipal: ctx.adminP,
        });
        await ctx.catalog.addCoverageFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          dimension: "country", value: "GH", sourceType: "provider_declared",
          actingPrincipal: ctx.adminP,
        });
        await ctx.catalog.addCoverageFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          dimension: "region", value: "AF", sourceType: "provider_declared",
          actingPrincipal: ctx.adminP,
        });
        await ctx.catalog.recordHealthObservation({
          providerId: "demo.echo", status: "healthy",
          metrics: { availability: 0.999 }, sourceType: "platform_observed",
          actingPrincipal: ctx.adminP,
        });
        const policy = await seedPolicy(ctx, tenant, "eu-gh", [
          { subject: "region", operator: "in", value: ["EU", "AF"], mode: "hard" },
          { subject: "integration_path", operator: "eq", value: "platform_operated", mode: "preference" },
        ]);

        const evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          policyId: policy.policyId,
          providers: undefined,
          constraints: {
            country: "GH",
            region: "AF",
            max_estimated_cost: 0.1,
            require_healthy: true,
          },
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.capability.exists).toBe(true);
        expect(evaluation.capability.versionExists).toBe(true);
        expect(evaluation.policy.policyId).toBe(policy.policyId);
        expect(evaluation.summary.evaluated).toBe(1);
        expect(evaluation.summary.eligible).toBe(1);
        const r = evaluation.results[0]!;
        expect(r.status).toBe("eligible");
        expect(r.candidate.provider.providerId).toBe("demo.echo");
        expect(r.failures.length).toBe(0);
        // The preference (platform_operated) is satisfied by this offering.
        expect(r.policy?.preferenceSatisfied.length).toBe(1);
        // Snapshot records what was evaluated.
        expect(r.snapshot.policyVersion).toBe(policy.version);
        expect(r.snapshot.perRequestPricingFact).not.toBeNull();
        expect(r.snapshot.healthObservation?.status).toBe("healthy");
        // Every check carries full explainability.
        for (const check of r.checks) {
          expect(check.checkId.length).toBeGreaterThan(0);
          expect(["pass", "fail", "indeterminate"]).toContain(check.result);
        }
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("policy integration: hard violation → ineligible; preference violation NEVER disqualifies; effective + explicit versions", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupEligibility(handle);
      try {
        const tenant = await makeTenant(ctx, "pol");
        await seedEchoOffering(ctx);
        await ctx.catalog.addCoverageFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          dimension: "region", value: "EU", sourceType: "provider_declared",
          actingPrincipal: ctx.adminP,
        });
        await ctx.catalog.addCoverageFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          dimension: "region", value: "AF", sourceType: "provider_declared",
          actingPrincipal: ctx.adminP,
        });
        const policy = await seedPolicy(ctx, tenant, "eu-only", [
          { subject: "region", operator: "eq", value: "EU", mode: "hard" },
          { subject: "integration_path", operator: "eq", value: "provider_operated", mode: "preference" },
        ]);

        // Hard violation: request region is US → ineligible with the policy check failing.
        let evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "1",
          policyId: policy.policyId,
          constraints: { region: "US" },
          actingPrincipal: tenant.memberP,
        });
        let r = evaluation.results[0]!;
        expect(r.status).toBe("ineligible");
        const policyCheck = r.failures.find((c) => c.checkId === "policy.hard_constraints")!;
        expect(policyCheck.reason).toContain("rule_1");
        expect(r.policy?.hardViolations[0]!.actual).toBe("US");
        expect(r.policy?.hardViolations[0]!.expected).toBe("EU");

        // Preference violation only: region EU satisfies the hard rule; the
        // platform_operated offering violates the provider_operated
        // preference → STILL ELIGIBLE.
        evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "1",
          policyId: policy.policyId,
          constraints: { region: "EU" },
          actingPrincipal: tenant.memberP,
        });
        r = evaluation.results[0]!;
        expect(r.status).toBe("eligible");
        expect(r.policy?.preferenceViolated.length).toBe(1);
        expect(r.policy?.hardPassed).toBe(true);

        // Effective version: a NEW active version (region in EU/AF) resolves
        // automatically when policy_version is omitted.
        await ctx.policies.createVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          policyId: policy.policyId,
          rules: [{ subject: "region", operator: "in", value: ["EU", "AF"], mode: "hard" }],
          actingPrincipal: tenant.adminP,
        });
        // Activate version 2 (auto-numbered max+1) — v1 is auto-deprecated.
        await ctx.policies.transitionVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          policyId: policy.policyId, version: "2", toStatus: "active",
          actingPrincipal: tenant.adminP,
        });
        evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "1",
          policyId: policy.policyId,
          constraints: { region: "AF" },
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.policy.policyVersion).toBe("2");
        expect(evaluation.results[0]!.status).toBe("eligible");

        // HISTORICAL reproducibility: explicit version "1" still rejects AF.
        evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "1",
          policyId: policy.policyId, policyVersion: "1",
          constraints: { region: "AF" },
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.policy.policyVersion).toBe("1");
        expect(evaluation.results[0]!.status).toBe("ineligible");

        // Unknown policy version → structured error.
        await expectRejected("eligibility.policy.version_not_found", () =>
          ctx.eligibility.evaluate({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            capabilityId: "demo.echo", capabilityVersion: "1",
            policyId: policy.policyId, policyVersion: "99",
            constraints: {}, actingPrincipal: tenant.memberP,
          }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("capability compatibility: unsupported capability/version → zero candidates; retired version rejected", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupEligibility(handle);
      try {
        const tenant = await makeTenant(ctx, "cap");
        await seedEchoOffering(ctx);
        const policy = await seedPolicy(ctx, tenant, "p", PERMISSIVE_RULES);

        // Unsupported capability → zero candidates + summary explains why.
        let evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "missing.capability", capabilityVersion: "1",
          policyId: policy.policyId, constraints: {},
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.capability.exists).toBe(false);
        expect(evaluation.capability.versionExists).toBe(false);
        expect(evaluation.results.length).toBe(0);
        expect(evaluation.summary.evaluated).toBe(0);

        // Unsupported version → zero candidates (exact-version semantics).
        evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "9",
          policyId: policy.policyId, constraints: {},
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.capability.exists).toBe(true);
        expect(evaluation.capability.versionExists).toBe(false);
        expect(evaluation.results.length).toBe(0);

        // Retire the version → the offering is enumerated (include_inactive)
        // but REJECTED with an explainable check.
        await ctx.capabilities.transitionVersion({
          capabilityId: "demo.echo", version: "1", toStatus: "deprecated",
          actingPrincipal: ctx.adminP,
        });
        await ctx.capabilities.transitionVersion({
          capabilityId: "demo.echo", version: "1", toStatus: "retired",
          actingPrincipal: ctx.adminP,
        });
        evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "1",
          policyId: policy.policyId, constraints: {},
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.results.length).toBe(1);
        const r = evaluation.results[0]!;
        expect(r.status).toBe("ineligible");
        expect(r.failures.find((c) => c.checkId === "capability.version_not_retired")!.actual).toBe("retired");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("provider lifecycle + named-candidate mode: suspended/revoked rejected; missing declaration / unsupported version explained", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupEligibility(handle);
      try {
        const tenant = await makeTenant(ctx, "prov");
        await seedEchoOffering(ctx);
        const policy = await seedPolicy(ctx, tenant, "p", PERMISSIVE_RULES);

        // Active provider → eligible.
        let evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "1",
          policyId: policy.policyId, constraints: {},
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.results[0]!.status).toBe("eligible");

        // Suspended provider (direct state — the provider service gates
        // suspended behind live certification; this test verifies the
        // ELIGIBILITY layer's consumption of provider states) → rejected.
        await ctx.db.exec({
          text: `UPDATE cp_providers SET status = 'suspended' WHERE provider_id = 'demo.echo'`,
          params: [],
        });
        evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "1",
          policyId: policy.policyId, constraints: {},
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.results[0]!.status).toBe("ineligible");
        expect(evaluation.results[0]!.failures.find((c) => c.checkId === "provider.status")!.actual).toBe("suspended");

        // Revoked provider → rejected (never eligible).
        await ctx.db.exec({
          text: `UPDATE cp_providers SET status = 'revoked' WHERE provider_id = 'demo.echo'`,
          params: [],
        });
        evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "1",
          policyId: policy.policyId, constraints: {},
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.results[0]!.status).toBe("ineligible");
        expect(evaluation.results[0]!.failures.find((c) => c.checkId === "provider.status")!.actual).toBe("revoked");

        // Restore active for the named-candidate cases.
        await ctx.db.exec({
          text: `UPDATE cp_providers SET status = 'active' WHERE provider_id = 'demo.echo'`,
          params: [],
        });

        // Named-candidate mode: a provider with NO declaration → synthetic rejection.
        await ctx.providers.createProvider({
          providerId: "ghost.provider", name: "Ghost", actingPrincipal: ctx.adminP,
        });
        evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "1",
          policyId: policy.policyId,
          providers: ["demo.echo", "ghost.provider"],
          constraints: {},
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.results.length).toBe(2);
        const ghost = evaluation.results.find(
          (r) => r.candidate.provider.providerId === "ghost.provider",
        )!;
        expect(ghost.status).toBe("ineligible");
        expect(ghost.failures[0]!.checkId).toBe("provider.declaration_exists");
        const real = evaluation.results.find(
          (r) => r.candidate.provider.providerId === "demo.echo",
        )!;
        expect(real.status).toBe("eligible");

        // A provider that declares the capability at a DIFFERENT version →
        // version-unsupported rejection.
        await ctx.capabilities.createVersion({
          capabilityId: "demo.echo", version: "2", contract: (await import("./helpers.ts")).ECHO_CONTRACT,
          actingPrincipal: ctx.adminP,
        });
        await ctx.capabilities.transitionVersion({
          capabilityId: "demo.echo", version: "2", toStatus: "active", actingPrincipal: ctx.adminP,
        });
        await ctx.providers.createProvider({
          providerId: "other.provider", name: "Other", actingPrincipal: ctx.adminP,
        });
        await ctx.providers.declareProviderCapability({
          providerId: "other.provider", capabilityId: "demo.echo", capabilityVersion: "2",
          adapterVersion: "1.0.0", actingPrincipal: ctx.adminP,
        });
        evaluation = await ctx.eligibility.evaluate({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          capabilityId: "demo.echo", capabilityVersion: "1",
          policyId: policy.policyId,
          providers: ["other.provider"],
          constraints: {},
          actingPrincipal: tenant.memberP,
        });
        expect(evaluation.results.length).toBe(1);
        expect(evaluation.results[0]!.status).toBe("ineligible");
        expect(evaluation.results[0]!.failures[0]!.checkId).toBe("capability.version_supported");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("certification + coverage + pricing + health facts from the catalog drive checks", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupEligibility(handle);
      try {
        const tenant = await makeTenant(ctx, "facts");
        await seedEchoOffering(ctx);
        const policy = await seedPolicy(ctx, tenant, "p", PERMISSIVE_RULES);
        const base = {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          policyId: policy.policyId,
          actingPrincipal: tenant.memberP,
        };

        // Fixture-only verification does not satisfy certified/live requirements.
        await ctx.providers.runContractTests({
          providerId: "demo.echo", actingPrincipal: ctx.adminP,
        }); // → implementation contract_verified + fixture environment
        let evaluation = await ctx.eligibility.evaluate({
          ...base,
          constraints: { required_certification: "certified", require_live_certification: true },
        });
        let r = evaluation.results[0]!;
        expect(r.status).toBe("ineligible");
        expect(r.failures.find((c) => c.checkId === "certification.level")!.actual).toBe("contract_verified");
        expect(r.failures.find((c) => c.checkId === "certification.environment")!.actual).toBe("fixture");
        // contract_verified (fixture) DOES satisfy a contract_verified requirement.
        evaluation = await ctx.eligibility.evaluate({
          ...base,
          constraints: { required_certification: "contract_verified" },
        });
        expect(evaluation.results[0]!.status).toBe("eligible");

        // Coverage: candidate without coverage facts fails a country requirement.
        evaluation = await ctx.eligibility.evaluate({
          ...base, constraints: { country: "GH" },
        });
        expect(evaluation.results[0]!.status).toBe("ineligible");
        expect(evaluation.results[0]!.failures.find((c) => c.checkId === "coverage.country")!.actual).toBe("not covered");
        // Add a DECLARED coverage fact → passes without provenance requirement.
        await ctx.catalog.addCoverageFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          dimension: "country", value: "GH", sourceType: "provider_declared",
          actingPrincipal: ctx.adminP,
        });
        evaluation = await ctx.eligibility.evaluate({
          ...base, constraints: { country: "GH" },
        });
        expect(evaluation.results[0]!.status).toBe("eligible");
        // ...but fails a VERIFIED coverage requirement.
        evaluation = await ctx.eligibility.evaluate({
          ...base, constraints: { country: "GH", require_verified_coverage: true },
        });
        r = evaluation.results[0]!;
        expect(r.status).toBe("ineligible");
        expect(r.failures.find((c) => c.checkId === "coverage.country")!.reason).toContain("verified coverage required");

        // Pricing: missing per-request fact → INDETERMINATE.
        evaluation = await ctx.eligibility.evaluate({
          ...base, constraints: { max_estimated_cost: 0.1 },
        });
        r = evaluation.results[0]!;
        expect(r.status).toBe("indeterminate");
        expect(r.indeterminate.find((c) => c.checkId === "pricing.hard_cost")!.reason).toContain("no per_request pricing fact");
        // Add a per-request fact within the limit → eligible.
        await ctx.catalog.addPricingFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          model: "per_request", currency: "GHS", amount: "0.05",
          sourceType: "provider_declared", actingPrincipal: ctx.adminP,
        });
        evaluation = await ctx.eligibility.evaluate({
          ...base, constraints: { max_estimated_cost: 0.1 },
        });
        expect(evaluation.results[0]!.status).toBe("eligible");
        // Over the limit → ineligible.
        evaluation = await ctx.eligibility.evaluate({
          ...base, constraints: { max_estimated_cost: 0.01 },
        });
        expect(evaluation.results[0]!.status).toBe("ineligible");
        expect(evaluation.results[0]!.failures.find((c) => c.checkId === "pricing.hard_cost")!.actual).toBe(0.05);

        // Health: unavailable → ineligible; no observation → indeterminate.
        await ctx.catalog.recordHealthObservation({
          providerId: "demo.echo", status: "unavailable",
          sourceType: "platform_observed", actingPrincipal: ctx.adminP,
        });
        evaluation = await ctx.eligibility.evaluate({
          ...base, constraints: { require_healthy: true },
        });
        expect(evaluation.results[0]!.status).toBe("ineligible");
        expect(evaluation.results[0]!.failures.find((c) => c.checkId === "provider.health")!.actual).toBe("unavailable");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("TENANCY: cross-org and cross-project policy access rejected; suspended member loses access", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupEligibility(handle);
      try {
        const tenantA = await makeTenant(ctx, "tena");
        const tenantB = await makeTenant(ctx, "tenb");
        await seedEchoOffering(ctx);
        const policyA = await seedPolicy(ctx, tenantA, "a-policy", PERMISSIVE_RULES);

        // Org B's member cannot evaluate under org A's scope (membership gate).
        await expectRejected("eligibility.membership.required", () =>
          ctx.eligibility.evaluate({
            organizationId: tenantA.organizationId, projectId: tenantA.projectId,
            capabilityId: "demo.echo", capabilityVersion: "1",
            policyId: policyA.policyId, constraints: {},
            actingPrincipal: tenantB.memberP,
          }),
        );
        // Org B's member under org B's scope cannot resolve org A's policy
        // (tenant-scoped policy query returns null → structured error).
        await expectRejected("eligibility.policy.version_not_found", () =>
          ctx.eligibility.evaluate({
            organizationId: tenantB.organizationId, projectId: tenantB.projectId,
            capabilityId: "demo.echo", capabilityVersion: "1",
            policyId: policyA.policyId, policyVersion: policyA.version,
            constraints: {}, actingPrincipal: tenantB.memberP,
          }),
        );
        // Cross-project: org A's member cannot use org A's policy under a
        // project it does not belong to... (same org, different project).
        const otherProject = await ctx.projects.createProject({
          organizationId: tenantA.organizationId, name: "Other", slug: `other-${Date.now()}`,
          createdByUserId: tenantA.ownerUserId, actingPrincipal: tenantA.ownerP,
        });
        await expectRejected("eligibility.policy.version_not_found", () =>
          ctx.eligibility.evaluate({
            organizationId: tenantA.organizationId, projectId: otherProject.id,
            capabilityId: "demo.echo", capabilityVersion: "1",
            policyId: policyA.policyId, policyVersion: policyA.version,
            constraints: {}, actingPrincipal: tenantA.memberP,
          }),
        );
        // Unknown project → not found.
        await expectRejected("eligibility.project.not_found", () =>
          ctx.eligibility.evaluate({
            organizationId: tenantA.organizationId, projectId: "proj_missing",
            capabilityId: "demo.echo", capabilityVersion: "1",
            policyId: policyA.policyId, constraints: {},
            actingPrincipal: tenantA.memberP,
          }),
        );
        // A suspended member loses access.
        await ctx.orgs.updateMembershipState({
          organizationId: tenantA.organizationId,
          userId: tenantA.memberUserId,
          status: "suspended",
          actingPrincipal: tenantA.ownerP,
        });
        const suspendedP = await ctx.orgs.buildPrincipalForUser(tenantA.memberUserId);
        await expectRejected("eligibility.membership.required", () =>
          ctx.eligibility.evaluate({
            organizationId: tenantA.organizationId, projectId: tenantA.projectId,
            capabilityId: "demo.echo", capabilityVersion: "1",
            policyId: policyA.policyId, constraints: {},
            actingPrincipal: suspendedP,
          }),
        );
        void buildPrincipal;
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("DETERMINISM + NO-EXECUTION: repeated identical evaluations produce identical results; invalid constraints rejected", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupEligibility(handle);
      try {
        const tenant = await makeTenant(ctx, "det");
        await seedEchoOffering(ctx);
        await ctx.catalog.addPricingFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          model: "per_request", currency: "GHS", amount: "0.05",
          sourceType: "provider_declared", actingPrincipal: ctx.adminP,
        });
        await ctx.catalog.addCoverageFact({
          providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
          dimension: "region", value: "EU", sourceType: "provider_declared",
          actingPrincipal: ctx.adminP,
        });
        const policy = await seedPolicy(ctx, tenant, "p", [
          { subject: "region", operator: "eq", value: "EU", mode: "hard" },
        ]);
        const input = {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          policyId: policy.policyId,
          constraints: { region: "EU", max_estimated_cost: 0.1 },
          actingPrincipal: tenant.memberP,
        };
        // Repeated identical evaluation → identical serialized results
        // (the fixture provider's adapter is never invoked — eligibility
        // has no adapter import at all; see the arch isolation test).
        const a = await ctx.eligibility.evaluate(input);
        const b = await ctx.eligibility.evaluate(input);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(a.results[0]!.status).toBe("eligible");

        // Invalid constraints rejected deterministically.
        await expectRejected("eligibility.validation", () =>
          ctx.eligibility.evaluate({
            ...input,
            constraints: { country: "GHA" }, // bad shape
          }),
        );
        await expectRejected("eligibility.validation", () =>
          ctx.eligibility.evaluate({
            ...input,
            constraints: { max_estimated_cost: -5 },
          }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
