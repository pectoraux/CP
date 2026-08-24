// /policies/internal/schema-runner.ts
// Runs the /policies schema statements against the provider-neutral
// Database interface. Idempotent (CREATE TABLE IF NOT EXISTS /
// CREATE INDEX IF NOT EXISTS), safe on every startup and in tests.
//
// NOTE: cp_policies references cp_projects (cross-module FK, same
// precedent as cp_provider_capabilities → cp_capabilities), so the
// /projects migration must run BEFORE this one. createApi().migrate()
// orders them correctly.

import type { Database } from "@cp/platform";
import { POLICY_SCHEMA_STATEMENTS } from "./schema.ts";

/**
 * Create the /policies schema (cp_policies + cp_policy_versions +
 * indexes) on the given database. Safe to call repeatedly. Throws on DB
 * failure so misconfiguration is explicit (the /api readiness gate
 * refuses to bind the listener if this fails).
 */
export async function migratePoliciesSchema(db: Database): Promise<void> {
  for (const stmt of POLICY_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
