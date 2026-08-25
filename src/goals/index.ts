// /goals — public interface.
//
// Responsibility (architecture §5, §36; WORK-011 GOAL-001..003): customer
// objectives and outcome definitions. A Goal answers "What does the
// customer want?" — the semantic target future executions and strategies
// are evaluated against.
//
// WORK-011 delivers:
//   - PROJECT-SCOPED goal identities (architecture §5 places customer
//     configuration under Organization → Project)
//   - immutable, versioned goal versions whose objectives are EXPLICIT
//     structured entries — {direction: maximize|minimize, metric,
//     kind: hard|preference, target?, unit?} — never free-form prose,
//     never expression trees; composite objectives are explicit list
//     entries; hard targets and soft preferences are explicitly
//     distinguished (paralleling but NOT coupled to WORK-008)
//   - EXACT outcome-contract references with VERSION INTEGRITY: every
//     goal version names a PUBLISHED and AVAILABLE /outcomes contract
//     version — active or deprecated; draft (still-mutable) and
//     retired (withdrawn) versions are rejected at creation AND
//     re-checked defensively at activation — semantically compatible
//     with its objectives (the same metric/direction measurement
//     space). The exact immutable version reference is the authority
//     (never a content copy): historical goal versions remain
//     interpretable forever, across later contract versions and across
//     the later retirement of the referenced version
//   - the draft → active → deprecated → retired lifecycle with the
//     authoritative at-most-one-active invariant (partial unique index;
//     activation auto-deprecates the previous active version)
//
// NOT implemented (§18, §29): strategy generation, optimization, utility
// scoring, evaluation — goals define what optimization will eventually
// try to improve.
//
// Dependency direction (§27): /goals → @cp/platform, @cp/auth,
// @cp/projects, @cp/outcomes public interfaces ONLY. It never imports
// /policies (a SEPARATE domain: policy = what must be true; goal = what
// outcome we want), /providers, /catalog, /eligibility, or any
// downstream module — enforced by the static architecture check.
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import
// ONLY from this file.

// ---- GoalsService (DB-backed) --------------------------------------------------
export { GoalsService } from "./internal/service.ts";
export type {
  GoalsServiceOptions,
  Goal,
  GoalVersion,
  CreateGoalInput,
  CreateGoalVersionInput,
  UpdateDraftVersionInput,
  TransitionGoalVersionInput,
  ListGoalsOptions,
  GoalPage,
} from "./internal/service.ts";

// ---- Lifecycle -------------------------------------------------------------------
export type { GoalVersionStatus } from "./internal/service.ts";
export {
  GOAL_VERSION_STATUSES,
  GOAL_VERSION_LIFECYCLE,
  isGoalVersionStatus,
} from "./internal/service.ts";

// ---- Objective model (WORK-011 §5-§7, §15) ------------------------------------------
export type {
  GoalObjective,
  ObjectiveDirection,
  ObjectiveKind,
  ObjectivesDocument,
} from "./internal/objectives.ts";
export {
  OBJECTIVE_DIRECTIONS,
  OBJECTIVE_KINDS,
  isObjectiveDirection,
  isObjectiveKind,
  validateObjectives,
  MAX_OBJECTIVES,
} from "./internal/objectives.ts";

// ---- Schema migration ----------------------------------------------------------------
export { GOALS_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateGoalsSchema } from "./internal/schema-runner.ts";

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "goals" as const;
