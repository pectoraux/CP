// /api/internal/server.ts
// Transport-boundary composition. Builds a Hono application wired with the
// error + correlation middleware (WORK-001), the WORK-003 auth middleware,
// the platform demo routes (WORK-001), and the auth + organizations
// routes (WORK-003) + project routes (WORK-004). Provides a `serve()`
// helper that runs a Bun HTTP server and a `migrate()` method that
// provisions the auth + org + projects + idempotency schema.
//
// The API layer is a transport boundary only (architecture §35, lock §8):
// it imports only the PUBLIC interfaces of /platform, /auth, /organizations,
// and /projects — never any module's `internal/`.

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
import { ProjectsService, migrateProjectsSchema } from "@cp/projects";
import {
  CapabilitiesService,
  migrateCapabilitiesSchema,
} from "@cp/capabilities";
import {
  correlationMiddleware,
  errorMiddleware,
  errorHandler,
  type AuthVars,
} from "./middleware.ts";
import { createPlatformRoutes } from "./handlers.ts";
import { createAuthRoutes } from "./handlers-auth.ts";
import { createProjectRoutes } from "./handlers-projects.ts";
import { createCapabilityRoutes } from "./handlers-capabilities.ts";
import {
  IdempotencyStore,
  migrateIdempotencySchema,
} from "./idempotency.ts";

export interface Api {
  app: Hono<{ Variables: AuthVars }>;
  runtime: Runtime;
  auth: AuthService;
  orgs: OrganizationsService;
  projects: ProjectsService;
  capabilities: CapabilitiesService;
  idempotency: IdempotencyStore;
  /**
   * Create or update the /auth + /organizations + /projects + capabilities
   * + idempotency schema on the configured database. Idempotent. Safe to
   * call on every startup. Must be called before auth/org/project/
   * capability routes will function. Throws on DB failure so
   * misconfiguration is explicit (no silent no-schema fallback) — the
   * serve() readiness gate refuses to bind the HTTP listener if this fails.
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

  // Construct the /auth, /organizations, /projects services and the
  // idempotency store from the runtime's database. If the database is the
  // unconfigured sentinel, the services are still constructed (cheap) but
  // their routes will throw PLATFORM_FAILURE on use — the explicit failure
  // mode when no DB is configured. There is no silent fallback to an
  // in-memory store.
  const auth = new AuthService({ db: runtime.db, logger: runtime.logger });
  const orgs = new OrganizationsService({
    db: runtime.db,
    logger: runtime.logger,
  });
  const projects = new ProjectsService({
    db: runtime.db,
    logger: runtime.logger,
  });
  const capabilities = new CapabilitiesService({
    db: runtime.db,
    logger: runtime.logger,
  });
  const idempotency = new IdempotencyStore({
    db: runtime.db,
    logger: runtime.logger,
  });

  // WORK-001 platform routes (preserved unchanged).
  createPlatformRoutes(runtime, app);
  // WORK-003 auth + organizations routes. createAuthRoutes registers the
  // auth middleware + routes directly on the main app so errors thrown by
  // orgContextMiddleware or the service propagate up through errorMiddleware
  // (registered above) and become structured JSON responses. The
  // idempotency store is passed so POST /v1/organizations supports
  // Idempotency-Key (WORK-004 API-002).
  createAuthRoutes({ runtime, auth, orgs, idempotency }, app);
  // WORK-004 project routes under /v1/organizations/:orgId/projects. The
  // org-level gate (orgContextMiddleware) runs first; the project-level
  // gate (projectContextMiddleware) runs for :projectId routes.
  createProjectRoutes({ runtime, orgs, projects, idempotency }, app);
  // WORK-005 capability routes under /v1/capabilities. These are GLOBAL
  // (not tenant-scoped): the auth middleware verifies the credential and
  // builds the Principal; mutation routes require the CP-level
  // capability-admin grant (checked inside CapabilitiesService); read
  // routes are authenticated-only.
  createCapabilityRoutes({ runtime, auth, orgs, capabilities, idempotency }, app);

  // Start the in-process worker so enqueued jobs actually run.
  runtime.queue.start();

  const migrate = async (): Promise<void> => {
    await migrateAuthSchema(runtime.db as Database);
    await migrateOrganizationsSchema(runtime.db as Database);
    await migrateProjectsSchema(runtime.db as Database);
    await migrateCapabilitiesSchema(runtime.db as Database);
    await migrateIdempotencySchema(runtime.db as Database);
  };

  return { app, runtime, auth, orgs, projects, capabilities, idempotency, migrate };
}

export interface ServeOptions extends RuntimeOptions {
  port: number;
  hostname?: string;
  /**
   * When true, run the /auth + /organizations + /projects + capabilities
   * + idempotency schema migrations before binding the HTTP listener. This
   * enforces the required startup/readiness order (architect review of
   * WORK-003):
   *
   *   config -> infrastructure -> migrations -> migration success?
   *                                               |- no  -> startup failure / no readiness
   *                                               |- yes -> bind HTTP listener
   *
   * Migration failure REJECTS serve() so the HTTP listener is never bound
   * and the process is never "ready" against a missing/partial schema.
   * The caller (main.ts) MUST await serve() and treat rejection as a
   * fatal startup error.
   */
  autoMigrate?: boolean;
}

export interface ServedApi extends Api {
  port: number;
  stop(): Promise<void>;
}

export async function serve(opts: ServeOptions): Promise<ServedApi> {
  const { port, hostname, autoMigrate = false, ...runtimeOptions } = opts;
  const api = createApi(runtimeOptions);

  // STARTUP/READINESS GATE: migrations MUST complete (and MUST succeed)
  // before the HTTP listener is bound. There is no fire-and-forget path:
  // a failure here aborts startup, so the process never advertises
  // readiness against a schema it cannot serve.
  if (autoMigrate) {
    try {
      await api.migrate();
    } catch (err) {
      api.runtime.logger.error("api: startup aborted — migration failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // The in-process worker was started by createApi(); stop it so the
      // process can exit cleanly on the caller's fatal-exit path.
      await api.runtime.queue.stop().catch(() => {});
      throw err;
    }
  }

  // CAPABILITY-ADMIN BOOTSTRAP (architect review of PR #4 / WORK-005 §22):
  // the FIRST capability admin is granted by the DEPLOYMENT/OPERATOR
  // authority (CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID), never by the normal
  // tenant API. This runs AFTER the migration gate (the table must exist)
  // and BEFORE the HTTP listener is bound. Authority model:
  //
  //   deployment/bootstrap configuration → initial capability admin
  //            → normal capability-admin API → subsequent admin grants
  //
  // bootstrapCapabilityAdmin only grants when the admin table is empty
  // (idempotent no-op on re-deploys), so an env-var change cannot silently
  // add new admins to an already-bootstrapped installation. A DB failure
  // here aborts startup (same fatal path as a migration failure): the
  // operator asked for a bootstrap, and a silent skip would create a
  // security gap where they believe an admin exists when it does not.
  const bootstrapUserId =
    runtimeOptions.config?.bootstrapCapabilityAdminUserId;
  if (bootstrapUserId) {
    try {
      const result = await api.capabilities.bootstrapCapabilityAdmin({
        userId: bootstrapUserId,
        source: "deployment-config",
      });
      if (!result.granted) {
        api.runtime.logger.info(
          "api: capability-admin bootstrap not applied (admin table not empty)",
          { bootstrap_user_id: bootstrapUserId, reason: result.reason },
        );
      }
    } catch (err) {
      api.runtime.logger.error(
        "api: startup aborted — capability-admin bootstrap failed",
        {
          error: err instanceof Error ? err.message : String(err),
          bootstrap_user_id: bootstrapUserId,
        },
      );
      await api.runtime.queue.stop().catch(() => {});
      throw err;
    }
  }

  // Only bind the listener once the readiness gate has passed. If
  // migrations were requested and failed, this line is never reached.
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
