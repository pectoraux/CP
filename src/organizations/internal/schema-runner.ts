// /organizations/internal/schema-runner.ts
// Runs the /organizations schema statements against the provider-neutral
// Database interface. Idempotent, safe on every startup and in every test.

import type { Database } from "@cp/platform";
import { ORG_SCHEMA_STATEMENTS } from "./schema.ts";

/**
 * Create or update the /organizations schema (cp_organizations,
 * cp_organization_memberships + indexes) on the given database. Safe to
 * call repeatedly.
 */
export async function migrateOrganizationsSchema(db: Database): Promise<void> {
  for (const stmt of ORG_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
