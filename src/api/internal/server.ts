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
  ProvidersService,
  migrateProvidersSchema,
  createDefaultAdapterRegistry,
} from "@cp/providers";
import { CatalogService, migrateCatalogSchema } from "@cp/catalog";
import { PoliciesService, migratePoliciesSchema } from "@cp/policies";
import { EligibilityService } from "@cp/eligibility";
import { migrateCredentialsSchema } from "@cp/credentials";
// WORK-010 (architect review #2 of PR #9): the capability factory is
// imported from the TRUSTED composition entry — this file (the
// composition root) is the ONLY place in the codebase permitted to
// construct the privileged credential capabilities
// (arch-check rule credentials-composition-restricted). The ordinary
// public interface (@cp/credentials) does not export the factory, so no
// ordinary module can manufacture credential authority.
import { createCredentialsBoundary } from "@cp/credentials/composition";
import { ConnectionsService, migrateConnectionsSchema } from "@cp/connections";
import { OutcomesService, migrateOutcomesSchema } from "@cp/outcomes";
import { GoalsService, migrateGoalsSchema } from "@cp/goals";
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
import { createProviderRoutes } from "./handlers-providers.ts";
import { createCatalogRoutes } from "./handlers-catalog.ts";
import { createPolicyRoutes } from "./handlers-policies.ts";
import { createEligibilityRoutes } from "./handlers-eligibility.ts";
import { createConnectionRoutes } from "./handlers-connections.ts";
import { createGoalRoutes } from "./handlers-goals.ts";
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
  providers: ProvidersService;
  catalog: CatalogService;
  policies: PoliciesService;
  eligibility: EligibilityService;
  connections: ConnectionsService;
  outcomes: OutcomesService;
  goals: GoalsService;
  idempotency: IdempotencyStore;
  /**
   * Create or update the /auth + /organizations + /projects + capabilities
   * + providers + catalog + policies + idempotency schema on the configured
   * database. Idempotent. Safe to call on every startup. Must be called
   * before auth/org/project/capability/provider/catalog/policy routes will
   * function. Throws on DB failure so misconfiguration is explicit (no
   * silent no-schema fallback) — the serve() readiness gate refuses to bind
   * the HTTP listener if this fails.
   *
   * Ordering: the /providers migration references cp_capabilities, the
   * /catalog migration references cp_provider_capabilities, and the
   * /policies migration references cp_projects (cross-module FKs), so each
   * runs after its dependency.
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
  // WORK-006: the provider registry consumes the capability catalog
  // through its public interface (providers → capabilities is the legal
  // direction — the capability graph is upstream of providers) and the
  // default first-party adapter registry (deterministic demo.echo
  // fixture; production provider integrations are out of scope for
  // WORK-006).
  const providers = new ProvidersService({
    db: runtime.db,
    logger: runtime.logger,
    capabilities,
    adapters: createDefaultAdapterRegistry(),
  });
  // WORK-007: the marketplace catalog consumes the capability catalog's
  // public interface for the admin-authority check and projects offerings
  // over the providers/capabilities tables via SQL joins (catalog →
  // capabilities/providers is the intended one-way direction; the catalog
  // owns only marketplace FACTS — pricing, coverage, health — with
  // provenance).
  const catalog = new CatalogService({
    db: runtime.db,
    logger: runtime.logger,
    capabilities,
  });
  // WORK-008: the policy engine is tenant-scoped customer configuration
  // (Organization → Project → Policies, architecture §34). It depends only
  // on @cp/platform + @cp/auth (tenant authorization via the Principal's
  // memberships); policy rules are constrained declarative data and the
  // evaluator is pure. The service never selects providers.
  const policies = new PoliciesService({
    db: runtime.db,
    logger: runtime.logger,
  });
  // WORK-009: the eligibility engine consumes the PUBLIC policy
  // evaluator, the PUBLIC catalog offering projection, the PUBLIC
  // capabilities interface, and the PUBLIC projects interface (project
  // existence/tenant ownership — architect review of PR #8). It is
  // STATELESS (no tables, no cache, no direct Database dependency) and
  // its core evaluator is pure — it never invokes provider adapters or
  // chooses winners.
  const eligibility = new EligibilityService({
    logger: runtime.logger,
    capabilities,
    catalog,
    policies,
    projects,
  });
  // WORK-010 + architect reviews #1 + #2 of PR #9: the credentials
  // boundary is the RUNTIME CAPABILITY DISTRIBUTION POINT, constructed
  // HERE — the single trusted composition root (the factory is not on
  // the module's public interface and is importable only by this file).
  // The metadata service and the mutation capability are injected into
  // the connection layer; the adapter RESOLUTION capability is reserved
  // for the future execution/provider-adapter seam (WORK-014), which
  // will RECEIVE it by injection below. There is NO minting method
  // anywhere: authority = holding the object reference, and references
  // propagate only via this wiring. The master key comes from deployment
  // configuration (CP_CREDENTIAL_MASTER_KEY) — never persisted, never
  // logged.
  const credentialsBoundary = createCredentialsBoundary({
    db: runtime.db,
    storage: runtime.storage,
    logger: runtime.logger,
  });
  const credentials = credentialsBoundary.service;
  const credentialMutations = credentialsBoundary.mutationAuthority;
  // RESERVED FOR WORK-014: inject into the execution/provider-adapter
  // seam when it exists. Deliberately NOT exposed on the Api object and
  // NOT reachable from any route or handler — the resolver reference
  // exists only here, so ordinary request-handling code cannot obtain
  // credential-resolution authority (proven by negative tests).
  const adapterCredentialResolver = credentialsBoundary.adapterResolver;
  void adapterCredentialResolver;
  // WORK-010: the tenant-scoped connection layer references global
  // providers/capabilities (public interfaces) and credential references
  // (never secrets). It is downstream tenant infrastructure: connection
  // existence never mutates catalog/eligibility state.
  const connections = new ConnectionsService({
    db: runtime.db,
    logger: runtime.logger,
    projects,
    capabilities,
    providers,
    credentials,
    credentialMutations,
  });
  // WORK-011: the outcome-contract layer owns the versioned, immutable
  // measurement definitions; the goal layer owns the customer objectives
  // and references exact contract versions through the public interface.
  // Both are project-scoped customer configuration (architecture §5).
  const outcomes = new OutcomesService({
    db: runtime.db,
    logger: runtime.logger,
    projects,
  });
  const goals = new GoalsService({
    db: runtime.db,
    logger: runtime.logger,
    projects,
    outcomes,
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
  // WORK-006 provider routes under /v1/providers. Like capabilities, these
  // are GLOBAL (not tenant-scoped): the auth middleware verifies the
  // credential and builds the Principal; mutation routes require the
  // CP-level capability-admin grant (checked inside ProvidersService); read
  // routes are authenticated-only. Provider registry rows contain NO
  // tenant connection data and NO secrets (credential REQUIREMENTS are
  // metadata only; actual secrets belong to the future connections layer).
  createProviderRoutes({ runtime, auth, orgs, providers, idempotency }, app);
  // WORK-007 catalog routes under /v1/catalog — the read-oriented
  // marketplace query surface (offering list/detail with filters) plus
  // admin-gated fact mutations (pricing/coverage/health). The catalog is
  // GLOBAL: no tenant connection data and no secrets on any route; reads
  // are authenticated-only and mutations require the CP-level
  // capability-admin grant (checked inside CatalogService).
  createCatalogRoutes({ runtime, auth, orgs, catalog, idempotency }, app);
  // WORK-008 policy routes under the project scope
  // (/v1/organizations/:orgId/projects/:projectId/policies). The standard
  // WORK-004 tenant gates run first (orgContextMiddleware resolves the
  // AUTHORIZED org; projectContextMiddleware verifies project ∈ org); the
  // service re-verifies membership + admin/owner role for mutations.
  // Evaluation is read-only against an explicit version with a
  // caller-supplied context.
  createPolicyRoutes({ runtime, auth, orgs, projects, policies, idempotency }, app);
  // WORK-009 eligibility route under the project scope
  // (/v1/organizations/:orgId/projects/:projectId/eligibility/evaluate).
  // The standard WORK-004 tenant gates run first; the service re-verifies
  // membership and loads the policy ONLY within the authorized project
  // scope. Evaluation is read-only, explainable, and produces NO ranking.
  createEligibilityRoutes({ runtime, auth, orgs, projects, eligibility, idempotency }, app);
  // WORK-010 connection routes under the project scope
  // (/v1/organizations/:orgId/projects/:projectId/connections). The
  // standard WORK-004 tenant gates run first; the service re-verifies
  // membership + admin/owner role for mutations. The credential-attach
  // endpoint is the ONLY secret-bearing route and uses redacted-fingerprint
  // idempotency so raw secrets never reach cp_idempotency.
  createConnectionRoutes({ runtime, auth, orgs, projects, connections, idempotency }, app);
  // WORK-011 goal + outcome-contract routes under the project scope.
  // The standard WORK-004 tenant gates run first; the services
  // re-verify membership + admin/owner role for mutations. Reads are
  // member-open. No secrets are involved anywhere in this domain.
  createGoalRoutes({ runtime, auth, orgs, projects, goals, outcomes, idempotency }, app);

  // Start the in-process worker so enqueued jobs actually run.
  runtime.queue.start();

  const migrate = async (): Promise<void> => {
    await migrateAuthSchema(runtime.db as Database);
    await migrateOrganizationsSchema(runtime.db as Database);
    await migrateProjectsSchema(runtime.db as Database);
    await migrateCapabilitiesSchema(runtime.db as Database);
    await migrateProvidersSchema(runtime.db as Database);
    await migrateCatalogSchema(runtime.db as Database);
    await migratePoliciesSchema(runtime.db as Database);
    await migrateCredentialsSchema(runtime.db as Database);
    await migrateConnectionsSchema(runtime.db as Database);
    await migrateOutcomesSchema(runtime.db as Database);
    await migrateGoalsSchema(runtime.db as Database);
    await migrateIdempotencySchema(runtime.db as Database);
  };

  return { app, runtime, auth, orgs, projects, capabilities, providers, catalog, policies, eligibility, connections, outcomes, goals, idempotency, migrate };
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
  // tenant API. This runs AFTER the migration gate (the tables must exist)
  // and BEFORE the HTTP listener is bound. Authority model:
  //
  //   deployment/bootstrap configuration → initial capability admin
  //            → normal capability-admin API → subsequent admin grants
  //
  // The claim + grant are ONE atomic database statement over a singleton
  // row (constant-TRUE primary key — architect review #2 of PR #4), so
  // two instances of this process racing with different bootstrap users
  // can NEVER create two bootstrap admins: exactly one claim row can ever
  // exist. When any admin already exists (re-deploy, env-var change, or a
  // pre-fix installation), the bootstrap is a logged no-op — an env-var
  // change can never silently add new admins. A DB failure here aborts
  // startup (same fatal path as a migration failure): the operator asked
  // for a bootstrap, and a silent skip would create a security gap where
  // they believe an admin exists when it does not.
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
