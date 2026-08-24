// /providers/internal/schema-runner.ts
// Runs the /providers schema statements against the provider-neutral
// Database interface. Idempotent (CREATE TABLE IF NOT EXISTS /
// CREATE INDEX IF NOT EXISTS), safe on every startup and in tests.
//
// Each statement is executed individually via Database.exec() because the
// pg driver does not support multi-statement round-trips.
//
// NOTE: cp_provider_capabilities references cp_capabilities (cross-module
// FK, same precedent as cp_projects → cp_organizations), so the
// /capabilities migration must run BEFORE this one. createApi().migrate()
// orders them correctly.

import type { Database } from "@cp/platform";
import { PROVIDER_SCHEMA_STATEMENTS } from "./schema.ts";

/**
 * Create the /providers schema (cp_providers +
 * cp_provider_capabilities + cp_provider_certification_evidence + indexes)
 * on the given database. Safe to call repeatedly. Throws on DB failure so
 * misconfiguration is explicit (the /api readiness gate refuses to bind
 * the listener if this fails).
 */
export async function migrateProvidersSchema(db: Database): Promise<void> {
  for (const stmt of PROVIDER_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
