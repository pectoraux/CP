// /catalog/internal/schema-runner.ts
// Runs the /catalog schema statements against the provider-neutral
// Database interface. Idempotent, safe on every startup and in tests.
// Must run AFTER the /providers migration (catalog tables FK-reference
// cp_provider_capabilities → cp_providers → cp_capabilities);
// createApi().migrate() orders them correctly.

import type { Database } from "@cp/platform";
import { CATALOG_SCHEMA_STATEMENTS } from "./schema.ts";

export async function migrateCatalogSchema(db: Database): Promise<void> {
  for (const stmt of CATALOG_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
