// tests/catalog/facts.test.ts — WORK-007 catalog fact persistence against
// REAL PostgreSQL: pricing, coverage, health, and the provenance model
// (DECLARED / OBSERVED / VERIFIED / CERTIFIED — architecture §9).
//
// Proves (WORK-007 §24):
//   PRICING: create declared pricing; multiple models; versioning with
//   effective_at (history never overwritten); invalid pricing rejected;
//   verification transition requires evidence
//   COVERAGE: country/region/currency; capability-specific coverage;
//   invalid coverage rejected; declared vs observed coexist
//   HEALTH: observation persistence; provenance; timestamps; status
//   validation; provider-wide vs capability-scoped
//   PROVENANCE: declared/observed/verified remain distinct; source
//   metadata preserved; a provider claim is never stored as verified
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { AppError } from "@cp/platform";
import { setupCatalog, makeOrdinaryUser } from "./helpers.ts";

describe("WORK-007 catalog pricing facts (real PostgreSQL)", () => {
  it("declared pricing persists with provenance; multiple models supported", async () => {
    await withInfra(async (handle) => {
      const { catalog, adminP, cleanup } = await setupCatalog(handle);
      try {
        const perRequest = await catalog.addPricingFact({
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
        expect(perRequest.model).toBe("per_request");
        expect(perRequest.currency).toBe("GHS");
        expect(perRequest.amount).toBe("0.05");
        // A provider claim is stored as DECLARED — never verified truth.
        expect(perRequest.sourceType).toBe("provider_declared");
        expect(perRequest.status).toBe("declared");
        expect(perRequest.verifiedAt).toBeNull();
        expect(perRequest.evidenceReference).toBeNull();

        const perToken = await catalog.addPricingFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "per_token",
          currency: "USD",
          unit: "1k_tokens",
          amount: 0.002,
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        expect(perToken.model).toBe("per_token");

        const percentage = await catalog.addPricingFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "percentage",
          amount: "2.9",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        expect(percentage.currency).toBeNull();
        expect(percentage.amount).toBe("2.9");

        const tiered = await catalog.addPricingFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "tiered",
          currency: "USD",
          amount: "0",
          tiers: [
            { up_to: 10000, amount: "0.10" },
            { amount: "0.05" },
          ],
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        expect(tiered.model).toBe("tiered");
        expect(Array.isArray(tiered.tiers)).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("price revision = NEW fact with later effective_at; history is never overwritten", async () => {
    await withInfra(async (handle) => {
      const { catalog, adminP, cleanup } = await setupCatalog(handle);
      try {
        const v1 = await catalog.addPricingFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "per_request",
          currency: "GHS",
          amount: "0.05",
          effectiveAt: "2026-01-01T00:00:00Z",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        expect(v1.amount).toBe("0.05");
        // A price change is a NEW append-only fact — the old one survives.
        const v2 = await catalog.addPricingFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "per_request",
          currency: "GHS",
          amount: "0.07",
          effectiveAt: "2026-06-01T00:00:00Z",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        expect(v2.amount).toBe("0.07");
        const stillThere = await catalog.getPricingFact(v1.id);
        expect(stillThere?.amount).toBe("0.05");
        expect(stillThere?.effectiveAt.getTime()).toBeLessThan(v2.effectiveAt.getTime());
      } finally {
        await cleanup();
      }
    });
  });

  it("invalid pricing rejected: bad model, negative amount, bad currency, tiers on non-tiered, unknown provider/capability/version", async () => {
    await withInfra(async (handle) => {
      const { catalog, adminP, cleanup } = await setupCatalog(handle);
      try {
        await expectRejected("catalog.validation", async () =>
          catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "per_gpu_hour" as never,
            amount: "1",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.validation", async () =>
          catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "fixed",
            amount: "-5",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.validation", async () =>
          catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "fixed",
            currency: "ghs",
            amount: "1",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.validation", async () =>
          catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "fixed",
            amount: "1",
            tiers: [{ amount: "1" }],
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.validation", async () =>
          catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "tiered",
            amount: "1",
            tiers: [],
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        // Unknown declaration (provider does not exist).
        await expectRejected("catalog.declaration.not_found", async () =>
          catalog.addPricingFact({
            providerId: "nope.provider",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "fixed",
            amount: "1",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        // Unknown capability version.
        await expectRejected("catalog.declaration.not_found", async () =>
          catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "9",
            model: "fixed",
            amount: "1",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        // Duplicate identical fact rejected (DB unique constraint).
        const dup = await catalog.addPricingFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "fixed",
          currency: "USD",
          amount: "10",
          effectiveAt: "2026-01-01T00:00:00Z",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        expect(dup.id).toBeTruthy();
        await expectRejected("catalog.pricing.duplicate", async () =>
          catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "fixed",
            currency: "USD",
            amount: "10",
            effectiveAt: "2026-01-01T00:00:00Z",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
      } finally {
        await cleanup();
      }
    });
  });

  it("verification transition: declared → verified requires evidence; observed facts stay distinct", async () => {
    await withInfra(async (handle) => {
      const { catalog, adminP, cleanup } = await setupCatalog(handle);
      try {
        const declared = await catalog.addPricingFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "per_request",
          currency: "GHS",
          amount: "0.05",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        // A platform observation of the SAME price is a DISTINCT fact
        // (different provenance) — the distinction is the point.
        const observed = await catalog.addPricingFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "per_request",
          currency: "GHS",
          amount: "0.05",
          sourceType: "platform_observed",
          actingPrincipal: adminP,
        });
        expect(observed.id).not.toBe(declared.id);
        expect(observed.status).toBe("observed");
        expect(observed.observedAt).not.toBeNull();
        expect(declared.observedAt).toBeNull();

        // Verification without evidence is refused.
        await expectRejected("catalog.validation", async () =>
          catalog.verifyPricingFact({
            factId: declared.id,
            evidenceReference: "   ",
            actingPrincipal: adminP,
          }),
        );
        const verified = await catalog.verifyPricingFact({
          factId: declared.id,
          evidenceReference: "https://provider.example/pricing#per-request",
          actingPrincipal: adminP,
        });
        expect(verified.status).toBe("verified");
        expect(verified.verifiedAt).not.toBeNull();
        expect(verified.evidenceReference).toBe("https://provider.example/pricing#per-request");
        // The observed fact is UNCHANGED — verification is per-fact.
        const observedStill = await catalog.getPricingFact(observed.id);
        expect(observedStill?.status).toBe("observed");
        // Re-verifying is refused.
        await expectRejected("catalog.fact.already_verified", async () =>
          catalog.verifyPricingFact({
            factId: declared.id,
            evidenceReference: "x",
            actingPrincipal: adminP,
          }),
        );
        // Unknown fact id.
        await expectRejected("catalog.pricing.not_found", async () =>
          catalog.verifyPricingFact({
            factId: "prc_missing",
            evidenceReference: "x",
            actingPrincipal: adminP,
          }),
        );
      } finally {
        await cleanup();
      }
    });
  });

  it("non-admin cannot record pricing facts (catalog.admin.required)", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle);
      const { catalog, cleanup } = ctx;
      try {
        const userP = await makeOrdinaryUser(ctx);
        await expectRejected("catalog.admin.required", async () =>
          catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "fixed",
            amount: "1",
            sourceType: "provider_declared",
            actingPrincipal: userP,
          }),
        );
      } finally {
        await cleanup();
      }
    });
  });
});

describe("WORK-007 catalog coverage facts (real PostgreSQL)", () => {
  it("country / region / currency coverage persists with provenance; capability-specific", async () => {
    await withInfra(async (handle) => {
      const { catalog, adminP, cleanup } = await setupCatalog(handle);
      try {
        const gh = await catalog.addCoverageFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          dimension: "country",
          value: "GH",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        expect(gh.dimension).toBe("country");
        expect(gh.value).toBe("GH");
        expect(gh.status).toBe("declared");

        const ghs = await catalog.addCoverageFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          dimension: "currency",
          value: "GHS",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        expect(ghs.value).toBe("GHS");

        const emea = await catalog.addCoverageFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          dimension: "region",
          value: "EMEA",
          sourceType: "platform_observed",
          actingPrincipal: adminP,
        });
        expect(emea.status).toBe("observed");

        // A DECLARED and an OBSERVED fact for the same dimension+value
        // coexist as distinct rows (provenance distinction).
        const ghObserved = await catalog.addCoverageFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          dimension: "country",
          value: "GH",
          sourceType: "platform_observed",
          actingPrincipal: adminP,
        });
        expect(ghObserved.id).not.toBe(gh.id);
        expect(ghObserved.status).toBe("observed");
      } finally {
        await cleanup();
      }
    });
  });

  it("invalid coverage rejected: bad dimension, malformed values, unknown declaration, duplicates", async () => {
    await withInfra(async (handle) => {
      const { catalog, adminP, cleanup } = await setupCatalog(handle);
      try {
        await expectRejected("catalog.validation", async () =>
          catalog.addCoverageFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            dimension: "planet" as never,
            value: "EARTH",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.validation", async () =>
          catalog.addCoverageFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            dimension: "country",
            value: "GHA",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.validation", async () =>
          catalog.addCoverageFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            dimension: "currency",
            value: "GH",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.validation", async () =>
          catalog.addCoverageFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            dimension: "region",
            value: "west africa",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.declaration.not_found", async () =>
          catalog.addCoverageFact({
            providerId: "missing.provider",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            dimension: "country",
            value: "GH",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
        const cov = await catalog.addCoverageFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          dimension: "country",
          value: "KE",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        expect(cov.id).toBeTruthy();
        await expectRejected("catalog.coverage.duplicate", async () =>
          catalog.addCoverageFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            dimension: "country",
            value: "KE",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        );
      } finally {
        await cleanup();
      }
    });
  });

  it("coverage verification: declared → verified with evidence", async () => {
    await withInfra(async (handle) => {
      const { catalog, adminP, cleanup } = await setupCatalog(handle);
      try {
        const cov = await catalog.addCoverageFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          dimension: "country",
          value: "GH",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        const verified = await catalog.verifyCoverageFact({
          factId: cov.id,
          evidenceReference: "evid_abc123",
          actingPrincipal: adminP,
        });
        expect(verified.status).toBe("verified");
        expect(verified.verifiedAt).not.toBeNull();
        expect(verified.evidenceReference).toBe("evid_abc123");
        await expectRejected("catalog.fact.already_verified", async () =>
          catalog.verifyCoverageFact({
            factId: cov.id,
            evidenceReference: "again",
            actingPrincipal: adminP,
          }),
        );
      } finally {
        await cleanup();
      }
    });
  });
});

describe("WORK-007 catalog health observations (real PostgreSQL)", () => {
  it("health observation persists with provenance + timestamps; provider-wide and capability-scoped", async () => {
    await withInfra(async (handle) => {
      const { catalog, adminP, cleanup } = await setupCatalog(handle);
      try {
        // Provider-wide observation.
        const providerWide = await catalog.recordHealthObservation({
          providerId: "demo.echo",
          status: "healthy",
          metrics: { availability: 0.999, latency_p99_ms: 120 },
          sourceType: "platform_observed",
          evidenceReference: "observation:obs_1",
          actingPrincipal: adminP,
        });
        expect(providerWide.status).toBe("healthy");
        expect(providerWide.providerCapabilityId).toBeNull();
        expect(providerWide.metrics).toEqual({ availability: 0.999, latency_p99_ms: 120 });
        expect(providerWide.observedAt).not.toBeNull();
        expect(providerWide.sourceType).toBe("platform_observed");

        // Capability-scoped + region-scoped observation.
        const scoped = await catalog.recordHealthObservation({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          region: "EMEA",
          status: "degraded",
          metrics: { success_rate: 0.97 },
          observedAt: "2026-06-01T12:00:00Z",
          sourceType: "platform_observed",
          actingPrincipal: adminP,
        });
        expect(scoped.providerCapabilityId).not.toBeNull();
        expect(scoped.region).toBe("EMEA");
        expect(scoped.status).toBe("degraded");
        expect(scoped.observedAt.toISOString()).toBe("2026-06-01T12:00:00.000Z");

        // Append-only: multiple observations coexist (history).
        await catalog.recordHealthObservation({
          providerId: "demo.echo",
          status: "healthy",
          sourceType: "platform_observed",
          actingPrincipal: adminP,
        });
      } finally {
        await cleanup();
      }
    });
  });

  it("health validation: bad status / bad region / capability without version / unknown provider rejected", async () => {
    await withInfra(async (handle) => {
      const { catalog, adminP, cleanup } = await setupCatalog(handle);
      try {
        await expectRejected("catalog.validation", async () =>
          catalog.recordHealthObservation({
            providerId: "demo.echo",
            status: "exploded" as never,
            sourceType: "platform_observed",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.validation", async () =>
          catalog.recordHealthObservation({
            providerId: "demo.echo",
            region: "west africa",
            status: "healthy",
            sourceType: "platform_observed",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.validation", async () =>
          catalog.recordHealthObservation({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            status: "healthy",
            sourceType: "platform_observed",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.provider.not_found", async () =>
          catalog.recordHealthObservation({
            providerId: "ghost.provider",
            status: "healthy",
            sourceType: "platform_observed",
            actingPrincipal: adminP,
          }),
        );
        await expectRejected("catalog.validation", async () =>
          catalog.recordHealthObservation({
            providerId: "demo.echo",
            status: "healthy",
            sourceType: "gut_feeling" as never,
            actingPrincipal: adminP,
          }),
        );
      } finally {
        await cleanup();
      }
    });
  });
});

async function expectRejected(
  code: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    expect((err as AppError).code).toBe(code);
  }
  expect(threw).toBe(true);
}
