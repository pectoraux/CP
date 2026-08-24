// /projects/internal/schema-runner.ts
// Runs the /projects schema statements against the provider-neutral Database
// interface. Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
// EXISTS), so it is safe to run on every startup and in every test.
//
// Each statement is executed individually via `Database.exec()` because the
// underlying `pg` driver does not support multi-statement queries in a single
// network round-trip.

import type { Database } from "@cp/platform";
import { PROJ_SCHEMA_STATEMENTS } from "./schema.ts";

/**
 * Create or update the /projects schema (cp_projects + indexes) on the given
 * database. Safe to call repeatedly. Throws on DB failure so misconfiguration
 * is explicit (no silent no-projects fallback — the /api readiness gate
 * refuses to bind the listener if migrations fail).
 */
export async function migrateProjectsSchema(db: Database): Promise<void> {
  for (const stmt of PROJ_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
