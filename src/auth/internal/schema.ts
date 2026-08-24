// /auth/internal/schema.ts
// PostgreSQL schema for the /auth module (architecture §36, §34, §2.16,
// §2.17). Owns user identity and API-key/credential tables. PostgreSQL is
// the authoritative control-plane store (architecture §2.3, lock §1);
// Redis is never authoritative for identity.
//
// DDL is idempotent (CREATE TABLE IF NOT EXISTS) so `migrateAuthSchema(db)`
// is safe to run on every startup and in every test. Each statement is run
// individually via `Database.exec()` because the underlying `pg` driver does
// not support multi-statement queries in a single network round-trip.
//
// Invariants enforced by DB constraints (architecture WORK-003 §6, §10):
//   - user emails are unique (case-insensitive)
//   - API key hashes are unique
//   - a key belongs to exactly one user (FK)
//   - timestamps are always present (NOT NULL DEFAULT NOW())

export const AUTH_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cp_users (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Case-insensitive email uniqueness: store canonical lowercase email,
  // enforce uniqueness via a unique index on lower(email). This prevents
  // duplicate accounts that differ only in case.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_users_email_lower_uidx
    ON cp_users (lower(email))`,
  `CREATE TABLE IF NOT EXISTS cp_api_keys (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES cp_users(id),
    name         TEXT,
    key_hash     TEXT NOT NULL UNIQUE,
    scopes       JSONB NOT NULL DEFAULT '[]'::jsonb,
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_api_keys_key_hash_uidx
    ON cp_api_keys (key_hash)`,
  `CREATE INDEX IF NOT EXISTS cp_api_keys_user_id_idx
    ON cp_api_keys (user_id)`,
];
