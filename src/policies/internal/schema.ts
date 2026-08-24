// /policies/internal/schema.ts
// PostgreSQL schema for the /policies module (WORK-008, architecture
// §10, §34, §36, lock §1). Owns tenant-scoped policies and their
// immutable, versioned rule sets. PostgreSQL is authoritative; Redis is
// never authoritative here.
//
// Tenancy (architecture §5 + §34: Policies live under Organization →
// Project; "all customer-visible resources are tenant-scoped"):
//   - A policy belongs to exactly ONE project (project_id NOT NULL,
//     FK → cp_projects ON DELETE RESTRICT — the cross-module FK
//     precedent established by cp_provider_capabilities →
//     cp_capabilities).
//   - Project-scoped ONLY: the frozen architecture places Policies under
//     Project in both §5 and §34; organization-scoped policies are not
//     in the frozen model.
//   - Tenant authorization is enforced server-side by the service
//     (active membership via /auth's activeMembershipIn + admin/owner
//     role for mutations — the WORK-004 projects precedent) and by the
//     /api org/project context middlewares.
//
// DDL is idempotent (CREATE TABLE IF NOT EXISTS) so
// migratePoliciesSchema(db) is safe on every startup and in tests. Each
// statement runs individually via Database.exec() (the pg driver does
// not support multi-statement round-trips).
//
// DB-enforced invariants (WORK-008 §17-§18):
//   - policy identity is unique within its project scope
//     ((project_id, lower(name)) — race-safe under concurrent creates)
//   - a policy version is uniquely identified by (policy_id, version)
//   - AT MOST ONE ACTIVE version per policy — a partial unique index
//     (the WORK-005 cp_capability_versions precedent): the effective
//     version is explicit and deterministic, never "ORDER BY version
//     DESC" (a higher version may be draft or retired)
//   - version lifecycle status is constrained to draft|active|
//     deprecated|retired
//   - version strings are positive integers
//   - policy rows reference real projects (FK); versions reference real
//     policies (FK RESTRICT — a version cannot outlive its policy)

export const POLICY_SCHEMA_STATEMENTS: readonly string[] = [
  // ---- Policy identity (project-scoped) ---------------------------------
  `CREATE TABLE IF NOT EXISTS cp_policies (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    created_by_user_id  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_policies_project_fk
      FOREIGN KEY (project_id) REFERENCES cp_projects(id) ON DELETE RESTRICT
  )`,
  // Policy name is unique within its project (case-insensitive). The
  // composite index is the race-safe constraint: two concurrent creates
  // with the same name in the same project cannot both succeed.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_policies_project_name_lower_uidx
    ON cp_policies (project_id, lower(name))`,
  // Lookup by project for list/pagination.
  `CREATE INDEX IF NOT EXISTS cp_policies_project_created_idx
    ON cp_policies (project_id, created_at DESC, id DESC)`,

  // ---- Policy versions (immutable once published) ------------------------
  // `rules` is the validated RulesDocument (schema-versioned JSONB):
  // a flat list of constrained declarative rules — no executable
  // content can be persisted (validation rejects anything outside the
  // closed subject/operator vocabulary before insert).
  // A DRAFT version's rules may be replaced (it has never been
  // published); once a version leaves draft (active/deprecated/retired)
  // the service exposes NO path that mutates its rules — historical
  // evaluations remain interpretable against the version that actually
  // existed at the time (WORK-008 §5).
  `CREATE TABLE IF NOT EXISTS cp_policy_versions (
    id                  TEXT PRIMARY KEY,
    policy_id           TEXT NOT NULL,
    version             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'draft',
    rules               JSONB NOT NULL,
    created_by_user_id  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_policy_versions_policy_fk
      FOREIGN KEY (policy_id) REFERENCES cp_policies(id) ON DELETE RESTRICT,
    CONSTRAINT cp_policy_versions_status_chk
      CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
    CONSTRAINT cp_policy_versions_version_chk
      CHECK (version ~ '^[0-9]+$')
  )`,
  // Immutable version identity: one row per (policy, version).
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_policy_versions_policy_version_uidx
    ON cp_policy_versions (policy_id, version)`,
  // AT MOST ONE ACTIVE version per policy — the authoritative
  // "effective version" invariant (WORK-008 §18). Race-safe under
  // concurrent activations; the service deprecates the previous active
  // version within the activation transaction.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_policy_versions_active_uidx
    ON cp_policy_versions (policy_id) WHERE status = 'active'`,
  // Version listing, newest-first.
  `CREATE INDEX IF NOT EXISTS cp_policy_versions_policy_created_idx
    ON cp_policy_versions (policy_id, created_at DESC, id DESC)`,
];
