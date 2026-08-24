// /projects/internal/schema.ts
// PostgreSQL schema for the /projects module (architecture §34, §36, §2.16,
// lock §1, §10). Owns project identity under an organization. PostgreSQL is
// the authoritative store for project state; Redis is never authoritative
// here.
//
// DDL is idempotent (CREATE TABLE IF NOT EXISTS) so
// `migrateProjectsSchema(db)` is safe on every startup and in tests. Each
// statement runs individually via `Database.exec()` because the `pg` driver
// does not support multi-statement queries in one round-trip.
//
// DB-enforced invariants (WORK-004):
//   - a project belongs to exactly one organization (organization_id NOT NULL)
//   - project slug is unique within an organization (case-insensitive),
//     scoped by (organization_id, lower(slug)) — two orgs may each have a
//     project named "default", but within one org the slug is unique
//   - a project row references a real organization (FK → cp_organizations)
//   - timestamps are always present (NOT NULL DEFAULT NOW())
//
// The (organization_id, lower(slug)) uniqueness is the race-safe constraint:
// two concurrent createProject calls with the same slug in the same org
// cannot both succeed.

export const PROJ_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cp_projects (
    id                  TEXT PRIMARY KEY,
    organization_id     TEXT NOT NULL,
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',
    created_by_user_id  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_projects_org_fk
      FOREIGN KEY (organization_id) REFERENCES cp_organizations(id) ON DELETE RESTRICT,
    CONSTRAINT cp_projects_status_chk
      CHECK (status IN ('active', 'archived'))
  )`,
  // Unique slug within an organization (case-insensitive). The composite
  // index enforces "no two projects with the same slug in the same org".
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_projects_org_slug_lower_uidx
    ON cp_projects (organization_id, lower(slug))`,
  // Lookup by organization for list/pagination.
  `CREATE INDEX IF NOT EXISTS cp_projects_org_created_idx
    ON cp_projects (organization_id, created_at DESC, id DESC)`,
  // Lookup by id (the project-level tenant-scoping query filters by both
  // id AND organization_id so a cross-org project id substitution cannot
  // leak a row that belongs to a different org).
  `CREATE INDEX IF NOT EXISTS cp_projects_id_org_idx
    ON cp_projects (id, organization_id)`,
];
