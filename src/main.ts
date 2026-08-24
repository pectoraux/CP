// Control Plane — runtime entry point.
// Starts the API transport boundary on the configured port. This is the
// modular-monolith API process (architecture §26); workers run in-process
// within the same boundary for v1.
//
// WORK-003: load the platform config (which wires a real PostgreSQL +
// Redis + object-storage backend when configured) and auto-migrate the
// /auth + /organizations schema on startup so the identity/tenant routes
// are ready to serve.

import { serve } from "@cp/api";
import { loadPlatformConfig } from "@cp/platform";

const port = Number(process.env.CP_PORT ?? 3001);
const hostname = process.env.CP_HOST ?? "0.0.0.0";

// Load + validate infrastructure config. In production this throws loudly
// if required config is missing (no silent fallback). In development/test
// it permits unconfigured pieces (sentinel implementations are used).
const config = loadPlatformConfig();

const api = serve({
  port,
  hostname,
  config,
  autoMigrate: true,
});
api.runtime.logger.info("control-plane: api started", {
  port: api.port,
  host: hostname,
  mode: config.mode,
  database: config.database ? "configured" : "unconfigured",
  redis: config.redis ? "configured" : "unconfigured",
  storage: config.storage ? "configured" : "unconfigured",
});

// Graceful shutdown.
const shutdown = async (signal: string) => {
  api.runtime.logger.info("control-plane: shutting down", { signal });
  await api.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
