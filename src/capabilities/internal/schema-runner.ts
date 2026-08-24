// /capabilities/internal/schema-runner.ts
// Runs the /capabilities schema statements against the provider-neutral
// Database interface. Idempotent (CREATE TABLE IF NOT EXISTS /
// CREATE INDEX IF NOT EXISTS), so it is safe to run on every startup and in
// every test.
//
// Each statement is executed individually via `Database.exec()` because the
// underlying `pg` driver does not support multi-statement queries in a single
// network round-trip.

import type { Database } from "@cp/platform";
import { CAP_SCHEMA_STATEMENTS } from "./schema.ts";

/**
 * Create or update the /capabilities schema (cp_capabilities +
 * cp_capability_versions + cp_capability_dependencies + cp_capability_admins
 * + indexes) on the given database. Safe to call repeatedly. Throws on DB
 * failure so misconfiguration is explicit (no silent no-capabilities
 * fallback — the /api readiness gate refuses to bind the listener if this
 * fails).
 */
export async function migrateCapabilitiesSchema(db: Database): Promise<void> {
  for (const stmt of CAP_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
