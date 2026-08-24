// tests/eligibility/evaluator.test.ts — WORK-009 PURE evaluator unit
// tests (no infrastructure, no database, no network). Proves:
//   - every check category with pass/fail/indeterminate semantics
//   - the three-way taxonomy (eligible | ineligible | indeterminate)
//   - hard policy violations disqualify; preference violations NEVER do
//   - fixture certification never satisfies certified/live requirements
//   - coverage provenance (declared-only fails a verified requirement)
//   - missing pricing evidence → INDETERMINATE (never silent success)
//   - health semantics (unavailable → fail; unknown/missing → indeterminate)
//   - DETERMINISM: identical inputs → identical results (deep equality)
//   - synthetic named-candidate rejections
//   - the policy context construction (candidate + request facts)
import { describe, expect, it } from "bun:test";
import type { CatalogOffering, PricingFact, CoverageFact, HealthObservation } from "@cp/catalog";
import type { PolicyRule } from "@cp/policies";
import {
  evaluateCandidate,
  candidateDeclarationMissing,
  candidateVersionUnsupported,
  latestPricingFact,
  latestPerRequestPricingFact,
  latestHealthObservation,
  buildPolicyContext,
} from "@cp/eligibility";

// ---- Snapshot builders (plain data — the pure boundary) ----------------------

function pricing(overrides: Partial<PricingFact> = {}): PricingFact {
  return {
    id: "prc_1",
    providerCapabilityId: "provcap_1",
    model: "per_request",
    currency: "GHS",
    unit: "request",
    amount: "0.05",
    minAmount: null,
    maxAmount: null,
    tiers: null,
    effectiveAt: new Date("2026-01-01T00:00:00Z"),
    sourceType: "provider_declared",
    status: "declared",
    observedAt: null,
    verifiedAt: null,
    evidenceReference: null,
    createdByUserId: "usr_1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function coverage(overrides: Partial<CoverageFact> = {}): CoverageFact {
  return {
    id: "cov_1",
    providerCapabilityId: "provcap_1",
    dimension: "country",
    value: "GH",
    sourceType: "provider_declared",
    status: "declared",
    observedAt: null,
    verifiedAt: null,
    evidenceReference: null,
    createdByUserId: "usr_1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function health(overrides: Partial<HealthObservation> = {}): HealthObservation {
  return {
    id: "hlth_1",
    providerId: "prov_1",
    providerCanonicalId: "demo.echo",
    providerCapabilityId: "provcap_1",
    region: null,
    status: "healthy",
    metrics: {},
    observedAt: new Date("2026-01-01T00:00:00Z"),
    sourceType: "platform_observed",
    evidenceReference: null,
    createdByUserId: "usr_1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function offering(overrides: {
  providerStatus?: string;
  versionStatus?: string | null;
  implementationStatus?: string;
  certificationEnvironment?: string;
  integrationPath?: string;
  pricing?: PricingFact[];
  coverage?: CoverageFact[];
  health?: HealthObservation[];
}): CatalogOffering {
  return {
    offeringId: "provcap_1",
    provider: {
      providerId: "demo.echo",
      name: "Echo Demo Provider",
      status: overrides.providerStatus ?? "active",
      integrationPath: overrides.integrationPath ?? "platform_operated",
      documentationUrl: null,
    },
    capability: {
      capabilityId: "demo.echo",
      capabilityVersion: "1",
      capabilityStatus: "active",
      versionStatus: overrides.versionStatus ?? "active",
    },
    implementation: {
      adapterVersion: "1.0.0",
      status: overrides.implementationStatus ?? "registered",
      certificationEnvironment: overrides.certificationEnvironment ?? "none",
      supportedConstraints: {},
      credentialRequirementNames: ["api_key"],
    },
    evidence: { totalTests: 7, passedTests: 7, latestEnvironment: "fixture" },
    pricing: overrides.pricing ?? [],
    coverage: overrides.coverage ?? [],
    health: overrides.health ?? [],
  };
}

// The default test policy: preference-only — hard constraints always pass,
// so policy never disqualifies in tests that exercise OTHER checks.
const POLICY: { policyId: string; policyVersion: string; rules: PolicyRule[] } = {
  policyId: "pol_1",
  policyVersion: "3",
  rules: [
    { id: "rule_1", subject: "integration_path", operator: "eq", value: "platform_operated", mode: "preference" },
  ],
};

// A hard-region policy for the policy-specific tests.
const REGION_POLICY: { policyId: string; policyVersion: string; rules: PolicyRule[] } = {
  policyId: "pol_1",
  policyVersion: "3",
  rules: [
    { id: "rule_1", subject: "region", operator: "eq", value: "EU", mode: "hard" },
    { id: "rule_2", subject: "integration_path", operator: "eq", value: "platform_operated", mode: "preference" },
  ],
};

function evaluate(
  off: CatalogOffering,
  constraints: Record<string, unknown> = {},
  policy = POLICY,
) {
  return evaluateCandidate({
    offering: off,
    constraints: constraints as never,
    policy,
  });
}

describe("WORK-009 pure evaluator — check semantics", () => {
  it("all checks pass → eligible (with coverage, pricing, health, policy facts)", () => {
    const off = offering({
      implementationStatus: "certified",
      certificationEnvironment: "live",
      pricing: [pricing()],
      coverage: [coverage(), coverage({ id: "cov_r", dimension: "region", value: "EU" })],
      health: [health()],
    });
    const r = evaluate(off, {
      country: "GH",
      maxEstimatedCost: 0.1,
      requiredCertification: "certified",
      requireLiveCertification: true,
      requireHealthy: true,
      region: "EU",
    }, REGION_POLICY);
    expect(r.status).toBe("eligible");
    expect(r.failures.length).toBe(0);
    expect(r.indeterminate.length).toBe(0);
    expect(r.satisfied.length).toBe(r.checks.length);
    expect(r.policy?.hardPassed).toBe(true);
    expect(r.policy?.preferenceViolated.length).toBe(0);
  });

  it("provider lifecycle: suspended / deprecated / revoked are ineligible; active passes", () => {
    for (const status of ["suspended", "deprecated", "revoked"]) {
      const r = evaluate(offering({ providerStatus: status }), {});
      expect(r.status, `provider ${status} must be ineligible`).toBe("ineligible");
      const check = r.failures.find((c) => c.checkId === "provider.status")!;
      expect(check.actual).toBe(status);
      expect(check.expected).toContain("not suspended/deprecated/revoked");
    }
    const active = evaluate(offering({ providerStatus: "active" }), {});
    const check = active.checks.find((c) => c.checkId === "provider.status")!;
    expect(check.result).toBe("pass");
  });

  it("retired capability version is ineligible with an explainable reason", () => {
    const r = evaluate(offering({ versionStatus: "retired" }), {});
    expect(r.status).toBe("ineligible");
    const check = r.failures.find((c) => c.checkId === "capability.version_not_retired")!;
    expect(check.actual).toBe("retired");
    expect(check.reason).toContain("retired");
  });

  it("certification levels: registered/contract_verified fail a certified requirement; certified passes (fixture ≠ certified)", () => {
    let r = evaluate(offering({ implementationStatus: "contract_verified", certificationEnvironment: "fixture" }), {
      requiredCertification: "certified",
      requireLiveCertification: true,
    });
    expect(r.status).toBe("ineligible");
    let check = r.failures.find((c) => c.checkId === "certification.level")!;
    expect(check.expected).toBe("certified");
    expect(check.actual).toBe("contract_verified");
    expect(check.reason).toContain("not certified");
    check = r.failures.find((c) => c.checkId === "certification.environment")!;
    expect(check.expected).toBe("live");
    expect(check.actual).toBe("fixture");

    r = evaluate(offering({ implementationStatus: "certified", certificationEnvironment: "live" }), {
      requiredCertification: "certified",
      requireLiveCertification: true,
    });
    expect(r.status).toBe("eligible");

    r = evaluate(offering({ implementationStatus: "contract_verified" }), {
      requiredCertification: "contract_verified",
    });
    expect(r.checks.find((c) => c.checkId === "certification.level")!.result).toBe("pass");
  });

  it("coverage: supported country/region/currency pass; unsupported fail; provenance-aware verification", () => {
    const off = offering({
      coverage: [
        coverage(),
        coverage({ id: "cov_2", dimension: "region", value: "EMEA", status: "verified" }),
        coverage({ id: "cov_3", dimension: "currency", value: "GHS", status: "observed" }),
      ],
    });
    let r = evaluate(off, { country: "GH" });
    expect(r.checks.find((c) => c.checkId === "coverage.country")!.result).toBe("pass");
    r = evaluate(off, { country: "US" });
    expect(r.status).toBe("ineligible");
    let check = r.failures.find((c) => c.checkId === "coverage.country")!;
    expect(check.expected).toBe("US");
    expect(check.actual).toBe("not covered");
    r = evaluate(off, { region: "EMEA", requireVerifiedCoverage: true });
    expect(r.checks.find((c) => c.checkId === "coverage.region")!.result).toBe("pass");
    r = evaluate(off, { country: "GH", requireVerifiedCoverage: true });
    expect(r.status).toBe("ineligible");
    check = r.failures.find((c) => c.checkId === "coverage.country")!;
    expect(check.reason).toContain("verified coverage required");
    expect(check.evidence).toBe("cov_1");
    r = evaluate(off, { currency: "GHS", requireVerifiedCoverage: true });
    check = r.failures.find((c) => c.checkId === "coverage.currency")!;
    expect(check.result).toBe("fail");
    r = evaluate(off, { currency: "GHS" });
    expect(r.checks.find((c) => c.checkId === "coverage.currency")!.result).toBe("pass");
  });

  it("pricing: within limit passes; over limit fails; missing fact / currency mismatch → INDETERMINATE", () => {
    const off = offering({ pricing: [pricing({ amount: "0.05" })] });
    let r = evaluate(off, { maxEstimatedCost: 0.1 });
    expect(r.checks.find((c) => c.checkId === "pricing.hard_cost")!.result).toBe("pass");
    r = evaluate(off, { maxEstimatedCost: 0.01 });
    expect(r.status).toBe("ineligible");
    const check = r.failures.find((c) => c.checkId === "pricing.hard_cost")!;
    expect(check.actual).toBe(0.05);
    expect(check.expected).toContain("<= 0.01");
    expect(check.reason).toContain("exceeds");
    const noPricing = offering({});
    r = evaluate(noPricing, { maxEstimatedCost: 0.1 });
    expect(r.status).toBe("indeterminate");
    const ind = r.indeterminate.find((c) => c.checkId === "pricing.hard_cost")!;
    expect(ind.reason).toContain("no per_request pricing fact");
    r = evaluate(off, { maxEstimatedCost: 0.1, maxEstimatedCostCurrency: "USD" });
    expect(r.status).toBe("indeterminate");
    expect(r.indeterminate.find((c) => c.checkId === "pricing.hard_cost")!.reason).toContain("currency");
    r = evaluate(off, { maxEstimatedCost: 0.1, maxEstimatedCostCurrency: "GHS" });
    expect(r.checks.find((c) => c.checkId === "pricing.hard_cost")!.result).toBe("pass");
    r = evaluate(offering({ pricing: [pricing({ model: "per_minute" })] }), { maxEstimatedCost: 1 });
    expect(r.status).toBe("indeterminate");
  });

  it("pricing determinism: the LATEST effective per_request fact is selected (tie-break max id)", () => {
    const off = offering({
      pricing: [
        pricing({ id: "prc_old", amount: "0.50", effectiveAt: new Date("2026-01-01T00:00:00Z") }),
        pricing({ id: "prc_new", amount: "0.05", effectiveAt: new Date("2026-06-01T00:00:00Z") }),
      ],
    });
    const r = evaluate(off, { maxEstimatedCost: 0.1 });
    expect(r.checks.find((c) => c.checkId === "pricing.hard_cost")!.result).toBe("pass");
    expect(r.snapshot.perRequestPricingFact?.id).toBe("prc_new");
    const tie = offering({
      pricing: [
        pricing({ id: "prc_a", amount: "9", effectiveAt: new Date("2026-01-01T00:00:00Z") }),
        pricing({ id: "prc_b", amount: "0.01", effectiveAt: new Date("2026-01-01T00:00:00Z") }),
      ],
    });
    expect(latestPerRequestPricingFact(tie)?.id).toBe("prc_b");
  });

  it("health: unavailable → fail; unknown → indeterminate; missing → indeterminate; healthy/degraded → pass", () => {
    let r = evaluate(offering({ health: [health({ status: "unavailable" })] }), { requireHealthy: true });
    expect(r.status).toBe("ineligible");
    expect(r.failures.find((c) => c.checkId === "provider.health")!.actual).toBe("unavailable");
    r = evaluate(offering({ health: [health({ status: "unknown" })] }), { requireHealthy: true });
    expect(r.status).toBe("indeterminate");
    expect(r.indeterminate.find((c) => c.checkId === "provider.health")!.actual).toBe("unknown");
    r = evaluate(offering({}), { requireHealthy: true });
    expect(r.status).toBe("indeterminate");
    expect(r.indeterminate.find((c) => c.checkId === "provider.health")!.actual).toBe("no health observation");
    r = evaluate(offering({ health: [health({ status: "degraded" })] }), { requireHealthy: true });
    expect(r.checks.find((c) => c.checkId === "provider.health")!.result).toBe("pass");
    const two = offering({
      health: [
        health({ id: "h_old", status: "healthy", observedAt: new Date("2026-01-01T00:00:00Z") }),
        health({ id: "h_new", status: "unavailable", observedAt: new Date("2026-06-01T00:00:00Z") }),
      ],
    });
    expect(latestHealthObservation(two)?.id).toBe("h_new");
    r = evaluate(two, { requireHealthy: true });
    expect(r.status).toBe("ineligible");
  });

  it("POLICY: hard violation → ineligible; preference violation NEVER disqualifies (§8)", () => {
    // Hard violation: the request region is US (policy wants EU).
    let r = evaluate(offering({}), { region: "US" }, REGION_POLICY);
    expect(r.status).toBe("ineligible");
    const check = r.failures.find((c) => c.checkId === "policy.hard_constraints")!;
    expect(check.reason).toContain("rule_1");
    expect(r.policy?.hardViolations.length).toBe(1);
    expect(r.policy?.hardViolations[0]!.ruleId).toBe("rule_1");
    // Preference violation only → still eligible: the candidate covers EU
    // (hard policy passes) but its integration path violates the preference.
    const providerOp = offering({
      integrationPath: "provider_operated",
      coverage: [coverage({ id: "cov_r", dimension: "region", value: "EU" })],
    });
    r = evaluate(providerOp, { region: "EU" }, REGION_POLICY);
    expect(r.status).toBe("eligible");
    expect(r.policy?.preferenceViolated.length).toBe(1);
    expect(r.policy?.preferenceViolated[0]!.ruleId).toBe("rule_2");
    expect(r.policy?.hardPassed).toBe(true);
  });

  it("integration path requirement: mismatch fails, match passes", () => {
    let r = evaluate(offering({ integrationPath: "provider_operated" }), {
      requiredIntegrationPath: "platform_operated",
    });
    expect(r.failures.find((c) => c.checkId === "provider.integration_path")!.actual).toBe("provider_operated");
    r = evaluate(offering({ integrationPath: "provider_operated" }), {
      requiredIntegrationPath: "provider_operated",
    });
    expect(r.checks.find((c) => c.checkId === "provider.integration_path")!.result).toBe("pass");
  });

  it("synthetic named-candidate rejections: declaration missing / version unsupported", () => {
    const missing = candidateDeclarationMissing("ghost.provider", POLICY);
    expect(missing.status).toBe("ineligible");
    expect(missing.failures[0]!.checkId).toBe("provider.declaration_exists");
    expect(missing.failures[0]!.reason).toContain("ghost.provider");
    expect(missing.policy).toBeNull();

    const unsupported = candidateVersionUnsupported("other.provider", POLICY, ["2", "3"]);
    expect(unsupported.status).toBe("ineligible");
    const check = unsupported.failures[0]!;
    expect(check.checkId).toBe("capability.version_supported");
    expect(check.actual).toContain("2, 3");
  });

  it("explainability: every failure carries category/expected/actual/reason; snapshot records versions and facts", () => {
    const off = offering({
      implementationStatus: "contract_verified",
      certificationEnvironment: "fixture",
      pricing: [pricing()],
      health: [health()],
    });
    const r = evaluate(off, { requiredCertification: "certified" });
    expect(r.status).toBe("ineligible");
    for (const f of r.failures) {
      expect(f.checkId.length).toBeGreaterThan(0);
      expect(f.category.length).toBeGreaterThan(0);
      expect(typeof f.reason).toBe("string");
      expect(f.reason.length).toBeGreaterThan(0);
    }
    expect(r.snapshot.policyId).toBe("pol_1");
    expect(r.snapshot.policyVersion).toBe("3");
    expect(r.snapshot.offeringId).toBe("provcap_1");
    expect(r.snapshot.implementationStatus).toBe("contract_verified");
    expect(r.snapshot.perRequestPricingFact?.id).toBe("prc_1");
    expect(r.snapshot.healthObservation?.id).toBe("hlth_1");
  });
});

describe("WORK-009 pure evaluator — DETERMINISM", () => {
  it("identical inputs produce identical results (deep equality, repeated)", () => {
    const off = offering({
      implementationStatus: "contract_verified",
      pricing: [pricing()],
      coverage: [coverage()],
      health: [health()],
    });
    const constraints = { country: "GH", maxEstimatedCost: 0.1, region: "EU" };
    const a = evaluate(off, constraints);
    const b = evaluate(off, constraints);
    const c = evaluate(off, constraints);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(b)).toBe(JSON.stringify(c));
  });
});

describe("WORK-009 policy context construction", () => {
  it("merges candidate facts and request facts deterministically", () => {
    const off = offering({
      implementationStatus: "certified",
      certificationEnvironment: "live",
      pricing: [pricing()],
      health: [health({ metrics: { availability: 0.99 } })],
    });
    const ctx = buildPolicyContext(off, {
      country: "GH",
      region: "EU",
      currency: "GHS",
      privacyClass: "pii",
      piiAllowed: true,
      executionMode: "live",
      idempotentExecution: true,
      estimatedCost: 0.05,
    } as never);
    expect(ctx.capability).toBe("demo.echo");
    expect(ctx.capability_version).toBe("1");
    expect(ctx.provider).toBe("demo.echo");
    expect(ctx.provider_status).toBe("active");
    expect(ctx.integration_path).toBe("platform_operated");
    expect(ctx.certification).toBe("certified");
    expect(ctx.certification_environment).toBe("live");
    expect(ctx.pricing_model).toBe("per_request");
    expect(ctx.pricing_amount).toBe(0.05);
    expect(ctx.availability).toBe(0.99);
    expect(ctx.country).toBe("GH");
    expect(ctx.region).toBe("EU");
    expect(ctx.currency).toBe("GHS");
    expect(ctx.privacy_class).toBe("pii");
    expect(ctx.pii_allowed).toBe(true);
    expect(ctx.execution_mode).toBe("live");
    expect(ctx.idempotent_execution).toBe(true);
    expect(ctx.estimated_cost).toBe(0.05);
  });

  it("omits absent facts (no undefined leakage); latest pricing fact of any model feeds the context", () => {
    const off = offering({
      pricing: [
        pricing({ id: "p1", model: "per_minute", amount: "5", effectiveAt: new Date("2026-01-01T00:00:00Z") }),
        pricing({ id: "p2", model: "per_token", amount: "0.001", effectiveAt: new Date("2026-06-01T00:00:00Z") }),
      ],
    });
    const ctx = buildPolicyContext(off, {});
    expect(ctx.pricing_model).toBe("per_token");
    expect(ctx.pricing_amount).toBe(0.001);
    expect(ctx.availability).toBeUndefined();
    expect(ctx.country).toBeUndefined();
    expect(latestPricingFact(off)?.id).toBe("p2");
  });
});
