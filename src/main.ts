// Control Plane — runtime entry point.
// Starts the API transport boundary on the configured port. This is the
// modular-monolith API process (architecture §26); workers run in-process
// within the same boundary for v1.

import { serve } from "@cp/api";

const port = Number(process.env.CP_PORT ?? 3001);
const hostname = process.env.CP_HOST ?? "0.0.0.0";

const api = serve({ port, hostname });
api.runtime.logger.info("control-plane: api started", {
  port: api.port,
  host: hostname,
});

// Graceful shutdown.
const shutdown = async (signal: string) => {
  api.runtime.logger.info("control-plane: shutting down", { signal });
  await api.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
