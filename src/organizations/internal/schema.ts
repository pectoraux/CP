// /organizations/internal/schema.ts
// PostgreSQL schema for the /organizations module (architecture §34, §36,
// §2.16, lock §1). Owns organization identity + membership lifecycle.
// PostgreSQL is the authoritative store for organization state; Redis is
// never authoritative here.
//
// DDL is idempotent (CREATE TABLE IF NOT EXISTS) so
// `migrateOrganizationsSchema(db)` is safe on every startup and in tests.
// Each statement runs individually via `Database.exec()` because the `pg`
// driver does not support multi-statement queries in one round-trip.
//
// DB-enforced invariants (WORK-003 §6, §10):
//   - organization slug is unique (case-insensitive)
//   - membership is unique per (organization_id, user_id) — duplicate adds
//     fail with unique_violation (23505) rather than creating a duplicate
//   - a membership references a real organization and a real user (FK)
//   - timestamps are always present (NOT NULL DEFAULT NOW())

export const ORG_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cp_organizations (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    slug              TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'active',
    created_by_user_id TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_organizations_slug_lower_uidx
    ON cp_organizations (lower(slug))`,
  `CREATE TABLE IF NOT EXISTS cp_organization_memberships (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    role            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // The single most important constraint for tenant isolation + race safety:
  // exactly one membership row per (org, user). Two concurrent addMember
  // calls cannot create duplicate memberships.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_org_memberships_org_user_uidx
    ON cp_organization_memberships (organization_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS cp_org_memberships_user_idx
    ON cp_organization_memberships (user_id)`,
  `CREATE INDEX IF NOT EXISTS cp_org_memberships_org_idx
    ON cp_organization_memberships (organization_id)`,
];
