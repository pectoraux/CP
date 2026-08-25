// /goals/internal/schema-runner.ts
// Runs the /goals schema statements against the provider-neutral
// Database interface. Idempotent. Must run AFTER the /projects AND
// /outcomes migrations (cp_goals → cp_projects; cp_goal_versions →
// cp_outcome_contracts); createApi().migrate() orders them correctly.

import type { Database } from "@cp/platform";
import { GOALS_SCHEMA_STATEMENTS } from "./schema.ts";

export async function migrateGoalsSchema(db: Database): Promise<void> {
  for (const stmt of GOALS_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
