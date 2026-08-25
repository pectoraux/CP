// /outcomes/internal/schema-runner.ts
// Runs the /outcomes schema statements against the provider-neutral
// Database interface. Idempotent. Must run AFTER the /projects migration
// (cp_outcome_contracts references cp_projects); createApi().migrate()
// orders them correctly.

import type { Database } from "@cp/platform";
import { OUTCOMES_SCHEMA_STATEMENTS } from "./schema.ts";

export async function migrateOutcomesSchema(db: Database): Promise<void> {
  for (const stmt of OUTCOMES_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
