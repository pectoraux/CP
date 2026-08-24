// tests/policies/evaluator.test.ts — WORK-008 pure-evaluator unit tests:
// determinism, hard/preference semantics, explainability (actual/
// expected/operator/reason preserved), missing-value and type-mismatch
// semantics. No infrastructure — the evaluator is pure.
import { describe, expect, it } from "bun:test";
import {
  evaluateRules,
  validateRules,
  type PolicyRule,
} from "@cp/policies";

const RULES: PolicyRule[] = [
  { id: "rule_1", subject: "region", operator: "eq", value: "EU", mode: "hard" },
  { id: "rule_2", subject: "certification", operator: "eq", value: "certified", mode: "hard" },
  { id: "rule_3", subject: "estimated_cost", operator: "lte", value: 0.2, mode: "hard" },
  { id: "rule_4", subject: "estimated_latency_ms", operator: "lt", value: 500, mode: "hard" },
  { id: "rule_5", subject: "country", operator: "in", value: ["GH", "NG"], mode: "hard" },
  { id: "rule_6", subject: "integration_path", operator: "eq", value: "platform_operated", mode: "preference" },
  { id: "rule_7", subject: "provider_status", operator: "exists", mode: "hard" },
  { id: "rule_8", subject: "pii_allowed", operator: "eq", value: false, mode: "hard" },
];

const PASSING_CONTEXT = {
  region: "EU",
  certification: "certified",
  estimated_cost: 0.15,
  estimated_latency_ms: 320,
  country: "GH",
  integration_path: "provider_operated", // preference violated
  provider_status: "active",
  pii_allowed: false,
};

describe("WORK-008 pure evaluator", () => {
  it("all hard constraints pass → passed=true; preference violations do NOT affect passed", () => {
    const r = evaluateRules("pol_x", "1", RULES, PASSING_CONTEXT);
    expect(r.passed).toBe(true);
    expect(r.policyId).toBe("pol_x");
    expect(r.policyVersion).toBe("1");
    expect(r.hardConstraints.passed).toBe(true);
    expect(r.hardConstraints.violations.length).toBe(0);
    // The preference (rule_6) is violated but the policy still passes.
    expect(r.preferences.violated.length).toBe(1);
    expect(r.preferences.violated[0]!.ruleId).toBe("rule_6");
    expect(r.preferences.satisfied.length).toBe(0);
    expect(r.ruleResults.length).toBe(8);
  });

  it("a hard-constraint failure → passed=false with an explainable violation", () => {
    const r = evaluateRules("pol_x", "2", RULES, {
      ...PASSING_CONTEXT,
      certification: "contract_verified", // ≠ certified
    });
    expect(r.passed).toBe(false);
    expect(r.hardConstraints.violations.length).toBe(1);
    const v = r.hardConstraints.violations[0]!;
    // The explainability contract (WORK-008 §10): rule_id, result,
    // actual, expected, operator, mode, reason — "why was it rejected?".
    expect(v.ruleId).toBe("rule_2");
    expect(v.subject).toBe("certification");
    expect(v.operator).toBe("eq");
    expect(v.mode).toBe("hard");
    expect(v.result).toBe("fail");
    expect(v.actual).toBe("contract_verified");
    expect(v.expected).toBe("certified");
    expect(v.reason).toContain("does not equal");
  });

  it("DETERMINISM: same version + same context → identical result (deep equality, repeated)", () => {
    const a = evaluateRules("pol_x", "1", RULES, PASSING_CONTEXT);
    const b = evaluateRules("pol_x", "1", RULES, PASSING_CONTEXT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Different version → different embedded version (results are
    // version-pinned).
    const c = evaluateRules("pol_x", "3", RULES, PASSING_CONTEXT);
    expect(c.policyVersion).toBe("3");
  });

  it("missing context values fail value operators with reason missing_value; not_exists passes", () => {
    const rules: PolicyRule[] = [
      { id: "rule_1", subject: "region", operator: "eq", value: "EU", mode: "hard" },
      { id: "rule_2", subject: "provider_status", operator: "exists", mode: "hard" },
      { id: "rule_3", subject: "pricing_amount", operator: "not_exists", mode: "hard" },
    ];
    const r = evaluateRules("pol", "1", rules, {});
    expect(r.passed).toBe(false);
    expect(r.hardConstraints.violations.map((v) => v.ruleId)).toEqual(["rule_1", "rule_2"]);
    expect(r.hardConstraints.violations.every((v) => v.reason === "missing_value" || v.reason === "subject is absent")).toBe(true);
    // not_exists passes when absent.
    const ne = r.ruleResults.find((x) => x.ruleId === "rule_3")!;
    expect(ne.result).toBe("pass");
  });

  it("type mismatches fail deterministically with reason type_mismatch (never throw)", () => {
    const rules: PolicyRule[] = [
      { id: "rule_1", subject: "estimated_cost", operator: "lte", value: 0.2, mode: "hard" },
      { id: "rule_2", subject: "region", operator: "eq", value: "EU", mode: "hard" },
    ];
    const r = evaluateRules("pol", "1", rules, {
      estimated_cost: "cheap", // wrong type
      region: 42, // wrong type
    });
    expect(r.passed).toBe(false);
    expect(r.ruleResults.every((x) => x.result === "fail")).toBe(true);
    expect(r.ruleResults.every((x) => x.reason === "type_mismatch")).toBe(true);
    expect(r.ruleResults[0]!.actual).toBe("cheap");
    expect(r.ruleResults[1]!.actual).toBe(42);
  });

  it("all operators evaluate correctly (eq, ne, in, not_in, gt, gte, lt, lte, exists, not_exists)", () => {
    const rules: PolicyRule[] = [
      { id: "r1", subject: "region", operator: "eq", value: "EU", mode: "hard" },
      { id: "r2", subject: "country", operator: "ne", value: "US", mode: "hard" },
      { id: "r3", subject: "currency", operator: "in", value: ["GHS", "USD"], mode: "hard" },
      { id: "r4", subject: "privacy_class", operator: "not_in", value: ["pii"], mode: "hard" },
      { id: "r5", subject: "availability", operator: "gt", value: 0.99, mode: "hard" },
      { id: "r6", subject: "estimated_cost", operator: "gte", value: 0.01, mode: "hard" },
      { id: "r7", subject: "estimated_latency_ms", operator: "lt", value: 500, mode: "hard" },
      { id: "r8", subject: "pricing_amount", operator: "lte", value: 10, mode: "hard" },
      { id: "r9", subject: "provider", operator: "exists", mode: "hard" },
      { id: "r10", subject: "execution_mode", operator: "not_exists", mode: "hard" },
      { id: "r11", subject: "idempotent_execution", operator: "eq", value: true, mode: "hard" },
    ];
    const r = evaluateRules("pol", "1", rules, {
      region: "EU",
      country: "GH",
      currency: "GHS",
      privacy_class: "internal",
      availability: 0.995,
      estimated_cost: 0.01,
      estimated_latency_ms: 499,
      pricing_amount: 10,
      provider: "demo.echo",
      idempotent_execution: true,
      // execution_mode intentionally absent
    });
    expect(r.passed).toBe(true);
    expect(r.ruleResults.every((x) => x.result === "pass")).toBe(true);
  });

  it("validated rules from validateRules evaluate end-to-end (integration of model + evaluator)", () => {
    const doc = validateRules([
      { subject: "region", operator: "eq", value: "EU", mode: "hard" },
      { subject: "integration_path", operator: "eq", value: "platform_operated", mode: "preference" },
    ]);
    const r = evaluateRules("pol", "1", doc.rules, { region: "EU", integration_path: "platform_operated" });
    expect(r.passed).toBe(true);
    expect(r.preferences.satisfied.length).toBe(1);
  });
});
