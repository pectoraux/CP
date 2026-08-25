// /goals/internal/objectives.ts
// The constrained, declarative goal-objective model (WORK-011, frozen
// GOAL-001..003). An objective is an EXPLICIT entry — never free-form
// prose, never an expression tree (§5, §15):
//
//     { direction: maximize|minimize, metric, kind: hard|preference,
//       target?, unit?, threshold? }
//
//   - direction (§5): explicitly maximize or minimize — the objective's
//     semantic orientation is structured data.
//   - kind (§6-§7): hard target vs soft preference — explicitly
//     distinguished (paralleling WORK-008's hard/preference split, but
//     deliberately NOT coupled: this is the GOAL domain).
//   - metric: drawn from the /outcomes metric vocabulary (the same
//     constrained measurement space the outcome contracts define).
//   - target/threshold/unit: optional structured quantification. WORK-011
//     DEFINES targets; it never ENFORCES them against candidates (§6) —
//     future outcome evaluation does.
//
// Validation is deterministic and bounded (≤10 objectives per version,
// bounded strings) — no eval/SQL/JS/scripts (§9).

import { AppError } from "@cp/platform";
import {
  isOutcomeMetric,
  isOutcomeUnit,
  metricFamily,
  unitAllowedForMetric,
  type OutcomeMetric,
  type OutcomeUnit,
} from "@cp/outcomes";

// ---- Types --------------------------------------------------------------------

export type ObjectiveDirection = "maximize" | "minimize";

export const OBJECTIVE_DIRECTIONS: readonly ObjectiveDirection[] = ["maximize", "minimize"] as const;

export function isObjectiveDirection(v: string): v is ObjectiveDirection {
  return v === "maximize" || v === "minimize";
}

export type ObjectiveKind = "hard" | "preference";

export const OBJECTIVE_KINDS: readonly ObjectiveKind[] = ["hard", "preference"] as const;

export function isObjectiveKind(v: string): v is ObjectiveKind {
  return v === "hard" || v === "preference";
}

/** A single, explicit, structured objective entry. */
export interface GoalObjective {
  /** Stable deterministic id (obj_1..obj_N in array order). */
  id: string;
  direction: ObjectiveDirection;
  metric: OutcomeMetric;
  kind: ObjectiveKind;
  /** Optional quantified target (e.g. 0.99 for success_rate >= 0.99). */
  target?: number;
  /** Optional unit for the target. */
  unit?: OutcomeUnit;
  /** Optional bounded human explanation (never the semantics itself). */
  notes?: string;
}

/** The persisted objectives document (schema-versioned JSONB). */
export interface ObjectivesDocument {
  schema: 1;
  objectives: GoalObjective[];
}

export const MAX_OBJECTIVES = 10;
const MAX_NOTES_LEN = 512;

// ---- Validation -------------------------------------------------------------------

/**
 * Validate caller-supplied objectives. Rejects: unknown direction/metric/
 * kind, family-incompatible units, ratio targets outside [0,1] and
 * non-positive non-ratio targets, family-incompatible metric+direction
 * pairings (§5: "minimize success_rate" / "maximize error_rate" /
 * "maximize cost" / "minimize availability" are nonsensical and
 * rejected), duplicate (direction, metric) pairs, and excessive counts.
 */
export function validateObjectives(input: unknown): ObjectivesDocument {
  if (!Array.isArray(input)) {
    throw objectivesInvalid("objectives must be an array", { reason: "not_an_array" });
  }
  if (input.length === 0) {
    throw objectivesInvalid("a goal version must declare at least one objective", { reason: "empty_objectives" });
  }
  if (input.length > MAX_OBJECTIVES) {
    throw objectivesInvalid(`a goal version may declare at most ${MAX_OBJECTIVES} objectives (got ${input.length})`, {
      reason: "too_many_objectives",
      count: input.length,
    });
  }
  const seen = new Set<string>();
  const objectives: GoalObjective[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i]!;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw objectivesInvalid(`objective ${i + 1} must be an object`, {
        reason: "invalid_shape",
        objective_index: i,
      });
    }
    const r = raw as Record<string, unknown>;

    const direction = String(r.direction ?? "");
    if (!isObjectiveDirection(direction)) {
      throw objectivesInvalid(`objective ${i + 1}: direction must be maximize or minimize (got "${direction}")`, {
        reason: "invalid_direction",
        objective_index: i,
      });
    }
    const metric = String(r.metric ?? "");
    if (!isOutcomeMetric(metric)) {
      throw objectivesInvalid(`objective ${i + 1}: metric must be one of the outcome metric vocabulary (got "${metric}")`, {
        reason: "unknown_metric",
        objective_index: i,
      });
    }
    const kind = String(r.kind ?? "hard");
    if (!isObjectiveKind(kind)) {
      throw objectivesInvalid(`objective ${i + 1}: kind must be hard or preference (got "${kind}")`, {
        reason: "invalid_kind",
        objective_index: i,
      });
    }

    // Semantic direction/metric compatibility: nonsensical pairings are
    // rejected rather than silently stored.
    const family = metricFamily(metric);
    if (family === "ratio") {
      if (metric === "error_rate" && direction === "maximize") {
        throw objectivesInvalid(`objective ${i + 1}: "maximize error_rate" is nonsensical`, {
          reason: "direction_metric_mismatch",
          objective_index: i,
        });
      }
      if (metric !== "error_rate" && direction === "minimize") {
        throw objectivesInvalid(`objective ${i + 1}: "minimize ${metric}" is nonsensical`, {
          reason: "direction_metric_mismatch",
          objective_index: i,
        });
      }
    } else if (direction === "maximize" && family !== "occurrence") {
      // cost/latency/throughput: "maximize cost"/"maximize latency" is
      // nonsensical; throughput maximize is meaningful, cost/latency are not.
      if (family === "cost" || family === "duration") {
        throw objectivesInvalid(`objective ${i + 1}: "maximize ${metric}" is nonsensical`, {
          reason: "direction_metric_mismatch",
          objective_index: i,
        });
      }
    }

    // Optional target quantification.
    let target: number | undefined;
    if (r.target !== undefined && r.target !== null) {
      target = Number(r.target);
      if (!Number.isFinite(target)) {
        throw objectivesInvalid(`objective ${i + 1}: target must be a finite number`, {
          reason: "invalid_target",
          objective_index: i,
        });
      }
      if (family === "ratio" && (target < 0 || target > 1)) {
        throw objectivesInvalid(`objective ${i + 1}: ratio-metric targets must be within [0, 1]`, {
          reason: "target_out_of_range",
          objective_index: i,
        });
      }
      if (family !== "ratio" && family !== "occurrence" && target <= 0) {
        throw objectivesInvalid(`objective ${i + 1}: ${family}-metric targets must be positive`, {
          reason: "target_out_of_range",
          objective_index: i,
        });
      }
    }

    // Optional unit.
    let unit: OutcomeUnit | undefined;
    if (r.unit !== undefined && r.unit !== null && r.unit !== "") {
      const u = String(r.unit);
      if (!isOutcomeUnit(u)) {
        throw objectivesInvalid(`objective ${i + 1}: unknown unit "${u}"`, {
          reason: "unknown_unit",
          objective_index: i,
        });
      }
      if (!unitAllowedForMetric(metric, u)) {
        throw objectivesInvalid(`objective ${i + 1}: unit "${u}" is not compatible with metric "${metric}"`, {
          reason: "unit_metric_mismatch",
          objective_index: i,
          metric,
          unit: u,
        });
      }
      unit = u;
    }

    // Duplicate objectives rejected — same (direction, metric, kind)
    // triples. A hard target AND a soft preference on the same metric
    // are deliberately ALLOWED (the WORK-008 hard/preference composite
    // precedent); two identical entries are noise.
    const key = `${direction}:${metric}:${kind}`;
    if (seen.has(key)) {
      throw objectivesInvalid(`objective ${i + 1}: duplicate objective (${direction} ${metric}, ${kind})`, {
        reason: "duplicate_objective",
        objective_index: i,
      });
    }
    seen.add(key);

    let notes: string | undefined;
    if (typeof r.notes === "string" && r.notes.trim().length > 0) {
      notes = r.notes.trim().slice(0, MAX_NOTES_LEN);
    }

    objectives.push({
      id: `obj_${i + 1}`,
      direction,
      metric,
      kind,
      ...(target !== undefined ? { target } : {}),
      ...(unit !== undefined ? { unit } : {}),
      ...(notes !== undefined ? { notes } : {}),
    });
  }
  return { schema: 1, objectives };
}

function objectivesInvalid(message: string, details: Record<string, unknown>): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "goal.objectives.invalid",
    message,
    retryable: false,
    details,
  });
}
