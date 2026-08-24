// tests/policies/rules.test.ts — WORK-008 rule-model unit tests (no
// infrastructure): validation of the constrained declarative vocabulary,
// anti-code-execution bounds, and deterministic conflict detection.
import { describe, expect, it } from "bun:test";
import { AppError } from "@cp/platform";
import {
  validateRules,
  validateEvaluationContext,
  detectConflicts,
  MAX_RULES_PER_VERSION,
  MAX_LIST_SIZE,
  MAX_VALUE_STRING_LEN,
  isSubject,
  isRuleOperator,
  subjectType,
  operatorAllowedForType,
  POLICY_SUBJECTS,
  SUBJECT_NAMES,
} from "@cp/policies";

async function expectInvalid(fn: () => unknown): Promise<AppError> {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe("WORK-008 rule validation (constrained declarative model)", () => {
  it("accepts a valid mixed rule set and assigns deterministic ids", () => {
    const doc = validateRules([
      { subject: "region", operator: "eq", value: "EU", mode: "hard" },
      { subject: "certification", operator: "eq", value: "certified", mode: "hard" },
      { subject: "estimated_cost", operator: "lte", value: 0.2, mode: "hard" },
      { subject: "estimated_latency_ms", operator: "lt", value: 500, mode: "hard" },
      { subject: "country", operator: "in", value: ["GH", "NG"], mode: "hard" },
      { subject: "integration_path", operator: "eq", value: "platform_operated", mode: "preference" },
      { subject: "pii_allowed", operator: "eq", value: false, mode: "hard" },
      { subject: "privacy_class", operator: "not_in", value: ["pii"], mode: "hard" },
      { subject: "provider_status", operator: "exists", mode: "hard" },
      { subject: "idempotent_execution", operator: "eq", value: true, mode: "preference" },
    ]);
    expect(doc.schema).toBe(1);
    expect(doc.rules.length).toBe(10);
    expect(doc.rules.map((r) => r.id)).toEqual([
      "rule_1", "rule_2", "rule_3", "rule_4", "rule_5",
      "rule_6", "rule_7", "rule_8", "rule_9", "rule_10",
    ]);
  });

  it("rejects unknown subjects and operators before persistence", async () => {
    let e = await expectInvalid(() =>
      validateRules([{ subject: "vibe", operator: "eq", value: "good", mode: "hard" }]),
    );
    expect(e.code).toBe("policy.rules.invalid");
    expect((e.details as { reason: string }).reason).toBe("unknown_subject");

    e = await expectInvalid(() =>
      validateRules([{ subject: "region", operator: "vibes_with", value: "EU", mode: "hard" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("unknown_operator");
  });

  it("rejects type mismatches: comparisons on strings, in on numbers, wrong value types", async () => {
    let e = await expectInvalid(() =>
      validateRules([{ subject: "region", operator: "gt", value: 5, mode: "hard" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("operator_subject_type_mismatch");
    e = await expectInvalid(() =>
      validateRules([{ subject: "estimated_cost", operator: "in", value: [1, 2], mode: "hard" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("operator_subject_type_mismatch");
    e = await expectInvalid(() =>
      validateRules([{ subject: "estimated_cost", operator: "eq", value: "cheap", mode: "hard" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("invalid_value_shape");
    e = await expectInvalid(() =>
      validateRules([{ subject: "region", operator: "eq", value: true, mode: "hard" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("invalid_value_shape");
    e = await expectInvalid(() =>
      validateRules([{ subject: "pii_allowed", operator: "eq", value: 1, mode: "hard" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("invalid_value_shape");
    e = await expectInvalid(() =>
      validateRules([{ subject: "country", operator: "in", value: [1, 2], mode: "hard" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("invalid_value_shape");
    e = await expectInvalid(() =>
      validateRules([{ subject: "country", operator: "in", value: [], mode: "hard" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("invalid_value_shape");
  });

  it("rejects wrong shapes: missing value, value on exists, non-object rules, empty sets", async () => {
    let e = await expectInvalid(() =>
      validateRules([{ subject: "region", operator: "eq", mode: "hard" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("missing_value");
    e = await expectInvalid(() =>
      validateRules([{ subject: "region", operator: "exists", value: "EU", mode: "hard" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("value_not_allowed");
    e = await expectInvalid(() => validateRules("all good"));
    expect((e.details as { reason: string }).reason).toBe("not_an_array");
    e = await expectInvalid(() => validateRules([]));
    expect((e.details as { reason: string }).reason).toBe("empty_rules");
    e = await expectInvalid(() => validateRules([42]));
    expect((e.details as { reason: string }).reason).toBe("invalid_shape");
    e = await expectInvalid(() =>
      validateRules([{ subject: "region", operator: "eq", value: "EU", mode: "soft" }]),
    );
    expect((e.details as { reason: string }).reason).toBe("invalid_mode");
  });

  it("enforces resource bounds: rule count, string length, list size (anti-code-execution model)", async () => {
    const many = Array.from({ length: MAX_RULES_PER_VERSION + 1 }, (_, i) => ({
      subject: "region",
      operator: "eq" as const,
      value: `r${i}`,
      mode: "hard" as const,
    }));
    const e = await expectInvalid(() => validateRules(many));
    expect((e.details as { reason: string }).reason).toBe("too_many_rules");
    const e2 = await expectInvalid(() =>
      validateRules([{ subject: "region", operator: "eq", value: "x".repeat(MAX_VALUE_STRING_LEN + 1), mode: "hard" }]),
    );
    expect((e2.details as { reason: string }).reason).toBe("value_too_long");
    const e3 = await expectInvalid(() =>
      validateRules([{ subject: "country", operator: "in", value: Array.from({ length: MAX_LIST_SIZE + 1 }, (_, i) => `C${i}`), mode: "hard" }]),
    );
    expect((e3.details as { reason: string }).reason).toBe("list_too_large");
    const e4 = await expectInvalid(() =>
      validateRules([{ subject: "region", operator: "eq", value: "EU\n; rm -rf /", mode: "hard" }]),
    );
    expect((e4.details as { reason: string }).reason).toBe("unsafe_characters");
    const e5 = await expectInvalid(() =>
      validateRules([{ subject: "region", operator: "eq", value: "EU\u0000bad", mode: "hard" }]),
    );
    expect((e5.details as { reason: string }).reason).toBe("unsafe_characters");
  });

  it("subject vocabulary covers the acceptance-criteria domains with types", () => {
    for (const s of [
      "region", "country", "currency",
      "capability", "capability_version",
      "provider", "provider_status", "integration_path",
      "certification", "certification_environment",
      "estimated_cost", "estimated_latency_ms",
      "privacy_class", "pii_allowed",
    ]) {
      expect(isSubject(s)).toBe(true);
    }
    expect(subjectType("region")).toBe("string");
    expect(subjectType("estimated_cost")).toBe("number");
    expect(subjectType("pii_allowed")).toBe("boolean");
    expect(isSubject("sql_query")).toBe(false);
    expect(isRuleOperator("exec")).toBe(false);
    expect(operatorAllowedForType("gt", "string")).toBe(false);
    expect(operatorAllowedForType("gt", "number")).toBe(true);
    expect(operatorAllowedForType("in", "boolean")).toBe(false);
    expect(SUBJECT_NAMES.length).toBe(Object.keys(POLICY_SUBJECTS).length);
  });
});

describe("WORK-008 conflict detection (deterministic, explicit)", () => {
  it("detects eq/eq, eq/ne, eq/in, in/in disjoint, and bound crossings", () => {
    const doc = validateRules([
      { subject: "region", operator: "eq", value: "EU", mode: "hard" },
    ]);
    const rules = doc.rules;

    const c1 = detectConflicts([
      ...rules,
      { id: "rule_2", subject: "region", operator: "eq", value: "US", mode: "hard" },
    ]);
    expect(c1.length).toBe(1);
    expect(c1[0]!.explanation).toContain("cannot equal both");

    const c2 = detectConflicts([
      ...rules,
      { id: "rule_2", subject: "region", operator: "ne", value: "EU", mode: "hard" },
    ]);
    expect(c2.length).toBe(1);
    expect(c2[0]!.explanation).toContain("equal and not equal");

    const c3 = detectConflicts([
      ...rules,
      { id: "rule_2", subject: "region", operator: "in", value: ["US", "ASIA"], mode: "hard" },
    ]);
    expect(c3.length).toBe(1);

    const c4 = detectConflicts([
      ...rules,
      { id: "rule_2", subject: "region", operator: "not_in", value: ["EU", "US"], mode: "hard" },
    ]);
    expect(c4.length).toBe(1);

    const c5 = detectConflicts([
      { id: "rule_1", subject: "country", operator: "in", value: ["GH", "NG"], mode: "hard" },
      { id: "rule_2", subject: "country", operator: "in", value: ["US", "CA"], mode: "hard" },
    ]);
    expect(c5.length).toBe(1);
    expect(c5[0]!.explanation).toContain("disjoint sets");

    const c6 = detectConflicts([
      { id: "rule_1", subject: "estimated_cost", operator: "gt", value: 0.5, mode: "hard" },
      { id: "rule_2", subject: "estimated_cost", operator: "lt", value: 0.2, mode: "hard" },
    ]);
    expect(c6.length).toBe(1);
    expect(c6[0]!.explanation).toContain("cannot satisfy");

    expect(
      detectConflicts([
        { id: "rule_1", subject: "estimated_cost", operator: "gte", value: 1, mode: "hard" },
        { id: "rule_2", subject: "estimated_cost", operator: "lte", value: 1, mode: "hard" },
      ]).length,
    ).toBe(0);
    expect(
      detectConflicts([
        { id: "rule_1", subject: "estimated_cost", operator: "gt", value: 1, mode: "hard" },
        { id: "rule_2", subject: "estimated_cost", operator: "lte", value: 1, mode: "hard" },
      ]).length,
    ).toBe(1);
    const c7 = detectConflicts([
      { id: "rule_1", subject: "estimated_cost", operator: "eq", value: 5, mode: "hard" },
      { id: "rule_2", subject: "estimated_cost", operator: "lt", value: 3, mode: "hard" },
    ]);
    expect(c7.length).toBe(1);
  });

  it("preferences never conflict; different subjects never conflict", () => {
    expect(
      detectConflicts([
        { id: "rule_1", subject: "region", operator: "eq", value: "EU", mode: "preference" },
        { id: "rule_2", subject: "region", operator: "eq", value: "US", mode: "preference" },
      ]).length,
    ).toBe(0);
    expect(
      detectConflicts([
        { id: "rule_1", subject: "region", operator: "eq", value: "EU", mode: "hard" },
        { id: "rule_2", subject: "country", operator: "eq", value: "US", mode: "hard" },
      ]).length,
    ).toBe(0);
  });

  it("validateRules REJECTS internally contradictory hard sets", async () => {
    const e = await expectInvalid(() =>
      validateRules([
        { subject: "region", operator: "eq", value: "EU", mode: "hard" },
        { subject: "region", operator: "eq", value: "US", mode: "hard" },
      ]),
    );
    expect((e.details as { reason: string }).reason).toBe("conflicting_rules");
    const conflicts = (e.details as { conflicts: { ruleA: string; ruleB: string }[] }).conflicts;
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.ruleA).toBe("rule_1");
    expect(conflicts[0]!.ruleB).toBe("rule_2");
  });
});

describe("WORK-008 evaluation context validation", () => {
  it("accepts primitive-valued contexts; rejects non-primitives, oversize keys, non-objects", async () => {
    const ctx = validateEvaluationContext({
      region: "EU",
      estimated_cost: 0.1,
      pii_allowed: false,
      missing: null,
    });
    expect(ctx.region).toBe("EU");
    let e = await expectInvalid(() => validateEvaluationContext({ nested: { deep: 1 } }));
    expect((e.details as { reason: string }).reason).toBe("invalid_context_value");
    e = await expectInvalid(() => validateEvaluationContext([1, 2, 3]));
    expect((e.details as { reason: string }).reason).toBe("invalid_context");
    e = await expectInvalid(() => validateEvaluationContext({ x: NaN }));
    expect((e.details as { reason: string }).reason).toBe("invalid_context_value");
    const big: Record<string, number> = {};
    for (let i = 0; i < 65; i++) big[`k${i}`] = i;
    e = await expectInvalid(() => validateEvaluationContext(big));
    expect((e.details as { reason: string }).reason).toBe("context_too_large");
    expect(validateEvaluationContext(null)).toEqual({});
    expect(validateEvaluationContext(undefined)).toEqual({});
  });
});
