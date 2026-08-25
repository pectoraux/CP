// /outcomes — public interface.
//
// Responsibility (architecture §15, §36; lock §1; WORK-011 GOAL-001..003 +
// OUT-001): business and technical outcome records — beginning with the
// versioned, immutable OUTCOME CONTRACTS: the machine-readable
// measurement definitions (metric/unit/direction/aggregation/threshold/
// window/measurement source) that goal versions reference and that
// WORK-015/016 will later consume.
//
// WORK-011 delivers:
//   - project-scoped, reusable outcome contracts (unique name per
//     project; multiple goals may reference one measurement definition —
//     no accidental duplicates)
//   - versioned contracts with the draft → active → deprecated → retired
//     lifecycle, published-version immutability, and the authoritative
//     at-most-one-active invariant (partial unique index)
//   - a CLOSED, declarative, switch-validated vocabulary — no eval, no
//     SQL, no JavaScript, no scripts, no callbacks (a contract describes
//     WHAT is measured, never HOW to execute computation)
//   - validation BEFORE persistence: unknown metrics/units/directions/
//     aggregations/sources, family-incompatible units and thresholds,
//     impossible windows — all rejected deterministically
//
// NOT implemented (WORK-011 §28): outcome records, observation/execution
// ingestion, outcome calculation — the contract DEFINES measurement
// semantics.
//
// Dependency direction (§27): /outcomes → @cp/platform, @cp/auth,
// @cp/projects public interfaces ONLY. It never imports /policies,
// /providers, /catalog, /eligibility, /goals, or any downstream module —
// enforced by the static architecture check.
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import
// ONLY from this file.

// ---- OutcomesService (DB-backed contracts) ---------------------------------
export { OutcomesService } from "./internal/service.ts";
export type {
  OutcomeContractServiceOptions,
  OutcomeContract,
  OutcomeContractVersion,
  CreateOutcomeContractInput,
  UpdateDraftContentInput,
  TransitionContractVersionInput,
  ListOutcomeContractsOptions,
  OutcomeContractPage,
} from "./internal/service.ts";

// ---- Lifecycle -----------------------------------------------------------------
export type { OutcomeContractStatus } from "./internal/service.ts";
export {
  OUTCOME_CONTRACT_STATUSES,
  OUTCOME_CONTRACT_LIFECYCLE,
  isOutcomeContractStatus,
} from "./internal/service.ts";

// ---- Contract vocabulary (architecture §15; WORK-011 §8-§10) --------------------
export type {
  OutcomeMetric,
  MetricFamily,
  OutcomeUnit,
  OutcomeDirection,
  OutcomeAggregation,
  MeasurementSource,
  OutcomeContractDocument,
} from "./internal/contract.ts";
export {
  OUTCOME_METRICS,
  OUTCOME_UNITS,
  OUTCOME_DIRECTIONS,
  OUTCOME_AGGREGATIONS,
  MEASUREMENT_SOURCES,
  isOutcomeMetric,
  isOutcomeUnit,
  isOutcomeDirection,
  isOutcomeAggregation,
  isMeasurementSource,
  metricFamily,
  unitAllowedForMetric,
  validateOutcomeContractDocument,
} from "./internal/contract.ts";

// ---- Schema migration -------------------------------------------------------------
export { OUTCOMES_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateOutcomesSchema } from "./internal/schema-runner.ts";

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "outcomes" as const;
