// /credentials/internal/schema-runner.ts
// Runs the /credentials schema statements against the provider-neutral
// Database interface. Idempotent. Must run AFTER the /projects migration
// (cp_credentials references cp_projects); createApi().migrate() orders
// them correctly.

import type { Database } from "@cp/platform";
import { CREDENTIALS_SCHEMA_STATEMENTS } from "./schema.ts";

export async function migrateCredentialsSchema(db: Database): Promise<void> {
  for (const stmt of CREDENTIALS_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
