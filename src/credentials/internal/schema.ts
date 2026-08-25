// /credentials/internal/schema.ts
// PostgreSQL schema for the /credentials module (WORK-010, architecture
// §2.17, §30, §36, lock §10). Owns tenant-scoped CREDENTIAL METADATA —
// never secret material (which lives encrypted in the platform
// ObjectStorage boundary behind this module).
//
// Tenancy: credentials are PROJECT-scoped (frozen §34: Organization →
// Project → Connections/credentials; lock §10 "connections and
// credentials are scoped to tenants/projects"). There is no
// organization_id column — the project determines the tenant; callers
// (the /connections layer and the /api org/project gates) resolve the
// authorized (organization, project) pair through the /projects public
// interface BEFORE any credential operation.
//
// DB-enforced invariants:
//   - a credential belongs to exactly one project (FK → cp_projects,
//     ON DELETE RESTRICT — a credential cannot outlive its project)
//   - credential name is unique within a project (operator-facing stable
//     identity; race-safe under concurrent creates)
//   - kind is constrained to the WORK-006 credential-kind vocabulary
//   - status is constrained to active|revoked (revocation is a state, not
//     a deletion — the metadata row remains for audit while the secret
//     blob is deleted)
//   - current_version counts stored secret versions (0 = none stored);
//     the physical blob for each version lives in object storage at
//     credentials/{id}/v{n} — the key is derived from the id, never a
//     secret-derived value
//
// NOTE: this migration must run AFTER the /projects migration (FK).

export const CREDENTIALS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cp_credentials (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    kind                TEXT NOT NULL,
    name                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',
    current_version     INTEGER NOT NULL DEFAULT 0,
    created_by_user_id  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_credentials_project_fk
      FOREIGN KEY (project_id) REFERENCES cp_projects(id) ON DELETE RESTRICT,
    CONSTRAINT cp_credentials_kind_chk
      CHECK (kind IN ('api_key', 'bearer_token', 'basic_username_password',
                      'hmac_secret', 'oauth_client_credentials')),
    CONSTRAINT cp_credentials_status_chk
      CHECK (status IN ('active', 'revoked')),
    CONSTRAINT cp_credentials_version_chk
      CHECK (current_version >= 0)
  )`,
  // Stable operator-facing identity within a project (race-safe).
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_credentials_project_name_uidx
    ON cp_credentials (project_id, lower(name))`,
  // Listing by project.
  `CREATE INDEX IF NOT EXISTS cp_credentials_project_created_idx
    ON cp_credentials (project_id, created_at DESC, id DESC)`,
];
