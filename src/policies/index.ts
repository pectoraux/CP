// /policies — public interface.
//
// Responsibility (architecture §10, §34, §36; WORK-008 POLICY-001..004):
// hard constraints and preferences — the deterministic policy layer that
// answers "What requirements must an execution satisfy?"
//
// WORK-008 delivers:
//   - PROJECT-SCOPED policy identity (architecture §5/§34 place Policies
//     under Organization → Project; all customer-visible resources are
//     tenant-scoped)
//   - immutable, versioned rule sets (DRAFT → ACTIVE → DEPRECATED →
//     RETIRED; at most one ACTIVE version per policy — the explicit,
//     deterministic effective version)
//   - the constrained declarative rule model: a closed, typed subject
//     vocabulary + a closed, type-gated operator set (no eval, no
//     scripting, no SQL/JS/expressions — anything outside the vocabulary
//     is rejected before persistence) with deterministic conflict
//     detection for contradictory hard rules
//   - the PURE evaluator: same policy version + same context → identical
//     result; no DB/provider/network/clock/LLM access; explainable
//     per-rule results that keep hard-constraint failures structurally
//     distinct from preference failures
//
// Layer separation (WORK-008 §3): Policy expresses the rules. Eligibility
// (WORK-009) determines whether a candidate satisfies them; routing and
// optimization come later. This module exposes evaluation PRIMITIVES
// (evaluateRules, getEffectiveVersion) for those layers — it never
// selects, ranks, or rejects providers itself.
//
// Dependency direction (WORK-008 §15, §25): /policies imports only
// @cp/platform + @cp/auth. It does NOT import /catalog, /capabilities,
// or /providers (the evaluation context is caller-supplied normalized
// facts — rules never touch database tables), and it must never import
// /eligibility, /routing, /optimization, /experiments, /executions, or
// any downstream module — enforced by the static architecture check.
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import
// ONLY from this file.

// ---- PoliciesService (DB-backed) -----------------------------------------
export { PoliciesService } from "./internal/service.ts";
export type {
  PoliciesServiceOptions,
  Policy,
  PolicyVersion,
  CreatePolicyInput,
  ListPoliciesOptions,
  PolicyPage,
  CreatePolicyVersionInput,
  UpdateDraftVersionInput,
  TransitionPolicyVersionInput,
  EvaluatePolicyInput,
} from "./internal/service.ts";

// ---- Version lifecycle (WORK-008 §6) ---------------------------------------
export type { PolicyVersionStatus } from "./internal/service.ts";
export {
  POLICY_VERSION_STATUSES,
  POLICY_VERSION_LIFECYCLE,
  isPolicyVersionStatus,
} from "./internal/service.ts";

// ---- Rule model (WORK-008 §7-§9, §21) ----------------------------------------
export type {
  PolicyRule,
  RuleMode,
  RuleOperator,
  SubjectType,
  RuleConflict,
  RulesDocument,
  RuleInput,
} from "./internal/rules.ts";
export {
  RULE_MODES,
  isRuleMode,
  POLICY_SUBJECTS,
  SUBJECT_NAMES,
  isSubject,
  subjectType,
  RULE_OPERATORS,
  isRuleOperator,
  operatorAllowedForType,
  validateRules,
  validateEvaluationContext,
  detectConflicts,
  MAX_RULES_PER_VERSION,
  MAX_VALUE_STRING_LEN,
  MAX_LIST_SIZE,
  MAX_CONTEXT_KEYS,
  MAX_POLICY_NAME_LEN,
  MAX_POLICY_DESCRIPTION_LEN,
} from "./internal/rules.ts";

// ---- Pure evaluator (WORK-008 §10-§12) -----------------------------------------
export type { RuleResult, PolicyEvaluationResult } from "./internal/evaluator.ts";
export { evaluateRules } from "./internal/evaluator.ts";

// ---- Schema migration ------------------------------------------------------------
export { POLICY_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migratePoliciesSchema } from "./internal/schema-runner.ts";

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "policies" as const;
