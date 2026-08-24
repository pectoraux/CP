// tests/security/catalog-authority.test.ts — WORK-007 §21 security tests.
// The marketplace catalog is GLOBAL CP-level infrastructure. Proves:
//   - an arbitrary organization owner/admin/member (and a cross-org owner)
//     WITHOUT the capability-admin grant cannot mutate the catalog
//     (403 catalog.admin.required on pricing/coverage/health/verification)
//   - a user WITH the grant mutates; reads are open to any principal
//   - no secrets leak: catalog tables/API responses never contain
//     credential VALUES (only requirement NAMES); DB-level scan of all
//     catalog tables for the fixture credential value
//   - tenant isolation: NO organization_id/project_id/tenant columns on
//     any global catalog table (information_schema assertion) — tenant
//     connection data cannot leak into global catalog records
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { AppError } from "@cp/platform";
import {
  OrganizationsService,
  migrateOrganizationsSchema,
} from "@cp/organizations";
import { setupCatalog, makeOrdinaryUser } from "../catalog/helpers.ts";

async function expectRejectedWith(code: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    expect((err as AppError).code).toBe(code);
  }
  expect(threw).toBe(true);
}

describe("WORK-007 catalog authority + tenant/secret isolation", () => {
  it("org owner / admin / member / cross-org owner cannot mutate the global catalog (all 403 catalog.admin.required)", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle, { applicationName: "cp-test-cat-auth" });
      const { db, auth, cleanup } = ctx;
      const orgs = new OrganizationsService({ db });
      try {
        const ownerA = await auth.createUser({
          email: `catsec1-${Date.now()}@e.com`, password: "password123",
        });
        const adminA = await auth.createUser({
          email: `catsec2-${Date.now()}@e.com`, password: "password123",
        });
        const memberA = await auth.createUser({
          email: `catsec3-${Date.now()}@e.com`, password: "password123",
        });
        const { organization: orgA } = await orgs.createOrganizationWithOwner({
          ownerUserId: ownerA.id, name: "OrgA", slug: `catorga-${Date.now()}`,
        });
        const ownerAP = await orgs.buildPrincipalForUser(ownerA.id);
        await orgs.addMember({ organizationId: orgA.id, userId: adminA.id, role: "admin", actingPrincipal: ownerAP });
        await orgs.addMember({ organizationId: orgA.id, userId: memberA.id, role: "member", actingPrincipal: ownerAP });
        const ownerB = await auth.createUser({
          email: `catsec4-${Date.now()}@e.com`, password: "password123",
        });
        await orgs.createOrganizationWithOwner({
          ownerUserId: ownerB.id, name: "OrgB", slug: `catorgb-${Date.now()}`,
        });

        const principals: [string, Awaited<ReturnType<typeof orgs.buildPrincipalForUser>>][] = [
          ["org owner", await orgs.buildPrincipalForUser(ownerA.id)],
          ["org admin", await orgs.buildPrincipalForUser(adminA.id)],
          ["org member", await orgs.buildPrincipalForUser(memberA.id)],
          ["cross-org owner", await orgs.buildPrincipalForUser(ownerB.id)],
        ];
        for (const [label, principal] of principals) {
          await expectRejectedWith("catalog.admin.required", () =>
            ctx.catalog.addPricingFact({
              providerId: "demo.echo",
              capabilityId: "demo.echo",
              capabilityVersion: "1",
              model: "per_request",
              amount: "1",
              sourceType: "provider_declared",
              actingPrincipal: principal,
            }),
          );
          await expectRejectedWith("catalog.admin.required", () =>
            ctx.catalog.addCoverageFact({
              providerId: "demo.echo",
              capabilityId: "demo.echo",
              capabilityVersion: "1",
              dimension: "country",
              value: "GH",
              sourceType: "provider_declared",
              actingPrincipal: principal,
            }),
          );
          await expectRejectedWith("catalog.admin.required", () =>
            ctx.catalog.recordHealthObservation({
              providerId: "demo.echo",
              status: "healthy",
              sourceType: "platform_observed",
              actingPrincipal: principal,
            }),
          );
          void label;
        }

        // Ordinary user without any org: also refused.
        const plainP = await makeOrdinaryUser(ctx);
        await expectRejectedWith("catalog.admin.required", () =>
          ctx.catalog.addPricingFact({
            providerId: "demo.echo",
            capabilityId: "demo.echo",
            capabilityVersion: "1",
            model: "fixed",
            amount: "1",
            sourceType: "provider_declared",
            actingPrincipal: plainP,
          }),
        );

        // Reads remain open (any principal; HTTP layer gates on auth only).
        const page = await ctx.catalog.listOfferings({ limit: 10 });
        expect(page.offerings.length).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  it("admin-gated verification is protected; a non-admin cannot verify facts", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle, { applicationName: "cp-test-cat-verify-auth" });
      const { catalog, adminP, cleanup } = ctx;
      try {
        const fact = await catalog.addCoverageFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          dimension: "country",
          value: "GH",
          sourceType: "provider_declared",
          actingPrincipal: adminP,
        });
        const userP = await makeOrdinaryUser(ctx);
        await expectRejectedWith("catalog.admin.required", () =>
          catalog.verifyCoverageFact({
            factId: fact.id,
            evidenceReference: "https://evidence.example/x",
            actingPrincipal: userP,
          }),
        );
        // The fact is unchanged by the refused verification.
        const unchanged = await catalog.getCoverageFact(fact.id);
        expect(unchanged?.status).toBe("declared");
      } finally {
        await cleanup();
      }
    });
  });

  it("SECRET ISOLATION: no credential values in catalog tables; offering exposes requirement NAMES only; no tenant columns on global catalog tables", async () => {
    await withInfra(async (handle) => {
      const ctx = await setupCatalog(handle, { applicationName: "cp-test-cat-secrets" });
      const { db, catalog, adminP, providers, cleanup } = ctx;
      try {
        // Record all three fact kinds, then run the provider contract
        // tests (whose internal fixture credential value must never
        // surface anywhere in catalog data).
        await catalog.addPricingFact({
          providerId: "demo.echo",
          capabilityId: "demo.echo",
          capabilityVersion: "1",
          model: "per_request",
          currency: "GHS",
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
          status: "healthy",
          sourceType: "platform_observed",
          actingPrincipal: adminP,
        });
        await providers.runContractTests({
          providerId: "demo.echo",
          actingPrincipal: adminP,
        });

        // DB-level scan: no catalog table contains the fixture secret.
        const secretHits = await db.query({
          text: `SELECT
                   (SELECT count(*)::int FROM cp_catalog_pricing
                    WHERE to_jsonb(cp_catalog_pricing)::text LIKE '%fixture-contract-test-credential%') AS pricing,
                   (SELECT count(*)::int FROM cp_catalog_coverage
                    WHERE to_jsonb(cp_catalog_coverage)::text LIKE '%fixture-contract-test-credential%') AS coverage,
                   (SELECT count(*)::int FROM cp_catalog_health
                    WHERE to_jsonb(cp_catalog_health)::text LIKE '%fixture-contract-test-credential%') AS health`,
          params: [],
        });
        expect(Number(secretHits[0]!.pricing)).toBe(0);
        expect(Number(secretHits[0]!.coverage)).toBe(0);
        expect(Number(secretHits[0]!.health)).toBe(0);

        // The offering representation carries credential requirement
        // NAMES only — never kinds-with-values, never secrets.
        const page = await catalog.listOfferings({ limit: 10 });
        const offering = page.offerings[0]!;
        expect(offering.implementation.credentialRequirementNames).toEqual(["api_key"]);
        const offeringJson = JSON.stringify(offering);
        expect(offeringJson.includes("fixture-contract-test-credential")).toBe(false);
        expect(offeringJson.includes("secret")).toBe(false);
        expect(offeringJson.includes("api_key")).toBe(true); // name metadata is fine

        // TENANCY: no tenant columns on global catalog tables.
        const cols = await db.query({
          text: `SELECT table_name, column_name FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name IN ('cp_catalog_pricing', 'cp_catalog_coverage', 'cp_catalog_health')
                   AND column_name IN ('organization_id', 'project_id', 'org_id', 'tenant_id')`,
          params: [],
        });
        expect(cols.length).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });
});
