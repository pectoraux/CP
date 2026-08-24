// Control Plane — runtime entry point.
// Starts the API transport boundary on the configured port. This is the
// modular-monolith API process (architecture §26); workers run in-process
// within the same boundary for v1.
//
// STARTUP/READINESS ORDER (architect review of WORK-003):
//   config -> infrastructure -> migrations -> success? -> bind HTTP listener
//
// `serve({ autoMigrate: true })` is AWAITED. If migrations (or any earlier
// stage) fail, serve() rejects, the HTTP listener is never bound, and this
// process exits non-zero so the supervisor never routes traffic to a
// process that is not ready.

import { serve } from "@cp/api";
import { loadPlatformConfig } from "@cp/platform";

const port = Number(process.env.CP_PORT ?? 3001);
const hostname = process.env.CP_HOST ?? "0.0.0.0";

// Load + validate infrastructure config. In production this throws loudly
// if required config is missing (no silent fallback). In development/test
// it permits unconfigured pieces (sentinel implementations are used).
const config = loadPlatformConfig();

let api;
try {
  // Awaits the full config -> infrastructure -> migrations -> success gate
  // sequence. The HTTP listener is bound ONLY on success.
  api = await serve({
    port,
    hostname,
    config,
    autoMigrate: true,
  });
} catch (err) {
  // Startup failure: migrations (or infrastructure) did not come up. The
  // HTTP listener was never bound, so the process is NOT ready. Exit
  // non-zero so the supervisor does not route traffic here. (serve()
  // already logged the structured error before re-throwing.)
  const message = err instanceof Error ? err.message : String(err);
  console.error(`control-plane: startup failed (no listener bound): ${message}`);
  process.exit(1);
}

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
