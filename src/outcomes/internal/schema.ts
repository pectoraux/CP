// /outcomes/internal/schema.ts
// PostgreSQL schema for the /outcomes module (WORK-011, architecture §15,
// §36, lock §1). Owns the versioned, immutable outcome CONTRACTS — the
// machine-readable measurement definitions that goal versions reference
// and that WORK-015/016 will eventually consume. (Outcome RECORDS —
// actual observed results — belong to later work; this module's frozen
// §36 responsibility for "business and technical outcome records" begins
// with their measurement contracts.)
//
// Tenancy: PROJECT-scoped (architecture §5 places Outcomes under Project;
// WORK-011 §3). Contract identity is reusable within a project — multiple
// goals may reference the same measurement definition instead of
// duplicating it (§14).
//
// Versioning/lifecycle (the WORK-005/008 precedents):
//   - unique (contract_id, version)
//   - AT MOST ONE ACTIVE version per contract (partial unique index —
//     the authoritative active version; never ORDER BY version DESC)
//   - status draft|active|deprecated|retired; published versions are
//     IMMUTABLE (the service rejects modification; drafts replaceable)
//   - the contract content is the validated, schema-versioned
//     OutcomeContractDocument JSONB
//
// Migration order: AFTER projects (the FK chain).

export const OUTCOMES_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cp_outcome_contracts (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    created_by_user_id  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_outcome_contracts_project_fk
      FOREIGN KEY (project_id) REFERENCES cp_projects(id) ON DELETE RESTRICT
  )`,
  // Contract name is unique within its project (case-insensitive, race-safe).
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_outcome_contracts_project_name_uidx
    ON cp_outcome_contracts (project_id, lower(name))`,
  // Listing by project.
  `CREATE INDEX IF NOT EXISTS cp_outcome_contracts_project_created_idx
    ON cp_outcome_contracts (project_id, created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS cp_outcome_contract_versions (
    id                  TEXT PRIMARY KEY,
    contract_id         TEXT NOT NULL,
    version             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'draft',
    content             JSONB NOT NULL,
    created_by_user_id  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_outcome_contract_versions_contract_fk
      FOREIGN KEY (contract_id) REFERENCES cp_outcome_contracts(id) ON DELETE RESTRICT,
    CONSTRAINT cp_outcome_contract_versions_status_chk
      CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
    CONSTRAINT cp_outcome_contract_versions_version_chk
      CHECK (version ~ '^[0-9]+$')
  )`,
  // Immutable version identity.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_outcome_contract_versions_contract_version_uidx
    ON cp_outcome_contract_versions (contract_id, version)`,
  // AT MOST ONE ACTIVE version per contract — the authoritative
  // active-version invariant (race-safe under concurrent activation).
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_outcome_contract_versions_active_uidx
    ON cp_outcome_contract_versions (contract_id) WHERE status = 'active'`,
  // Version listing, newest-first.
  `CREATE INDEX IF NOT EXISTS cp_outcome_contract_versions_contract_created_idx
    ON cp_outcome_contract_versions (contract_id, created_at DESC, id DESC)`,
];
