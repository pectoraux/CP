// /outcomes/internal/contract.ts
// The constrained, declarative outcome-contract definition vocabulary
// (WORK-011, architecture §15, §36; frozen GOAL-001..003 + OUT-001).
//
// An Outcome Contract describes HOW success/failure relative to a goal
// will be measured — the machine-readable measurement semantics that
// WORK-015/016 will later consume:
//
//     metric + unit + direction + aggregation + threshold
//     + evaluation window + measurement source + required flag
//
// The vocabulary is CLOSED and switch-validated — there is NO eval(),
// NO SQL, NO JavaScript, NO arbitrary scripts, NO remote callbacks
// (WORK-011 §9). A metric describes WHAT measurement is expected, never
// HOW to execute arbitrary computation. Anything outside the vocabulary
// is rejected BEFORE persistence (§24).

import { AppError } from "@cp/platform";

// ---- Metric vocabulary (§10 — intentionally constrained initial set) ------

export type OutcomeMetric =
  | "cost"
  | "latency"
  | "success_rate"
  | "availability"
  | "error_rate"
  | "throughput"
  | "business_success";

export const OUTCOME_METRICS: readonly OutcomeMetric[] = [
  "cost",
  "latency",
  "success_rate",
  "availability",
  "error_rate",
  "throughput",
  "business_success",
] as const;

export function isOutcomeMetric(v: string): v is OutcomeMetric {
  return (OUTCOME_METRICS as readonly string[]).includes(v);
}

/**
 * Metric families drive unit/threshold compatibility:
 *   ratio       — success_rate, availability, error_rate (0..1)
 *   duration    — latency (ms)
 *   rate        — throughput (events per time unit)
 *   cost        — cost (currency per unit)
 *   occurrence  — business_success (a definable occurrence outcome)
 */
export type MetricFamily = "ratio" | "duration" | "rate" | "cost" | "occurrence";

const METRIC_FAMILIES: Readonly<Record<OutcomeMetric, MetricFamily>> = {
  cost: "cost",
  latency: "duration",
  success_rate: "ratio",
  availability: "ratio",
  error_rate: "ratio",
  throughput: "rate",
  business_success: "occurrence",
};

export function metricFamily(metric: OutcomeMetric): MetricFamily {
  return METRIC_FAMILIES[metric];
}

// ---- Units (constrained per family) ------------------------------------------

export type OutcomeUnit =
  | "ratio"
  | "ms"
  | "s"
  | "per_second"
  | "per_minute"
  | "per_hour"
  | "per_request"
  | "count"
  | "currency:USD"
  | "currency:EUR"
  | "currency:GHS"
  | "currency:NGN"
  | "currency:KES"
  | "currency:GBP";

export const OUTCOME_UNITS: readonly OutcomeUnit[] = [
  "ratio",
  "ms",
  "s",
  "per_second",
  "per_minute",
  "per_hour",
  "per_request",
  "count",
  "currency:USD",
  "currency:EUR",
  "currency:GHS",
  "currency:NGN",
  "currency:KES",
  "currency:GBP",
] as const;

export function isOutcomeUnit(v: string): v is OutcomeUnit {
  return (OUTCOME_UNITS as readonly string[]).includes(v);
}

/** Which units are legal for a metric family. */
const FAMILY_UNITS: Readonly<Record<MetricFamily, readonly OutcomeUnit[]>> = {
  ratio: ["ratio"],
  duration: ["ms", "s"],
  rate: ["per_second", "per_minute", "per_hour"],
  cost: ["currency:USD", "currency:EUR", "currency:GHS", "currency:NGN", "currency:KES", "currency:GBP", "per_request"],
  occurrence: ["count", "ratio"],
};

export function unitAllowedForMetric(metric: OutcomeMetric, unit: OutcomeUnit): boolean {
  return FAMILY_UNITS[METRIC_FAMILIES[metric]]!.includes(unit);
}

// ---- Direction / aggregation ---------------------------------------------------

export type OutcomeDirection = "maximize" | "minimize";

export const OUTCOME_DIRECTIONS: readonly OutcomeDirection[] = ["maximize", "minimize"] as const;

export function isOutcomeDirection(v: string): v is OutcomeDirection {
  return v === "maximize" || v === "minimize";
}

export type OutcomeAggregation =
  | "mean"
  | "median"
  | "p95"
  | "p99"
  | "max"
  | "min"
  | "sum"
  | "count";

export const OUTCOME_AGGREGATIONS: readonly OutcomeAggregation[] = [
  "mean",
  "median",
  "p95",
  "p99",
  "max",
  "min",
  "sum",
  "count",
] as const;

export function isOutcomeAggregation(v: string): v is OutcomeAggregation {
  return (OUTCOME_AGGREGATIONS as readonly string[]).includes(v);
}

// ---- Measurement source (§16 — the WORK-015 ingestion boundary) ------------------

export type MeasurementSource = "execution_observation";

export const MEASUREMENT_SOURCES: readonly MeasurementSource[] = ["execution_observation"] as const;

export function isMeasurementSource(v: string): v is MeasurementSource {
  return v === "execution_observation";
}

// ---- The contract document --------------------------------------------------------

/**
 * The persisted, versioned contract content (schema-versioned JSONB).
 * Deterministic, serializable, versionable, explainable, safe.
 */
export interface OutcomeContractDocument {
  schema: 1;
  metric: OutcomeMetric;
  unit: OutcomeUnit;
  direction: OutcomeDirection;
  aggregation: OutcomeAggregation;
  /** The threshold the measurement is evaluated against (e.g. 0.99 for
   *  success_rate >= 0.99, or 0.02 for cost <= 0.02). */
  threshold: number;
  /** Evaluation window in seconds (> 0). */
  windowSeconds: number;
  /** Where the measurement will come from (WORK-015's pipeline). */
  measurementSource: MeasurementSource;
  /** Whether the contract's satisfaction is required (vs advisory). */
  required: boolean;
  /** Free-text description of what business result this measures
   *  (bounded; explains intent to operators — §25). */
  description: string;
}

// ---- Validation ---------------------------------------------------------------------

export const MAX_CONTRACT_DESCRIPTION = 1000;
export const MAX_WINDOW_SECONDS = 366 * 24 * 3600; // one year

/**
 * Validate and normalize caller-supplied contract content. Rejects:
 * unknown metric/unit/direction/aggregation/source, family-incompatible
 * units, non-finite or family-incompatible thresholds (ratio must be
 * 0..1; non-positive latency/throughput/cost), impossible windows,
 * oversized descriptions. Returns the persisted document.
 */
export function validateOutcomeContractDocument(input: unknown): OutcomeContractDocument {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw contractInvalid("the outcome contract must be an object", { reason: "invalid_shape" });
  }
  const raw = input as Record<string, unknown>;

  const metric = String(raw.metric ?? "");
  if (!isOutcomeMetric(metric)) {
    throw contractInvalid(`metric must be one of ${OUTCOME_METRICS.join("|")} (got "${metric}")`, {
      reason: "unknown_metric",
      allowed_metrics: OUTCOME_METRICS,
    });
  }
  const unit = String(raw.unit ?? "");
  if (!isOutcomeUnit(unit)) {
    throw contractInvalid(`unit must be one of ${OUTCOME_UNITS.join("|")} (got "${unit}")`, {
      reason: "unknown_unit",
      allowed_units: OUTCOME_UNITS,
    });
  }
  if (!unitAllowedForMetric(metric, unit)) {
    throw contractInvalid(`unit "${unit}" is not compatible with metric "${metric}" (family ${metricFamily(metric)})`, {
      reason: "unit_metric_mismatch",
      metric,
      unit,
    });
  }
  const direction = String(raw.direction ?? "");
  if (!isOutcomeDirection(direction)) {
    throw contractInvalid(`direction must be maximize or minimize (got "${direction}")`, {
      reason: "invalid_direction",
    });
  }
  const aggregation = String(raw.aggregation ?? "");
  if (!isOutcomeAggregation(aggregation)) {
    throw contractInvalid(`aggregation must be one of ${OUTCOME_AGGREGATIONS.join("|")} (got "${aggregation}")`, {
      reason: "invalid_aggregation",
    });
  }
  const measurementSource = String(raw.measurement_source ?? "execution_observation");
  if (!isMeasurementSource(measurementSource)) {
    throw contractInvalid(`measurement_source must be one of ${MEASUREMENT_SOURCES.join("|")} (got "${measurementSource}")`, {
      reason: "invalid_measurement_source",
    });
  }

  const threshold = Number(raw.threshold);
  if (!Number.isFinite(threshold)) {
    throw contractInvalid("threshold must be a finite number", { reason: "invalid_threshold" });
  }
  const family = metricFamily(metric);
  if (family === "ratio" && (threshold < 0 || threshold > 1)) {
    throw contractInvalid("ratio-metric thresholds must be within [0, 1]", {
      reason: "threshold_out_of_range",
      metric,
      threshold,
    });
  }
  if (family !== "ratio" && family !== "occurrence" && threshold <= 0) {
    throw contractInvalid(`threshold for ${family} metrics must be positive`, {
      reason: "threshold_out_of_range",
      metric,
      threshold,
    });
  }

  const windowSeconds = Number(raw.window_seconds);
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0 || windowSeconds > MAX_WINDOW_SECONDS) {
    throw contractInvalid(`window_seconds must be a positive integer <= ${MAX_WINDOW_SECONDS}`, {
      reason: "invalid_window",
    });
  }

  const requiredRaw = raw.required;
  const required = requiredRaw === undefined ? true : requiredRaw;
  if (typeof required !== "boolean") {
    throw contractInvalid("required must be a boolean", { reason: "invalid_required" });
  }

  const description =
    typeof raw.description === "string" ? raw.description.trim().slice(0, MAX_CONTRACT_DESCRIPTION) : "";

  return {
    schema: 1,
    metric,
    unit,
    direction,
    aggregation,
    threshold,
    windowSeconds,
    measurementSource,
    required,
    description,
  };
}

function contractInvalid(message: string, details: Record<string, unknown>): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "outcome.validation",
    message,
    retryable: false,
    details,
  });
}
