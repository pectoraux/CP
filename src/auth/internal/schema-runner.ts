// /auth/internal/schema-runner.ts
// Runs the /auth schema statements against the provider-neutral Database
// interface. Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
// EXISTS), so it is safe to run on every startup and in every test.
//
// Each statement is executed individually via `Database.exec()` because
// the underlying `pg` driver does not support multi-statement queries in a
// single network round-trip.

import type { Database } from "@cp/platform";
import { AUTH_SCHEMA_STATEMENTS } from "./schema.ts";

/**
 * Create or update the /auth schema (cp_users, cp_api_keys + indexes) on
 * the given database. Safe to call repeatedly.
 */
export async function migrateAuthSchema(db: Database): Promise<void> {
  for (const stmt of AUTH_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
