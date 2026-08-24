// /api/internal/server.ts
// Transport-boundary composition. Builds a Hono application wired with the
// correlation / request-log / error middleware and the platform demo
// routes. Provides a `serve()` helper that runs a Bun HTTP server.
//
// The API layer is a transport boundary only (architecture §35, lock §8):
// it imports only the PUBLIC interface of `/platform` and never reaches
// into any module's `internal/`.

import { Hono } from "hono";
import {
  createRuntime,
  type Runtime,
  type RuntimeOptions,
} from "@cp/platform";
import {
  correlationMiddleware,
  errorMiddleware,
  type ApiContext,
} from "./middleware.ts";
import { createPlatformRoutes } from "./handlers.ts";

export interface Api {
  app: Hono<{ Variables: { requestId: string } }>;
  runtime: Runtime;
}

export function createApi(
  runtimeOptions: RuntimeOptions = {},
): Api {
  const runtime = createRuntime(runtimeOptions);
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use("*", errorMiddleware());
  app.use("*", correlationMiddleware(runtime));
  createPlatformRoutes(runtime, app);
  // Start the worker so enqueued jobs actually run.
  runtime.queue.start();
  return { app, runtime };
}

export interface ServeOptions extends RuntimeOptions {
  port: number;
  hostname?: string;
}

export interface ServedApi extends Api {
  port: number;
  stop(): Promise<void>;
}

export function serve(opts: ServeOptions): ServedApi {
  const { port, hostname, ...runtimeOptions } = opts;
  const api = createApi(runtimeOptions);
  const server = Bun.serve({
    port,
    hostname,
    fetch: api.app.fetch,
  });
  return {
    ...api,
    port: server.port ?? port,
    stop: async () => {
      await api.runtime.queue.stop();
      server.stop(true);
    },
  };
}

export type { ApiContext };
