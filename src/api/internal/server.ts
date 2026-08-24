// /api/internal/server.ts
// Transport-boundary composition. Builds a Hono application wired with the
// error + correlation middleware (WORK-001), the WORK-003 auth middleware,
// the platform demo routes (WORK-001), and the auth + organizations
// routes (WORK-003). Provides a `serve()` helper that runs a Bun HTTP
// server and a `migrate()` method that provisions the auth + org schema.
//
// The API layer is a transport boundary only (architecture §35, lock §8):
// it imports only the PUBLIC interfaces of /platform, /auth, and
// /organizations — never any module's `internal/`.

import { Hono } from "hono";
import {
  createRuntime,
  type Runtime,
  type RuntimeOptions,
  type Database,
} from "@cp/platform";
import { AuthService, migrateAuthSchema } from "@cp/auth";
import {
  OrganizationsService,
  migrateOrganizationsSchema,
} from "@cp/organizations";
import {
  correlationMiddleware,
  errorMiddleware,
  errorHandler,
  type AuthVars,
} from "./middleware.ts";
import { createPlatformRoutes } from "./handlers.ts";
import { createAuthRoutes } from "./handlers-auth.ts";

export interface Api {
  app: Hono<{ Variables: AuthVars }>;
  runtime: Runtime;
  auth: AuthService;
  orgs: OrganizationsService;
  /**
   * Create or update the /auth + /organizations schema on the configured
   * database. Idempotent. Safe to call on every startup. Must be called
   * before auth/org routes will function. Throws on DB failure so
   * misconfiguration is explicit (no silent no-auth fallback).
   */
  migrate(): Promise<void>;
}

export function createApi(
  runtimeOptions: RuntimeOptions = {},
): Api {
  const runtime = createRuntime(runtimeOptions);
  const app = new Hono<{ Variables: AuthVars }>();
  // Hono v4 intercepts thrown errors and routes them to the onError
  // handler — `app.use("*", mw)` with try/catch does NOT catch throws from
  // route handlers/middleware. errorHandler translates AppError failures
  // into structured JSON responses (§31 failure model → HTTP status).
  app.onError(errorHandler());
  app.use("*", errorMiddleware());
  app.use("*", correlationMiddleware(runtime));

  // Construct the /auth and /organizations services from the runtime's
  // database. If the database is the unconfigured sentinel, the services
  // are still constructed (cheap) but their routes will throw
  // PLATFORM_FAILURE on use — the explicit failure mode when no DB is
  // configured. This keeps the transport boundary honest: there is no
  // silent fallback to an in-memory auth store.
  const auth = new AuthService({ db: runtime.db, logger: runtime.logger });
  const orgs = new OrganizationsService({
    db: runtime.db,
    logger: runtime.logger,
  });

  // WORK-001 platform routes (preserved unchanged).
  createPlatformRoutes(runtime, app);
  // WORK-003 auth + organizations routes. createAuthRoutes registers the
  // auth middleware + routes directly on the main app so errors thrown by
  // orgContextMiddleware or the service propagate up through errorMiddleware
  // (registered above) and become structured JSON responses.
  createAuthRoutes({ runtime, auth, orgs }, app);

  // Start the in-process worker so enqueued jobs actually run.
  runtime.queue.start();

  const migrate = async (): Promise<void> => {
    await migrateAuthSchema(runtime.db as Database);
    await migrateOrganizationsSchema(runtime.db as Database);
  };

  return { app, runtime, auth, orgs, migrate };
}

export interface ServeOptions extends RuntimeOptions {
  port: number;
  hostname?: string;
  /** When true, run migrations before serving. */
  autoMigrate?: boolean;
}

export interface ServedApi extends Api {
  port: number;
  stop(): Promise<void>;
}

export function serve(opts: ServeOptions): ServedApi {
  const { port, hostname, autoMigrate = false, ...runtimeOptions } = opts;
  const api = createApi(runtimeOptions);
  // serve() is synchronous; migrations are launched in the background
  // when autoMigrate is requested. The caller may also await
  // api.migrate() explicitly before relying on auth/org routes.
  if (autoMigrate) {
    void api.migrate().catch((err) => {
      api.runtime.logger.error("api: migration failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
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
