// /eligibility/internal/evaluator.ts
// The PURE eligibility evaluator (WORK-009 §6, §8, §16, §19; architecture
// §10 "eligibility results must be explainable").
//
// evaluateCandidate(candidate, request, policy) is deterministic and
// side-effect free: given the same offering snapshot, the same request,
// and the same (immutable) policy rules, it produces the identical
// result. It performs NO database access, NO provider/network calls, NO
// adapter invocation, NO clock reads (health/pricing facts carry their
// own recorded timestamps from the catalog), NO randomness, NO LLM, and
// mutates nothing. The application service loads all snapshots BEFORE
// calling this function.
//
// Semantics (WORK-009 §5, §18):
//   - A candidate is ELIGIBLE only when every check passes.
//   - A definite hard-check failure makes it INELIGIBLE.
//   - A check whose required evidence is UNAVAILABLE is INDETERMINATE —
//     missing data is never treated as success, and an indeterminate
//     result (with no failures) yields the overall INDETERMINATE status:
//     "candidate could not be evaluated", distinct from "candidate
//     definitely failed".
//   - ONLY hard policy violations disqualify: preference violations are
//     recorded for downstream strategy/routing and NEVER affect
//     eligibility (§8).
//
// The policy evaluation itself is delegated to the PUBLIC pure policy
// evaluator (@cp/policies evaluateRules) — eligibility never
// reimplements policy semantics (§7).

import type { CatalogOffering, PricingFact, HealthObservation } from "@cp/catalog";
import type { PolicyRule, PolicyEvaluationResult, RuleResult } from "@cp/policies";
import { evaluateRules } from "@cp/policies";
import type {
  EligibilityCheck,
  EligibilityRequestConstraints,
  EligibilityStatus,
  RequiredCertification,
  RequiredIntegrationPath,
} from "./types.ts";

// ---- Result types ------------------------------------------------------------

export interface CandidateDescriptor {
  offeringId: string;
  provider: {
    providerId: string;
    name: string;
    status: string;
    integrationPath: string;
  };
  capability: {
    capabilityId: string;
    capabilityVersion: string;
    capabilityStatus: string;
    versionStatus: string | null;
  };
  implementation: {
    adapterVersion: string;
    status: string;
    certificationEnvironment: string;
  };
}

/** The consistency record (WORK-009 §17): WHAT was evaluated. */
export interface EvaluationSnapshot {
  policyId: string;
  policyVersion: string;
  offeringId: string;
  providerStatus: string;
  implementationStatus: string;
  certificationEnvironment: string;
  /** The pricing fact selected for the policy context (latest effective). */
  pricingFact: { id: string; model: string; currency: string | null; effectiveAt: string } | null;
  /** The per-request pricing fact selected for the hard cost check. */
  perRequestPricingFact: { id: string; model: string; currency: string | null; amount: string; effectiveAt: string } | null;
  /** The health observation selected (latest observed). */
  healthObservation: { id: string; status: string; observedAt: string } | null;
}

export interface CandidateEligibility {
  candidate: CandidateDescriptor;
  status: EligibilityStatus;
  checks: EligibilityCheck[];
  failures: EligibilityCheck[];
  indeterminate: EligibilityCheck[];
  satisfied: EligibilityCheck[];
  policy: {
    policyId: string;
    policyVersion: string;
    hardPassed: boolean;
    hardViolations: RuleResult[];
    preferenceSatisfied: RuleResult[];
    preferenceViolated: RuleResult[];
  } | null;
  snapshot: EvaluationSnapshot;
}

export interface PolicyRef {
  policyId: string;
  policyVersion: string;
  rules: PolicyRule[];
}

// ---- The pure evaluator ---------------------------------------------------------

export function evaluateCandidate(input: {
  offering: CatalogOffering;
  constraints: EligibilityRequestConstraints;
  policy: PolicyRef;
}): CandidateEligibility {
  const { offering, constraints, policy } = input;
  const checks: EligibilityCheck[] = [];

  // ---- capability checks ---------------------------------------------------
  checks.push(checkCapabilityNotRetired(offering));
  // (capability.exists / version existence are guaranteed by enumeration —
  // the offering IS a live declaration of exactly this capability+version;
  // the API-level capability summary reports global existence separately.)

  // ---- provider checks -------------------------------------------------------
  checks.push(checkProviderStatus(offering));
  checks.push(checkIntegrationPath(offering, constraints.requiredIntegrationPath));

  // ---- certification checks (§11: fixture verification ≠ certification) ----
  checks.push(checkCertificationLevel(offering, constraints.requiredCertification));
  checks.push(checkCertificationEnvironment(offering, constraints.requireLiveCertification));

  // ---- coverage checks (§12: provenance-aware) ---------------------------------
  checks.push(checkCoverage(offering, "country", constraints.country, constraints.requireVerifiedCoverage));
  checks.push(checkCoverage(offering, "region", constraints.region, constraints.requireVerifiedCoverage));
  checks.push(checkCoverage(offering, "currency", constraints.currency, constraints.requireVerifiedCoverage));

  // ---- pricing check (§13: hard cost constraint only — never "best price") ---
  checks.push(checkHardCost(offering, constraints));

  // ---- health check (§14: catalog observations as facts) ------------------------
  checks.push(checkHealth(offering, constraints.requireHealthy));

  // ---- policy check (§7-§8: public pure evaluator; hard constraints only) ------
  const policyContext = buildPolicyContext(offering, constraints);
  const policyResult = evaluateRules(policy.policyId, policy.policyVersion, policy.rules, policyContext);
  checks.push(policyCheck(policyResult));

  // ---- aggregate (three-way taxonomy) --------------------------------------------
  const failures = checks.filter((c) => c.result === "fail");
  const indeterminate = checks.filter((c) => c.result === "indeterminate");
  const satisfied = checks.filter((c) => c.result === "pass");
  const status: EligibilityStatus =
    failures.length > 0 ? "ineligible" : indeterminate.length > 0 ? "indeterminate" : "eligible";

  const latest = latestPricingFact(offering);
  const perRequest = latestPerRequestPricingFact(offering);
  const health = latestHealthObservation(offering);

  return {
    candidate: {
      offeringId: offering.offeringId,
      provider: {
        providerId: offering.provider.providerId,
        name: offering.provider.name,
        status: offering.provider.status,
        integrationPath: offering.provider.integrationPath,
      },
      capability: {
        capabilityId: offering.capability.capabilityId,
        capabilityVersion: offering.capability.capabilityVersion,
        capabilityStatus: offering.capability.capabilityStatus,
        versionStatus: offering.capability.versionStatus,
      },
      implementation: {
        adapterVersion: offering.implementation.adapterVersion,
        status: offering.implementation.status,
        certificationEnvironment: offering.implementation.certificationEnvironment,
      },
    },
    status,
    checks,
    failures,
    indeterminate,
    satisfied,
    policy: {
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      hardPassed: policyResult.hardConstraints.passed,
      hardViolations: policyResult.hardConstraints.violations,
      preferenceSatisfied: policyResult.preferences.satisfied,
      preferenceViolated: policyResult.preferences.violated,
    },
    snapshot: {
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      offeringId: offering.offeringId,
      providerStatus: offering.provider.status,
      implementationStatus: offering.implementation.status,
      certificationEnvironment: offering.implementation.certificationEnvironment,
      pricingFact: latest
        ? {
            id: latest.id,
            model: latest.model,
            currency: latest.currency,
            effectiveAt: latest.effectiveAt.toISOString(),
          }
        : null,
      perRequestPricingFact: perRequest
        ? {
            id: perRequest.id,
            model: perRequest.model,
            currency: perRequest.currency,
            amount: perRequest.amount,
            effectiveAt: perRequest.effectiveAt.toISOString(),
          }
        : null,
      healthObservation: health
        ? {
            id: health.id,
            status: health.status,
            observedAt: health.observedAt.toISOString(),
          }
        : null,
    },
  };
}

// ---- Synthetic results for named-but-missing candidates (§4, §28) --------------

/** A named provider with NO declaration for the capability at all. */
export function candidateDeclarationMissing(
  providerId: string,
  policy: PolicyRef,
): CandidateEligibility {
  const check: EligibilityCheck = {
    checkId: "provider.declaration_exists",
    category: "provider",
    result: "fail",
    expected: "a provider-capability declaration for the requested capability",
    actual: "no declaration",
    reason: `provider "${providerId}" does not declare the requested capability`,
    evidence: null,
  };
  return syntheticResult(providerId, policy, check);
}

/** A named provider that declares the capability but NOT the requested version (§9: exact version semantics). */
export function candidateVersionUnsupported(
  providerId: string,
  policy: PolicyRef,
  declaredVersions: string[],
): CandidateEligibility {
  const check: EligibilityCheck = {
    checkId: "capability.version_supported",
    category: "capability",
    result: "fail",
    expected: "declaration for the exact requested capability version",
    actual: declaredVersions.length > 0 ? `declared version(s): ${declaredVersions.join(", ")}` : "none",
    reason: `provider "${providerId}" does not declare the requested capability version`,
    evidence: null,
  };
  return syntheticResult(providerId, policy, check);
}

function syntheticResult(providerId: string, policy: PolicyRef, check: EligibilityCheck): CandidateEligibility {
  return {
    candidate: {
      offeringId: `synthetic:${providerId}`,
      provider: {
        providerId,
        name: providerId,
        status: "unknown",
        integrationPath: "unknown",
      },
      capability: {
        capabilityId: "unknown",
        capabilityVersion: "unknown",
        capabilityStatus: "unknown",
        versionStatus: null,
      },
      implementation: {
        adapterVersion: "unknown",
        status: "unknown",
        certificationEnvironment: "unknown",
      },
    },
    status: "ineligible",
    checks: [check],
    failures: [check],
    indeterminate: [],
    satisfied: [],
    policy: null,
    snapshot: {
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      offeringId: `synthetic:${providerId}`,
      providerStatus: "unknown",
      implementationStatus: "unknown",
      certificationEnvironment: "unknown",
      pricingFact: null,
      perRequestPricingFact: null,
      healthObservation: null,
    },
  };
}

// ---- Individual checks ------------------------------------------------------------

function checkCapabilityNotRetired(offering: CatalogOffering): EligibilityCheck {
  const versionStatus = offering.capability.versionStatus;
  const capStatus = offering.capability.capabilityStatus;
  if (versionStatus === "retired") {
    return {
      checkId: "capability.version_not_retired",
      category: "capability",
      result: "fail",
      expected: "capability version not retired",
      actual: "retired",
      reason: "the requested capability version is retired",
      evidence: null,
    };
  }
  if (capStatus === "retired") {
    return {
      checkId: "capability.version_not_retired",
      category: "capability",
      result: "fail",
      expected: "capability not retired",
      actual: "retired",
      reason: "the capability is retired",
      evidence: null,
    };
  }
  return {
    checkId: "capability.version_not_retired",
    category: "capability",
    result: "pass",
    expected: "capability and version not retired",
    actual: `capability=${capStatus}, version=${versionStatus ?? "unknown"}`,
    reason: "capability and version are not retired",
    evidence: null,
  };
}

/**
 * Provider lifecycle (§10; architect review of PR #8): eligibility must
 * not turn an ONBOARDING-state provider into a production candidate —
 * ONLY the authoritative `active` lifecycle state is eligible (subject
 * to the other checks). Pre-active pipeline states (discovered,
 * integrating, contract_tested, observed), suspended, deprecated, and
 * revoked all FAIL: the marketplace's production surface is the ACTIVE
 * provider set. Revoked can NEVER be eligible. The check never mutates
 * provider state.
 */
function checkProviderStatus(offering: CatalogOffering): EligibilityCheck {
  const status = offering.provider.status;
  if (status !== "active") {
    return {
      checkId: "provider.status",
      category: "provider",
      result: "fail",
      expected: "provider in the active lifecycle state",
      actual: status,
      reason:
        status === "discovered" || status === "integrating" || status === "contract_tested" || status === "observed"
          ? `provider is still onboarding (${status}) — only the active lifecycle state is eligible`
          : `provider is ${status}`,
      evidence: null,
    };
  }
  return {
    checkId: "provider.status",
    category: "provider",
    result: "pass",
    expected: "provider in the active lifecycle state",
    actual: status,
    reason: "provider is active",
    evidence: null,
  };
}

function checkIntegrationPath(
  offering: CatalogOffering,
  required: RequiredIntegrationPath | undefined,
): EligibilityCheck {
  const actual = offering.provider.integrationPath;
  if (required === undefined) {
    return {
      checkId: "provider.integration_path",
      category: "provider",
      result: "pass",
      expected: "any",
      actual,
      reason: "no integration path required",
      evidence: null,
    };
  }
  const ok = actual === required;
  return {
    checkId: "provider.integration_path",
    category: "provider",
    result: ok ? "pass" : "fail",
    expected: required,
    actual,
    reason: ok ? "integration path matches the requirement" : "integration path does not match the requirement",
    evidence: null,
  };
}

const CERT_LEVEL_ORDER: Record<string, number> = {
  registered: 0,
  contract_verified: 1,
  certified: 2,
};

function checkCertificationLevel(
  offering: CatalogOffering,
  required: RequiredCertification | undefined,
): EligibilityCheck {
  const actual = offering.implementation.status;
  if (required === undefined) {
    return {
      checkId: "certification.level",
      category: "certification",
      result: "pass",
      expected: "any",
      actual,
      reason: "no certification level required",
      evidence: null,
    };
  }
  const actualLevel = CERT_LEVEL_ORDER[actual] ?? -1;
  const requiredLevel = CERT_LEVEL_ORDER[required] ?? 0;
  // §11: contract_verified ≠ certified — exact ordered levels.
  const ok = actualLevel >= requiredLevel;
  return {
    checkId: "certification.level",
    category: "certification",
    result: ok ? "pass" : "fail",
    expected: required,
    actual,
    reason: ok
      ? `implementation certification ${actual} satisfies ${required}`
      : `candidate is not ${required} (implementation is ${actual})`,
    evidence: `implementation_status=${actual}; environment=${offering.implementation.certificationEnvironment}`,
  };
}

function checkCertificationEnvironment(
  offering: CatalogOffering,
  requireLive: boolean | undefined,
): EligibilityCheck {
  const actual = offering.implementation.certificationEnvironment;
  if (!requireLive) {
    return {
      checkId: "certification.environment",
      category: "certification",
      result: "pass",
      expected: "any",
      actual,
      reason: "no live certification required",
      evidence: null,
    };
  }
  const ok = actual === "live";
  return {
    checkId: "certification.environment",
    category: "certification",
    result: ok ? "pass" : "fail",
    expected: "live",
    actual,
    reason: ok
      ? "certification evidence is live"
      : "certification evidence is not live (fixture or none) — live certification required",
    evidence: `certification_environment=${actual}`,
  };
}

/**
 * Coverage (§12): the candidate must have a catalog coverage fact whose
 * dimension/value matches the requirement. Provenance-aware: when
 * verified coverage is required, a merely DECLARED (or observed) fact
 * does NOT satisfy it — the matching fact must be status verified or
 * certified.
 */
function checkCoverage(
  offering: CatalogOffering,
  dimension: "country" | "region" | "currency",
  requiredValue: string | undefined,
  requireVerified: boolean | undefined,
): EligibilityCheck {
  const checkId = `coverage.${dimension}`;
  if (requiredValue === undefined) {
    return {
      checkId,
      category: "coverage",
      result: "pass",
      expected: "any",
      actual: "not required",
      reason: `no ${dimension} coverage required`,
      evidence: null,
    };
  }
  const matching = offering.coverage.filter(
    (f) => f.dimension === dimension && f.value === requiredValue,
  );
  if (matching.length === 0) {
    return {
      checkId,
      category: "coverage",
      result: "fail",
      expected: requiredValue,
      actual: "not covered",
      reason: `candidate does not cover ${dimension} ${requiredValue}`,
      evidence: null,
    };
  }
  if (requireVerified) {
    const provenanceOk = matching.some((f) => f.status === "verified" || f.status === "certified");
    if (!provenanceOk) {
      const best = matching[0]!;
      return {
        checkId,
        category: "coverage",
        result: "fail",
        expected: `${requiredValue} (verified coverage)`,
        actual: `${requiredValue} (${best.status})`,
        reason: `coverage fact for ${dimension} ${requiredValue} is only ${matching.map((f) => f.status).join(", ")} — verified coverage required`,
        evidence: matching.map((f) => f.id).join(","),
      };
    }
    const verified = matching.find((f) => f.status === "verified" || f.status === "certified")!;
    return {
      checkId,
      category: "coverage",
      result: "pass",
      expected: `${requiredValue} (verified coverage)`,
      actual: `${requiredValue} (${verified.status})`,
      reason: `verified coverage fact satisfies ${dimension} ${requiredValue}`,
      evidence: verified.id,
    };
  }
  const fact = matching[0]!;
  return {
    checkId,
    category: "coverage",
    result: "pass",
    expected: requiredValue,
    actual: requiredValue,
    reason: `coverage fact satisfies ${dimension} ${requiredValue}`,
    evidence: fact.id,
  };
}

/**
 * Hard cost constraint (§13): compares the request's max estimated cost
 * against the candidate's per-request pricing fact (latest effective_at,
 * tie-break max id — deterministic). Answers "does the candidate satisfy
 * the hard cost constraint?" — NEVER "which candidate is cheapest".
 *
 * Missing evidence semantics (§18, §28): no per-request pricing fact or
 * an uncomparable currency yields INDETERMINATE — "could not be
 * evaluated", never silent success and never a false rejection.
 */
function checkHardCost(
  offering: CatalogOffering,
  constraints: EligibilityRequestConstraints,
): EligibilityCheck {
  const { maxEstimatedCost, maxEstimatedCostCurrency } = constraints;
  if (maxEstimatedCost === undefined) {
    return {
      checkId: "pricing.hard_cost",
      category: "pricing",
      result: "pass",
      expected: "any",
      actual: "not required",
      reason: "no hard cost constraint requested",
      evidence: null,
    };
  }
  const fact = latestPerRequestPricingFact(offering);
  if (!fact) {
    return {
      checkId: "pricing.hard_cost",
      category: "pricing",
      result: "indeterminate",
      expected: `per-request cost <= ${maxEstimatedCost}`,
      actual: "no per_request pricing fact",
      reason: "required pricing evidence is unavailable (no per_request pricing fact)",
      evidence: null,
    };
  }
  if (
    maxEstimatedCostCurrency !== undefined &&
    (fact.currency === null || fact.currency !== maxEstimatedCostCurrency)
  ) {
    return {
      checkId: "pricing.hard_cost",
      category: "pricing",
      result: "indeterminate",
      expected: `per-request cost <= ${maxEstimatedCost} ${maxEstimatedCostCurrency}`,
      actual: `${fact.amount} ${fact.currency ?? "no currency"}`,
      reason: "pricing currency does not match the constraint currency — costs are not comparable without conversion",
      evidence: fact.id,
    };
  }
  const amount = Number(fact.amount);
  if (!Number.isFinite(amount)) {
    return {
      checkId: "pricing.hard_cost",
      category: "pricing",
      result: "indeterminate",
      expected: `per-request cost <= ${maxEstimatedCost}`,
      actual: fact.amount,
      reason: "pricing amount is not a finite number",
      evidence: fact.id,
    };
  }
  const ok = amount <= maxEstimatedCost;
  return {
    checkId: "pricing.hard_cost",
    category: "pricing",
    result: ok ? "pass" : "fail",
    expected: `per-request cost <= ${maxEstimatedCost}${maxEstimatedCostCurrency ? ` ${maxEstimatedCostCurrency}` : ""}`,
    actual: amount,
    reason: ok ? "per-request cost satisfies the hard cost constraint" : "per-request cost exceeds the hard cost constraint",
    evidence: fact.id,
  };
}

/**
 * Health (§14): consumes catalog health observations as FACTS. The
 * latest observation (max observed_at, tie-break max id — deterministic,
 * using the RECORDED timestamp, never wall clock) decides:
 *   unavailable → fail (candidate rejected when health is required)
 *   unknown     → indeterminate (explicit unknown semantics)
 *   healthy/degraded → pass
 *   no observation  → indeterminate (evidence unavailable)
 * The health observation system remains authoritative elsewhere; this
 * check never mutates health state.
 */
function checkHealth(
  offering: CatalogOffering,
  requireHealthy: boolean | undefined,
): EligibilityCheck {
  if (!requireHealthy) {
    return {
      checkId: "provider.health",
      category: "health",
      result: "pass",
      expected: "any",
      actual: "not required",
      reason: "no health requirement requested",
      evidence: null,
    };
  }
  const latest = latestHealthObservation(offering);
  if (!latest) {
    return {
      checkId: "provider.health",
      category: "health",
      result: "indeterminate",
      expected: "health != unavailable",
      actual: "no health observation",
      reason: "required health evidence is unavailable (no observation recorded)",
      evidence: null,
    };
  }
  if (latest.status === "unavailable") {
    return {
      checkId: "provider.health",
      category: "health",
      result: "fail",
      expected: "health != unavailable",
      actual: "unavailable",
      reason: "latest health observation reports the provider unavailable",
      evidence: latest.id,
    };
  }
  if (latest.status === "unknown") {
    return {
      checkId: "provider.health",
      category: "health",
      result: "indeterminate",
      expected: "health != unavailable",
      actual: "unknown",
      reason: "latest health observation explicitly reports unknown health",
      evidence: latest.id,
    };
  }
  return {
    checkId: "provider.health",
    category: "health",
    result: "pass",
    expected: "health != unavailable",
    actual: latest.status,
    reason: `latest health observation reports ${latest.status}`,
    evidence: latest.id,
  };
}

/** The policy check: ONLY hard violations disqualify (§8). */
function policyCheck(result: PolicyEvaluationResult): EligibilityCheck {
  const violations = result.hardConstraints.violations;
  if (result.hardConstraints.passed) {
    return {
      checkId: "policy.hard_constraints",
      category: "policy",
      result: "pass",
      expected: "all hard policy constraints satisfied",
      actual: `${result.hardConstraints.violations.length} violations`,
      reason: "all hard policy constraints satisfied",
      evidence: `policy=${result.policyId}@${result.policyVersion}`,
    };
  }
  return {
    checkId: "policy.hard_constraints",
    category: "policy",
    result: "fail",
    expected: "all hard policy constraints satisfied",
    actual: `${violations.length} hard violation(s)`,
    reason: `hard policy constraints violated: ${violations
      .map((v) => `${v.ruleId}(${v.subject} ${v.operator} ${JSON.stringify(v.expected)}, actual ${JSON.stringify(v.actual)})`)
      .join("; ")}`,
    evidence: violations.map((v) => v.ruleId).join(","),
  };
}

// ---- Deterministic fact selection (§16-§17) -----------------------------------

/** Latest-effective pricing fact of ANY model (policy context source). */
export function latestPricingFact(offering: CatalogOffering): PricingFact | null {
  let best: PricingFact | null = null;
  for (const f of offering.pricing) {
    if (best === null) {
      best = f;
      continue;
    }
    if (
      f.effectiveAt.getTime() > best.effectiveAt.getTime() ||
      (f.effectiveAt.getTime() === best.effectiveAt.getTime() && f.id > best.id)
    ) {
      best = f;
    }
  }
  return best;
}

/** Latest-effective PER_REQUEST pricing fact (hard cost check source). */
export function latestPerRequestPricingFact(offering: CatalogOffering): PricingFact | null {
  let best: PricingFact | null = null;
  for (const f of offering.pricing) {
    if (f.model !== "per_request") continue;
    if (best === null) {
      best = f;
      continue;
    }
    if (
      f.effectiveAt.getTime() > best.effectiveAt.getTime() ||
      (f.effectiveAt.getTime() === best.effectiveAt.getTime() && f.id > best.id)
    ) {
      best = f;
    }
  }
  return best;
}

/** Latest health observation (max observed_at, tie-break max id). */
export function latestHealthObservation(offering: CatalogOffering): HealthObservation | null {
  let best: HealthObservation | null = null;
  for (const h of offering.health) {
    if (best === null) {
      best = h;
      continue;
    }
    if (
      h.observedAt.getTime() > best.observedAt.getTime() ||
      (h.observedAt.getTime() === best.observedAt.getTime() && h.id > best.id)
    ) {
      best = h;
    }
  }
  return best;
}

// ---- Policy context construction (§15) ------------------------------------------

/**
 * Build the normalized policy evaluation context: candidate facts
 * (from the offering) + request facts (from the constraints). Geography
 * (country/region/currency) in the policy context is REQUEST-level —
 * candidate geography is evaluated by the dedicated provenance-aware
 * coverage checks. Deterministic: field order and presence depend only
 * on the inputs.
 */
export function buildPolicyContext(
  offering: CatalogOffering,
  constraints: EligibilityRequestConstraints,
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  // Candidate facts.
  ctx.capability = offering.capability.capabilityId;
  ctx.capability_version = offering.capability.capabilityVersion;
  ctx.provider = offering.provider.providerId;
  ctx.provider_status = offering.provider.status;
  ctx.integration_path = offering.provider.integrationPath;
  ctx.certification = offering.implementation.status;
  ctx.certification_environment = offering.implementation.certificationEnvironment;
  const pricing = latestPricingFact(offering);
  if (pricing) {
    ctx.pricing_model = pricing.model;
    const amount = Number(pricing.amount);
    if (Number.isFinite(amount)) {
      ctx.pricing_amount = amount;
    }
  }
  const health = latestHealthObservation(offering);
  if (health) {
    const metrics = health.metrics as Record<string, unknown>;
    const availability = metrics?.availability;
    if (typeof availability === "number" && Number.isFinite(availability)) {
      ctx.availability = availability;
    }
  }
  // Request facts.
  if (constraints.country !== undefined) ctx.country = constraints.country;
  if (constraints.region !== undefined) ctx.region = constraints.region;
  if (constraints.currency !== undefined) ctx.currency = constraints.currency;
  if (constraints.privacyClass !== undefined) ctx.privacy_class = constraints.privacyClass;
  if (constraints.piiAllowed !== undefined) ctx.pii_allowed = constraints.piiAllowed;
  if (constraints.executionMode !== undefined) ctx.execution_mode = constraints.executionMode;
  if (constraints.idempotentExecution !== undefined) ctx.idempotent_execution = constraints.idempotentExecution;
  if (constraints.estimatedCost !== undefined) ctx.estimated_cost = constraints.estimatedCost;
  return ctx;
}
