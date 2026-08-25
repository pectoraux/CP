// /goals/internal/schema.ts
// PostgreSQL schema for the /goals module (WORK-011, architecture §5,
// §36; frozen GOAL-001..003). Owns the customer objective layer: goal
// identities, their immutable versioned objective sets, and the exact
// outcome-contract references each version measures against.
//
// Model (§4, §14):
//   Goal (project-scoped identity)
//     └── GoalVersion (immutable once published)
//           ├── objectives: the validated ObjectivesDocument JSONB —
//           │   explicit entries {direction, metric, kind: hard|preference,
//           │   target?, unit?} (never free-form prose, never trees)
//           └── outcome_contract_id + outcome_contract_version: an EXACT
//               immutable measurement definition owned by /outcomes
//
// Tenancy: PROJECT-scoped (architecture §5; WORK-011 §3).
//
// Versioning/lifecycle (the WORK-005/008 precedents):
//   - unique (goal_id, version)
//   - AT MOST ONE ACTIVE version per goal (partial unique index — the
//     authoritative active version; never ORDER BY version DESC)
//   - status draft|active|deprecated|retired; published versions are
//     IMMUTABLE; drafts replaceable
//
// Migration order: AFTER projects AND outcomes (the FK/version-reference
// chain).

export const GOALS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cp_goals (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    created_by_user_id  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_goals_project_fk
      FOREIGN KEY (project_id) REFERENCES cp_projects(id) ON DELETE RESTRICT
  )`,
  // Goal name is unique within its project (case-insensitive, race-safe).
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_goals_project_name_uidx
    ON cp_goals (project_id, lower(name))`,
  // Listing by project.
  `CREATE INDEX IF NOT EXISTS cp_goals_project_created_idx
    ON cp_goals (project_id, created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS cp_goal_versions (
    id                          TEXT PRIMARY KEY,
    goal_id                     TEXT NOT NULL,
    version                     TEXT NOT NULL,
    status                      TEXT NOT NULL DEFAULT 'draft',
    objectives                  JSONB NOT NULL,
    outcome_contract_id         TEXT NOT NULL,
    outcome_contract_version    TEXT NOT NULL,
    created_by_user_id          TEXT NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_goal_versions_goal_fk
      FOREIGN KEY (goal_id) REFERENCES cp_goals(id) ON DELETE RESTRICT,
    CONSTRAINT cp_goal_versions_outcome_contract_fk
      FOREIGN KEY (outcome_contract_id) REFERENCES cp_outcome_contracts(id) ON DELETE RESTRICT,
    CONSTRAINT cp_goal_versions_status_chk
      CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
    CONSTRAINT cp_goal_versions_version_chk
      CHECK (version ~ '^[0-9]+$'),
    CONSTRAINT cp_goal_versions_outcome_contract_version_chk
      CHECK (outcome_contract_version ~ '^[0-9]+$')
  )`,
  // Immutable version identity.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_goal_versions_goal_version_uidx
    ON cp_goal_versions (goal_id, version)`,
  // AT MOST ONE ACTIVE version per goal — the authoritative
  // active-version invariant (race-safe under concurrent activation).
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_goal_versions_active_uidx
    ON cp_goal_versions (goal_id) WHERE status = 'active'`,
  // Version listing, newest-first.
  `CREATE INDEX IF NOT EXISTS cp_goal_versions_goal_created_idx
    ON cp_goal_versions (goal_id, created_at DESC, id DESC)`,
  // The exact contract-version reference: one row may exist per
  // (goal version, contract, contract version) — duplicates rejected.
  `CREATE INDEX IF NOT EXISTS cp_goal_versions_contract_ref_idx
    ON cp_goal_versions (outcome_contract_id, outcome_contract_version)`,
];
