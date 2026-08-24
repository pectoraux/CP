// tests/catalog/concurrency.test.ts — WORK-007 race-safety against REAL
// PostgreSQL (WORK-007 §24 CONCURRENCY). Database constraints are
// authoritative:
//   - concurrent identical pricing fact creation → exactly one succeeds
//     (unique index on declaration+model+currency+unit+effective_at+source)
//   - concurrent identical coverage fact insertion → exactly one succeeds
//     (unique index on declaration+dimension+value+source)
//   - concurrent price REVISION (different effective_at) → both persist
//     (append-only history; that is the point of versioned pricing)
//   - concurrent health observations → both persist (append-only; no
//     uniqueness — observations are history)
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { AppError } from "@cp/platform";
import { setupCatalog } from "./helpers.ts";

describe("WORK-007 catalog concurrency (real PostgreSQL)", () => {
  it("concurrent identical pricing fact creation → exactly one succeeds (DB constraint authoritative)", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle);
      const { catalog, adminP, capabilities, cleanup } = ctx;
      try {
        // Warm the pool so the two inserts genuinely overlap.
        await Promise.all([
          capabilities.isCapabilityAdmin("warmup"),
          capabilities.isCapabilityAdmin("warmup"),
          capabilities.isCapabilityAdmin("warmup"),
          capabilities.isCapabilityAdmin("warmup"),
        ]);
        const input = {
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "per_request" as const,
          currency: "GHS",
          unit: "request",
          amount: "0.05",
          effectiveAt: "2026-01-01T00:00:00Z",
          sourceType: "provider_declared" as const,
          actingPrincipal: adminP,
        };
        const results = await Promise.allSettled([
          catalog.addPricingFact(input),
          catalog.addPricingFact(input),
        ]);
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const fail = results.filter((r) => r.status === "rejected").length;
        expect(ok).toBe(1);
        expect(fail).toBe(1);
        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect((rejected.reason as AppError).code).toBe("catalog.pricing.duplicate");
      } finally {
        await cleanup();
      }
    });
  });

  it("concurrent price REVISION with different effective_at → both persist (append-only history)", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle);
      const { catalog, adminP, capabilities, cleanup } = ctx;
      try {
        await Promise.all([
          capabilities.isCapabilityAdmin("warmup"),
          capabilities.isCapabilityAdmin("warmup"),
        ]);
        const results = await Promise.allSettled([
          catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "per_request",
            currency: "GHS",
            amount: "0.05",
            effectiveAt: "2026-01-01T00:00:00Z",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
          catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "per_request",
            currency: "GHS",
            amount: "0.07",
            effectiveAt: "2026-06-01T00:00:00Z",
            sourceType: "provider_declared",
            actingPrincipal: adminP,
          }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(2);
      } finally {
        await cleanup();
      }
    });
  });

  it("concurrent identical coverage insertion → exactly one succeeds", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle);
      const { catalog, adminP, capabilities, cleanup } = ctx;
      try {
        await Promise.all([
          capabilities.isCapabilityAdmin("warmup"),
          capabilities.isCapabilityAdmin("warmup"),
          capabilities.isCapabilityAdmin("warmup"),
        ]);
        const input = {
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          dimension: "country" as const,
          value: "GH",
          sourceType: "provider_declared" as const,
          actingPrincipal: adminP,
        };
        const results = await Promise.allSettled([
          catalog.addCoverageFact(input),
          catalog.addCoverageFact(input),
        ]);
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect((rejected.reason as AppError).code).toBe("catalog.coverage.duplicate");
      } finally {
        await cleanup();
      }
    });
  });

  it("concurrent health observations both persist (append-only observations)", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle);
      const { catalog, adminP, capabilities, cleanup } = ctx;
      try {
        await Promise.all([
          capabilities.isCapabilityAdmin("warmup"),
          capabilities.isCapabilityAdmin("warmup"),
        ]);
        const results = await Promise.allSettled([
          catalog.recordHealthObservation({
            providerId: "demo.echo",
            status: "healthy",
            sourceType: "platform_observed",
            actingPrincipal: adminP,
          }),
          catalog.recordHealthObservation({
            providerId: "demo.echo",
            status: "degraded",
            sourceType: "platform_observed",
            actingPrincipal: adminP,
          }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(2);
      } finally {
        await cleanup();
      }
    });
  });
});
