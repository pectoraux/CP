// /policies/internal/rules.ts
// The constrained, declarative policy rule model (WORK-008, architecture
// §10, §36; frozen POLICY-001..004).
//
// A Policy Rule is a small, deterministic, serializable, auditable data
// structure — NEVER a program:
//
//     { subject, operator, value?, mode }
//
//   - subject  : a closed, typed vocabulary (string/number/boolean facts
//                of the normalized evaluation context — geography,
//                capability, provider status, cost, latency, privacy,
//                certification, execution properties)
//   - operator : a closed enum (eq, ne, in, not_in, gt, gte, lt, lte,
//                exists, not_exists), type-gated by the subject
//   - value    : a primitive (or list of strings for in/not_in); absent
//                for exists/not_exists
//   - mode     : hard | preference
//
// There is NO eval(), NO scripting, NO SQL, NO JavaScript, NO expression
// language: operators are implemented as a closed switch in evaluator.ts.
// Anything outside the vocabulary is rejected BEFORE persistence.
//
// Hard vs preference (architecture §10, WORK-008 §2, §12):
//   HARD       — violation ⇒ a candidate MUST be rejected later by
//                Eligibility (WORK-009)
//   PREFERENCE — violation ⇒ the candidate may remain eligible; the
//                deterministic preference result feeds later
//                strategy/ranking
// The policy engine itself never chooses a provider.
//
// Resource bounds (WORK-008 §21): rules are a FLAT list (no nesting, no
// recursion — recursion is structurally impossible), capped at
// MAX_RULES_PER_VERSION; values are capped in length/size; every string
// is validated as inert data.

import { AppError } from "@cp/platform";

// ---- Mode -------------------------------------------------------------------

export type RuleMode = "hard" | "preference";

export const RULE_MODES: readonly RuleMode[] = ["hard", "preference"] as const;

export function isRuleMode(v: string): v is RuleMode {
  return v === "hard" || v === "preference";
}

// ---- Subjects (closed, typed vocabulary) --------------------------------------

export type SubjectType = "string" | "number" | "boolean";

interface SubjectDef {
  type: SubjectType;
  description: string;
}

/**
 * The policy subject vocabulary: the structured facts of the normalized
 * evaluation context a rule may constrain (WORK-008 §9; acceptance
 * criteria: geography, capability, provider status, cost, latency,
 * privacy/security attributes, provider certification). Rules NEVER
 * access database tables — the evaluator receives a plain context
 * object, so policy definitions stay decoupled from schema.
 */
export const POLICY_SUBJECTS: Readonly<Record<string, SubjectDef>> = {
  // Geography
  region: { type: "string", description: "Region slug of the execution/provider surface (e.g. EU, EMEA)" },
  country: { type: "string", description: "Country code of the execution/provider surface (e.g. GH)" },
  currency: { type: "string", description: "Settlement/transaction currency (e.g. GHS)" },
  // Capability
  capability: { type: "string", description: "Canonical capability id (e.g. payment.accept)" },
  capability_version: { type: "string", description: "Capability contract version (e.g. 2)" },
  // Provider attributes (normalized marketplace facts)
  provider: { type: "string", description: "Canonical provider id (e.g. demo.echo)" },
  provider_status: { type: "string", description: "Provider lifecycle status (e.g. active, certified)" },
  integration_path: { type: "string", description: "Platform-operated vs provider-operated integration path" },
  certification: { type: "string", description: "Implementation certification state (registered|contract_verified|certified)" },
  certification_environment: { type: "string", description: "Certification evidence environment (none|fixture|live)" },
  pricing_model: { type: "string", description: "Declared pricing model (per_request|per_token|...)" },
  // Cost / performance
  estimated_cost: { type: "number", description: "Estimated cost of the operation (major currency units)" },
  estimated_cost_currency: { type: "string", description: "Currency of the estimated cost (e.g. GHS)" },
  estimated_latency_ms: { type: "number", description: "Estimated latency in milliseconds" },
  availability: { type: "number", description: "Observed availability ratio (0..1)" },
  pricing_amount: { type: "number", description: "Declared pricing amount for the applicable model" },
  // Privacy / security
  privacy_class: { type: "string", description: "Data privacy classification (e.g. public, internal, pii)" },
  pii_allowed: { type: "boolean", description: "Whether PII processing is permitted for this execution" },
  // Execution properties
  execution_mode: { type: "string", description: "Execution mode (e.g. live, dry_run)" },
  idempotent_execution: { type: "boolean", description: "Whether the execution is idempotent" },
};

export const SUBJECT_NAMES: readonly string[] = Object.keys(POLICY_SUBJECTS);

export function isSubject(v: string): v is string {
  return Object.prototype.hasOwnProperty.call(POLICY_SUBJECTS, v);
}

export function subjectType(subject: string): SubjectType | null {
  return POLICY_SUBJECTS[subject]?.type ?? null;
}

// ---- Operators (closed, type-gated enum) ----------------------------------------

export type RuleOperator =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists";

export const RULE_OPERATORS: readonly RuleOperator[] = [
  "eq",
  "ne",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "not_exists",
] as const;

export function isRuleOperator(v: string): v is RuleOperator {
  return (RULE_OPERATORS as readonly string[]).includes(v);
}

/** Which operators are legal for a subject type (type-gating). */
const OPERATORS_BY_TYPE: Readonly<Record<SubjectType, readonly RuleOperator[]>> = {
  string: ["eq", "ne", "in", "not_in", "exists", "not_exists"],
  number: ["eq", "ne", "gt", "gte", "lt", "lte", "exists", "not_exists"],
  boolean: ["eq", "ne", "exists", "not_exists"],
};

export function operatorAllowedForType(op: RuleOperator, type: SubjectType): boolean {
  return OPERATORS_BY_TYPE[type].includes(op);
}

// ---- Bounds (WORK-008 §21 — resource-bounded policy evaluation) ------------------

export const MAX_RULES_PER_VERSION = 100;
export const MAX_VALUE_STRING_LEN = 512;
export const MAX_LIST_SIZE = 50;
export const MAX_CONTEXT_KEYS = 64;
export const MAX_POLICY_NAME_LEN = 200;
export const MAX_POLICY_DESCRIPTION_LEN = 2000;

// ---- The rule shape ---------------------------------------------------------------

export interface PolicyRule {
  /** Stable, deterministic id assigned at validation (rule_1, rule_2, ...). */
  id: string;
  subject: string;
  operator: RuleOperator;
  /** Absent for exists/not_exists. */
  value?: string | number | boolean | string[];
  mode: RuleMode;
}

/** Rules as received from callers (before validation/normalization). */
export type RuleInput = Record<string, unknown>;

/** The persisted rules document (schema-versioned for future evolution). */
export interface RulesDocument {
  schema: 1;
  rules: PolicyRule[];
}

// ---- Validation ---------------------------------------------------------------------

/**
 * Validate and normalize a caller-supplied rule list into the persisted
 * RulesDocument. Rejects (POLICY_BLOCKED policy.rules.invalid) anything
 * outside the constrained model: unknown subjects/operators, type
 * mismatches, wrong value shapes, code-like strings, excessive counts.
 * Rule ids are assigned deterministically (rule_1..rule_N in array
 * order) so evaluation results reference stable ids.
 */
export function validateRules(input: unknown): RulesDocument {
  if (!Array.isArray(input)) {
    throw rulesInvalid("rules must be an array", { reason: "not_an_array" });
  }
  if (input.length === 0) {
    throw rulesInvalid("a policy version must declare at least one rule", { reason: "empty_rules" });
  }
  if (input.length > MAX_RULES_PER_VERSION) {
    throw rulesInvalid(`a policy version may declare at most ${MAX_RULES_PER_VERSION} rules (got ${input.length})`, {
      reason: "too_many_rules",
      count: input.length,
    });
  }
  const rules: PolicyRule[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i]!;
    rules.push(validateOneRule(raw, i));
  }
  // Deterministic conflict detection: an internally contradictory HARD
  // rule set is rejected before persistence (WORK-008 §14 — nothing is
  // silently chosen).
  const conflicts = detectConflicts(rules);
  if (conflicts.length > 0) {
    throw rulesInvalid("the rule set is internally contradictory", {
      reason: "conflicting_rules",
      conflicts,
    });
  }
  return { schema: 1, rules };
}

function validateOneRule(raw: unknown, index: number): PolicyRule {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw rulesInvalid(`rule ${index + 1} must be an object`, { reason: "invalid_shape", rule_index: index });
  }
  const r = raw as Record<string, unknown>;

  const subject = r.subject;
  if (typeof subject !== "string" || !isSubject(subject)) {
    throw rulesInvalid(`rule ${index + 1}: unknown subject "${String(subject)}"`, {
      reason: "unknown_subject",
      rule_index: index,
      subject: String(subject),
      allowed_subjects: SUBJECT_NAMES,
    });
  }
  const type = subjectType(subject)!;

  const operator = r.operator;
  if (typeof operator !== "string" || !isRuleOperator(operator)) {
    throw rulesInvalid(`rule ${index + 1}: unknown operator "${String(operator)}"`, {
      reason: "unknown_operator",
      rule_index: index,
      operator: String(operator),
      allowed_operators: RULE_OPERATORS,
    });
  }
  if (!operatorAllowedForType(operator, type)) {
    throw rulesInvalid(`rule ${index + 1}: operator "${operator}" is not valid for subject "${subject}" (type ${type})`, {
      reason: "operator_subject_type_mismatch",
      rule_index: index,
      subject,
      operator,
      subject_type: type,
    });
  }

  const mode = r.mode;
  if (typeof mode !== "string" || !isRuleMode(mode)) {
    throw rulesInvalid(`rule ${index + 1}: mode must be "hard" or "preference"`, {
      reason: "invalid_mode",
      rule_index: index,
      mode: String(mode),
    });
  }

  // Value shape per operator family.
  const hasValue = r.value !== undefined && r.value !== null;
  if (operator === "exists" || operator === "not_exists") {
    if (hasValue) {
      throw rulesInvalid(`rule ${index + 1}: operator "${operator}" takes no value`, {
        reason: "value_not_allowed",
        rule_index: index,
      });
    }
    return { id: `rule_${index + 1}`, subject, operator, mode };
  }
  if (!hasValue) {
    throw rulesInvalid(`rule ${index + 1}: operator "${operator}" requires a value`, {
      reason: "missing_value",
      rule_index: index,
    });
  }

  let value: PolicyRule["value"];
  if (operator === "in" || operator === "not_in") {
    if (type !== "string") {
      throw rulesInvalid(`rule ${index + 1}: in/not_in are only valid for string subjects (subject "${subject}" is ${type})`, {
        reason: "operator_subject_type_mismatch",
        rule_index: index,
      });
    }
    if (!Array.isArray(r.value) || r.value.length === 0) {
      throw rulesInvalid(`rule ${index + 1}: operator "${operator}" requires a non-empty array value`, {
        reason: "invalid_value_shape",
        rule_index: index,
      });
    }
    if (r.value.length > MAX_LIST_SIZE) {
      throw rulesInvalid(`rule ${index + 1}: list values may contain at most ${MAX_LIST_SIZE} items`, {
        reason: "list_too_large",
        rule_index: index,
        size: r.value.length,
      });
    }
    const list: string[] = [];
    for (const item of r.value) {
      if (typeof item !== "string") {
        throw rulesInvalid(`rule ${index + 1}: list values must be strings`, {
          reason: "invalid_value_shape",
          rule_index: index,
        });
      }
      list.push(safeString(item, index));
    }
    value = list;
  } else if (operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") {
    if (type !== "number") {
      throw rulesInvalid(`rule ${index + 1}: comparison operators are only valid for number subjects (subject "${subject}" is ${type})`, {
        reason: "operator_subject_type_mismatch",
        rule_index: index,
      });
    }
    const n = r.value;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw rulesInvalid(`rule ${index + 1}: operator "${operator}" requires a finite number value`, {
        reason: "invalid_value_shape",
        rule_index: index,
      });
    }
    value = n;
  } else {
    // eq / ne — value must match the subject's type.
    if (type === "string") {
      if (typeof r.value !== "string") {
        throw rulesInvalid(`rule ${index + 1}: subject "${subject}" requires a string value`, {
          reason: "invalid_value_shape",
          rule_index: index,
        });
      }
      value = safeString(r.value, index);
    } else if (type === "number") {
      if (typeof r.value !== "number" || !Number.isFinite(r.value)) {
        throw rulesInvalid(`rule ${index + 1}: subject "${subject}" requires a finite number value`, {
          reason: "invalid_value_shape",
          rule_index: index,
        });
      }
      value = r.value;
    } else {
      if (typeof r.value !== "boolean") {
        throw rulesInvalid(`rule ${index + 1}: subject "${subject}" requires a boolean value`, {
          reason: "invalid_value_shape",
          rule_index: index,
        });
      }
      value = r.value;
    }
  }

  return { id: `rule_${index + 1}`, subject, operator, value, mode };
}

/**
 * Validate a string as INERT DATA. Rejects control characters (including
 * NUL and newlines — nothing that could smuggle executable content into
 * logs/serializations) and enforces the length cap. This is data
 * validation, not code detection: the model has no execution surface at
 * all (closed enums + a switch evaluator); this guard keeps values clean
 * text.
 */
function safeString(s: string, index: number): string {
  if (s.length > MAX_VALUE_STRING_LEN) {
    throw rulesInvalid(`rule ${index + 1}: string values may be at most ${MAX_VALUE_STRING_LEN} characters`, {
      reason: "value_too_long",
      rule_index: index,
    });
  }
  // Reject ALL control characters (including NUL, tab, newlines — the
  // values are inert plain-text data; nothing that could smuggle
  // executable content into logs/serializations).
  if (/[\u0000-\u001F\u007F]/.test(s)) {
    throw rulesInvalid(`rule ${index + 1}: string values must not contain control characters`, {
      reason: "unsafe_characters",
      rule_index: index,
    });
  }
  return s;
}

// ---- Conflict detection (WORK-008 §14) -------------------------------------------

export interface RuleConflict {
  ruleA: string;
  ruleB: string;
  subject: string;
  explanation: string;
}

/**
 * Deterministic detection of INTERNALLY CONTRADICTORY hard-rule pairs on
 * the same subject. Preferences never conflict (they are soft). Covers
 * the decidable primitive combinations:
 *   eq a vs eq b (a≠b)                — mutually exclusive
 *   eq a vs ne a                      — direct contradiction
 *   eq a vs in L (a∉L) / not_in L(a∈L)
 *   in L1 vs in L2 (L1∩L2=∅)
 *   bound crossings (x > A and x < B with A ≥ B, and mixed variants)
 *   eq a vs bound violated by a
 *   in L vs bound violated by EVERY element of L
 * Returns the conflict list; validateRules REJECTS when non-empty.
 */
export function detectConflicts(rules: PolicyRule[]): RuleConflict[] {
  const conflicts: RuleConflict[] = [];
  const hard = rules.filter((r) => r.mode === "hard");
  for (let i = 0; i < hard.length; i++) {
    for (let j = i + 1; j < hard.length; j++) {
      const a = hard[i]!;
      const b = hard[j]!;
      if (a.subject !== b.subject) continue;
      const c = pairConflict(a, b);
      if (c) conflicts.push(c);
    }
  }
  return conflicts;
}

function pairConflict(a: PolicyRule, b: PolicyRule): RuleConflict | null {
  const mk = (explanation: string): RuleConflict => ({
    ruleA: a.id,
    ruleB: b.id,
    subject: a.subject,
    explanation,
  });

  const eq = (r: PolicyRule): string | number | boolean | null =>
    r.operator === "eq" && r.value !== undefined ? (r.value as string | number | boolean) : null;

  const ea = eq(a);
  const eb = eq(b);
  if (ea !== null && eb !== null) {
    if (ea !== eb) return mk(`subject "${a.subject}" cannot equal both ${JSON.stringify(ea)} and ${JSON.stringify(eb)}`);
    return null;
  }
  if (ea !== null) return eqVsOther(ea, a, b, mk);
  if (eb !== null) return eqVsOther(eb, b, a, mk);

  const inList = (r: PolicyRule): string[] | null =>
    r.operator === "in" && Array.isArray(r.value) ? (r.value as string[]) : null;
  const la = inList(a);
  const lb = inList(b);
  if (la !== null && lb !== null) {
    const shared = la.some((x) => lb.includes(x));
    if (!shared) return mk(`subject "${a.subject}" cannot be in both ${JSON.stringify(la)} and ${JSON.stringify(lb)} (disjoint sets)`);
    return null;
  }

  const bounds: { r: PolicyRule; op: RuleOperator; v: number }[] = [];
  for (const r of [a, b]) {
    if (
      (r.operator === "gt" || r.operator === "gte" || r.operator === "lt" || r.operator === "lte") &&
      typeof r.value === "number"
    ) {
      bounds.push({ r, op: r.operator, v: r.value });
    }
  }
  if (bounds.length === 2) {
    const [x, y] = bounds as [{ r: PolicyRule; op: RuleOperator; v: number }, { r: PolicyRule; op: RuleOperator; v: number }];
    const xLower = x.op === "gt" || x.op === "gte";
    const yLower = y.op === "gt" || y.op === "gte";
    if (xLower !== yLower) {
      const lower = xLower ? x : y;
      const upper = xLower ? y : x;
      const lowerExclusive = lower.op === "gt";
      const upperExclusive = upper.op === "lt";
      // lower bound L vs upper bound U: contradiction iff L >= U, or
      // L == U when either side is exclusive.
      if (lower.v > upper.v || (lower.v === upper.v && (lowerExclusive || upperExclusive))) {
        return mk(
          `subject "${a.subject}" cannot satisfy ${lower.op} ${lower.v} together with ${upper.op} ${upper.v}`,
        );
      }
    }
  }
  return null;
}

function eqVsOther(
  e: string | number | boolean,
  eqRule: PolicyRule,
  other: PolicyRule,
  mk: (explanation: string) => RuleConflict,
): RuleConflict | null {
  const subject = other.subject;
  switch (other.operator) {
    case "ne":
      if (other.value === e) {
        return mk(`subject "${subject}" cannot both equal and not equal ${JSON.stringify(e)}`);
      }
      return null;
    case "in":
      if (Array.isArray(other.value) && !other.value.includes(e as string)) {
        return mk(`subject "${subject}" cannot equal ${JSON.stringify(e)} and be in ${JSON.stringify(other.value)}`);
      }
      return null;
    case "not_in":
      if (Array.isArray(other.value) && other.value.includes(e as string)) {
        return mk(`subject "${subject}" cannot equal ${JSON.stringify(e)} and not be in ${JSON.stringify(other.value)}`);
      }
      return null;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (typeof other.value === "number" && typeof e === "number") {
        if (!boundOk(other.operator, other.value, e)) {
          return mk(`subject "${subject}" cannot equal ${e} while requiring ${other.operator} ${other.value}`);
        }
      }
      return null;
    default:
      return null;
  }
}

function boundOk(op: RuleOperator, bound: number, v: number): boolean {
  switch (op) {
    case "gt": return v > bound;
    case "gte": return v >= bound;
    case "lt": return v < bound;
    case "lte": return v <= bound;
    default: return true;
  }
}

// ---- Context validation --------------------------------------------------------

/**
 * Validate a caller-supplied evaluation context: at most MAX_CONTEXT_KEYS
 * entries, primitive values only (string/number/boolean/null — the
 * normalized fact shape). Returns a plain Record. The evaluator is pure
 * and resource-bounded by construction on this shape.
 */
export function validateEvaluationContext(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw rulesInvalid("evaluation context must be an object", { reason: "invalid_context" });
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_CONTEXT_KEYS) {
    throw rulesInvalid(`evaluation context may contain at most ${MAX_CONTEXT_KEYS} keys`, {
      reason: "context_too_large",
      keys: entries.length,
    });
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (k.length > MAX_VALUE_STRING_LEN) {
      throw rulesInvalid("evaluation context keys must be at most ${MAX_VALUE_STRING_LEN} characters", {
        reason: "context_key_too_long",
      });
    }
    if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw rulesInvalid(`evaluation context value for "${k}" must be a primitive (string|number|boolean|null)`, {
        reason: "invalid_context_value",
        key: k,
      });
    }
    if (typeof v === "string" && v.length > 4 * MAX_VALUE_STRING_LEN) {
      throw rulesInvalid(`evaluation context value for "${k}" is too long`, {
        reason: "context_value_too_long",
        key: k,
      });
    }
    if (typeof v === "number" && !Number.isFinite(v)) {
      throw rulesInvalid(`evaluation context value for "${k}" must be a finite number`, {
        reason: "invalid_context_value",
        key: k,
      });
    }
    out[k] = v;
  }
  return out;
}

function rulesInvalid(message: string, details: Record<string, unknown>): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "policy.rules.invalid",
    message,
    retryable: false,
    details,
  });
}
