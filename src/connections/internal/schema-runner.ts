// /connections/internal/schema-runner.ts
// Runs the /connections schema statements against the provider-neutral
// Database interface. Idempotent. Must run AFTER the /projects,
// /providers, /capabilities, AND /credentials migrations (the FK chain);
// createApi().migrate() orders them correctly.

import type { Database } from "@cp/platform";
import { CONNECTIONS_SCHEMA_STATEMENTS } from "./schema.ts";

export async function migrateConnectionsSchema(db: Database): Promise<void> {
  for (const stmt of CONNECTIONS_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}
