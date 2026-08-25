// /connections/internal/schema.ts
// PostgreSQL schema for the /connections module (WORK-010, architecture
// §34, §36, lock §10). Owns the tenant-scoped connection layer:
// "this organization/project is configured to use provider X."
//
// Layer separation (WORK-010 §2, §16): a Connection references a GLOBAL
// provider (and optionally a specific capability+version) and a
// tenant-scoped credential — it never duplicates provider identity,
// never copies provider-capability declarations, and NEVER stores secret
// material (the credential reference points at /credentials).
//
// Tenancy: PROJECT-scoped (frozen §34: Organization → Project →
// Connections; lock §10). Project existence/ownership is resolved via
// the /projects public interface by the service; the FK keeps
// referential integrity (RESTRICT — a connection cannot outlive its
// project).
//
// Lifecycle (WORK-010 §4): draft → active → paused → revoked (revoked
// terminal; draft → revoked allowed). Activation is gated by the SERVICE
// on a prior successful structural verification — a connection never
// becomes active merely because it exists. `last_verified_at` +
// `verification_result` record the verification evidence.
//
// Multiple connections per provider per project are allowed (production/
// sandbox/regional accounts — §14), distinguished by a stable
// environment label: UNIQUE (project_id, provider_id, environment) —
// exact duplicates are rejected race-safely; no default-connection
// uniqueness is invented (§15 — the frozen architecture does not
// require one).
//
// DDL is idempotent. Migration order: AFTER projects, providers,
// capabilities, AND credentials (the FK chain).

export const CONNECTIONS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cp_connections (
    id                         TEXT PRIMARY KEY,
    project_id                 TEXT NOT NULL,
    provider_id                TEXT NOT NULL,
    provider_canonical_id      TEXT NOT NULL,
    capability_id              TEXT,
    capability_canonical_id    TEXT,
    capability_version         TEXT,
    environment                TEXT NOT NULL DEFAULT 'default',
    label                      TEXT NOT NULL DEFAULT '',
    configuration              JSONB NOT NULL DEFAULT '{}'::jsonb,
    credential_id              TEXT,
    status                     TEXT NOT NULL DEFAULT 'draft',
    last_verified_at           TIMESTAMPTZ,
    verification_result        JSONB,
    created_by_user_id         TEXT NOT NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_connections_project_fk
      FOREIGN KEY (project_id) REFERENCES cp_projects(id) ON DELETE RESTRICT,
    CONSTRAINT cp_connections_provider_fk
      FOREIGN KEY (provider_id) REFERENCES cp_providers(id) ON DELETE RESTRICT,
    CONSTRAINT cp_connections_capability_fk
      FOREIGN KEY (capability_id) REFERENCES cp_capabilities(id) ON DELETE RESTRICT,
    CONSTRAINT cp_connections_credential_fk
      FOREIGN KEY (credential_id) REFERENCES cp_credentials(id) ON DELETE RESTRICT,
    CONSTRAINT cp_connections_status_chk
      CHECK (status IN ('draft', 'active', 'paused', 'revoked')),
    CONSTRAINT cp_connections_capability_pair_chk
      CHECK (
        (capability_id IS NULL AND capability_canonical_id IS NULL AND capability_version IS NULL)
        OR (capability_id IS NOT NULL AND capability_canonical_id IS NOT NULL AND capability_version IS NOT NULL)
      ),
    CONSTRAINT cp_connections_environment_chk
      CHECK (environment ~ '^[a-z][a-z0-9-]{0,62}$'),
    CONSTRAINT cp_connections_capability_version_chk
      CHECK (capability_version IS NULL OR capability_version ~ '^[0-9]+$')
  )`,
  // Stable identity per (project, provider, environment): the sandbox vs
  // production accounts are distinct connections; exact duplicates are
  // rejected race-safely (§14).
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_connections_scope_uidx
    ON cp_connections (project_id, provider_id, environment)`,
  // Listing by project.
  `CREATE INDEX IF NOT EXISTS cp_connections_project_created_idx
    ON cp_connections (project_id, created_at DESC, id DESC)`,
  // Credential usage lookup (which connections use a credential).
  `CREATE INDEX IF NOT EXISTS cp_connections_credential_idx
    ON cp_connections (credential_id)`,
];
