// /policies/internal/evaluator.ts
// The PURE policy evaluator (WORK-008 §10-§12; architecture §10).
//
// evaluateRules(rules, context) is deterministic and side-effect free:
// given the same rules (an immutable policy version) and the same
// evaluation context, it produces the identical result — byte for byte.
// It performs NO database access, NO provider calls, NO network, NO
// clock reads, NO randomness, NO LLM calls, NO credential access, and
// mutates nothing. The application service loads the policy version and
// validates the context BEFORE calling this function.
//
// Result shape (explainability — architecture §10 "eligibility results
// must be explainable"; WORK-008 §22):
//
//   PolicyEvaluationResult
//     policyId, policyVersion          (embedded for later trace)
//     passed                            (ALL hard constraints passed)
//     hardConstraints: { passed, violations[] }
//     preferences:   { satisfied[], violated[] }
//     ruleResults[]  { ruleId, subject, operator, mode, result,
//                      expected, actual, reason }
//
// Deterministic evaluation semantics (documented choices):
//   - An ABSENT context value fails every value operator (eq/ne/in/
//     not_in/gt/gte/lt/lte) with reason "missing_value"; only
//     not_exists passes for an absent value (and exists fails).
//   - A context value of the WRONG TYPE for the subject fails with
//     reason "type_mismatch" — evaluation never throws on caller data.
//   - null is treated as absent.
//   - Preference failures NEVER become hard failures: `passed` reflects
//     hard constraints only (WORK-008 §12 — the future Eligibility
//     engine consumes hard_constraints_passed without reverse
//     engineering preference results).

import type { PolicyRule, RuleMode, RuleOperator } from "./rules.ts";

export interface RuleResult {
  ruleId: string;
  subject: string;
  operator: RuleOperator;
  mode: RuleMode;
  result: "pass" | "fail";
  expected: string | number | boolean | string[] | null;
  actual: string | number | boolean | null;
  reason: string;
}

export interface PolicyEvaluationResult {
  policyId: string;
  policyVersion: string;
  /** True iff every HARD rule passed (preferences never affect this). */
  passed: boolean;
  hardConstraints: {
    passed: boolean;
    violations: RuleResult[];
  };
  preferences: {
    satisfied: RuleResult[];
    violated: RuleResult[];
  };
  ruleResults: RuleResult[];
}

/**
 * Evaluate an immutable policy version's rules against a normalized
 * context object. PURE: same inputs → identical output.
 */
export function evaluateRules(
  policyId: string,
  policyVersion: string,
  rules: readonly PolicyRule[],
  context: Record<string, unknown>,
): PolicyEvaluationResult {
  const ruleResults: RuleResult[] = rules.map((rule) => evaluateOne(rule, context));
  const hardResults = ruleResults.filter((r) => r.mode === "hard");
  const prefResults = ruleResults.filter((r) => r.mode === "preference");
  const violations = hardResults.filter((r) => r.result === "fail");
  const passed = violations.length === 0;
  return {
    policyId,
    policyVersion,
    passed,
    hardConstraints: {
      passed,
      violations,
    },
    preferences: {
      satisfied: prefResults.filter((r) => r.result === "pass"),
      violated: prefResults.filter((r) => r.result === "fail"),
    },
    ruleResults,
  };
}

function evaluateOne(rule: PolicyRule, context: Record<string, unknown>): RuleResult {
  const raw = context[rule.subject];
  const present = raw !== undefined && raw !== null;
  const base = {
    ruleId: rule.id,
    subject: rule.subject,
    operator: rule.operator,
    mode: rule.mode,
    expected: (rule.value ?? null) as RuleResult["expected"],
  };

  switch (rule.operator) {
    case "exists":
      return {
        ...base,
        result: present ? "pass" : "fail",
        actual: present ? describe(raw) : null,
        reason: present ? "subject is present" : "subject is absent",
      };
    case "not_exists":
      return {
        ...base,
        result: present ? "fail" : "pass",
        actual: present ? describe(raw) : null,
        reason: present ? "subject is present" : "subject is absent",
      };
    default:
      break;
  }

  if (!present) {
    return {
      ...base,
      result: "fail",
      actual: null,
      reason: "missing_value",
    };
  }

  switch (rule.operator) {
    case "eq":
      if (!sameType(rule.value, raw)) {
        return { ...base, result: "fail", actual: describe(raw), reason: "type_mismatch" };
      }
      return {
        ...base,
        result: raw === rule.value ? "pass" : "fail",
        actual: describe(raw),
        reason: raw === rule.value ? "values are equal" : `actual ${JSON.stringify(raw)} does not equal expected ${JSON.stringify(rule.value)}`,
      };
    case "ne":
      if (!sameType(rule.value, raw)) {
        return { ...base, result: "fail", actual: describe(raw), reason: "type_mismatch" };
      }
      return {
        ...base,
        result: raw !== rule.value ? "pass" : "fail",
        actual: describe(raw),
        reason: raw !== rule.value ? "values differ" : `actual equals the excluded value ${JSON.stringify(rule.value)}`,
      };
    case "in":
    case "not_in": {
      const list = rule.value as string[];
      if (typeof raw !== "string") {
        return { ...base, result: "fail", actual: describe(raw), reason: "type_mismatch" };
      }
      const member = list.includes(raw);
      const ok = rule.operator === "in" ? member : !member;
      return {
        ...base,
        result: ok ? "pass" : "fail",
        actual: raw,
        reason: ok
          ? `value ${JSON.stringify(raw)} ${member ? "is" : "is not"} in the allowed set`
          : `value ${JSON.stringify(raw)} ${member ? "is" : "is not"} in the ${rule.operator === "in" ? "allowed" : "excluded"} set`,
      };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const bound = rule.value as number;
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ...base, result: "fail", actual: describe(raw), reason: "type_mismatch" };
      }
      const ok = boundOk(rule.operator, bound, raw);
      return {
        ...base,
        result: ok ? "pass" : "fail",
        actual: raw,
        reason: ok
          ? `actual ${raw} satisfies ${rule.operator} ${bound}`
          : `actual ${raw} does not satisfy ${rule.operator} ${bound}`,
      };
    }
    default:
      // Unreachable: the rule vocabulary is a closed enum and persisted
      // rules were validated at creation. Deterministic failure rather
      // than a throw keeps the evaluator total.
      return { ...base, result: "fail", actual: describe(raw), reason: "unknown_operator" };
  }
}

function boundOk(op: RuleOperator, bound: number, v: number): boolean {
  switch (op) {
    case "gt": return v > bound;
    case "gte": return v >= bound;
    case "lt": return v < bound;
    case "lte": return v <= bound;
    default: return false;
  }
}

/** Structural type check (typeof null is "object" — handled earlier). */
function sameType(expected: unknown, actual: unknown): boolean {
  return typeof expected === typeof actual;
}

function describe(v: unknown): string | number | boolean | null {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return null;
}
