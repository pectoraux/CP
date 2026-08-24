// /eligibility — public interface.
//
// Responsibility (architecture §10, §36; WORK-009 ELIG-001..004):
// deterministic candidate eligibility evaluation.
//
// WORK-009 delivers the bridge between policy + marketplace facts and
// future strategy/routing:
//   - candidate = a catalog OFFERING (the WORK-007 projection of a
//     provider-capability declaration — no second provider/catalog
//     registry)
//   - enumeration via the PUBLIC catalog interface; policy evaluation
//     via the PUBLIC pure policy evaluator; capability existence via
//     the PUBLIC capabilities interface
//   - the PURE evaluator: same snapshot + request + policy rules →
//     identical result; no DB, no network, no provider adapters, no
//     clock, no LLM, no mutation
//   - a three-way failure taxonomy: INELIGIBLE (definitely failed a
//     hard check), INDETERMINATE (required evidence unavailable —
//     never silently success), ELIGIBLE
//   - full explainability: every check carries check_id, category,
//     expected, actual, reason, evidence; the snapshot section records
//     the policy version, offering, and the exact catalog facts used
//   - ONLY hard policy violations disqualify — preference results are
//     recorded for downstream strategy and NEVER affect eligibility
//
// WORK-009 does NOT choose winners, rank, score, route, execute,
// optimize, or acquire credentials (§21-§23, §33): those belong to
// later layers that CONSUME these results.
//
// Dependency direction (§25): /eligibility → @cp/policies, @cp/catalog,
// @cp/capabilities public interfaces + @cp/auth + @cp/platform. It must
// never import /routing, /optimization, /experiments, /executions, or
// any downstream module — enforced by the static architecture check.
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import
// ONLY from this file.

// ---- EligibilityService (stateless evaluation) --------------------------------
export { EligibilityService } from "./internal/service.ts";
export type {
  EligibilityServiceOptions,
  EligibilityEvaluateInput,
  EligibilityEvaluation,
  CapabilitySummary,
  EligibilitySummary,
} from "./internal/service.ts";

// ---- Pure evaluator (WORK-009 §6, §16, §19) --------------------------------------
export type {
  CandidateEligibility,
  CandidateDescriptor,
  EvaluationSnapshot,
  PolicyRef,
} from "./internal/evaluator.ts";
export {
  evaluateCandidate,
  candidateDeclarationMissing,
  candidateVersionUnsupported,
  latestPricingFact,
  latestPerRequestPricingFact,
  latestHealthObservation,
  buildPolicyContext,
} from "./internal/evaluator.ts";

// ---- Request/result vocabulary (WORK-009 §15, §18) --------------------------------
export type {
  EligibilityStatus,
  CheckResult,
  CheckCategory,
  EligibilityCheck,
  EligibilityRequestConstraints,
  RequiredCertification,
  RequiredIntegrationPath,
} from "./internal/types.ts";
export {
  CERTIFICATION_LEVELS,
  isCheckResult,
  validateConstraints,
  validateProviders,
} from "./internal/types.ts";

// NOTE (WORK-009 §26): eligibility is STATELESS — no schema, no
// migration, no persisted candidate state, no cache. There is
// deliberately no migrateEligibilitySchema.

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "eligibility" as const;
