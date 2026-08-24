// tests/catalog/helpers.ts — shared setup for WORK-007 catalog tests:
// seeds the catalog prerequisite stack (capability + version + provider +
// declaration) against real PostgreSQL via the WORK-002 withInfra harness.
import { PostgresDatabase } from "@cp/platform";
import {
  AuthService,
  migrateAuthSchema,
  buildPrincipal,
  type Principal,
} from "@cp/auth";
import { migrateOrganizationsSchema } from "@cp/organizations";
import { migrateProjectsSchema } from "@cp/projects";
import {
  CapabilitiesService,
  migrateCapabilitiesSchema,
  type CapabilityContract,
} from "@cp/capabilities";
import {
  ProvidersService,
  migrateProvidersSchema,
  createDefaultAdapterRegistry,
} from "@cp/providers";
import { CatalogService, migrateCatalogSchema } from "@cp/catalog";

export interface CatalogTestContext {
  db: PostgresDatabase;
  auth: AuthService;
  capabilities: CapabilitiesService;
  providers: ProvidersService;
  catalog: CatalogService;
  adminP: Principal;
  cleanup: () => Promise<void>;
}

export const ECHO_CONTRACT: CapabilityContract = {
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  outputSchema: {
    type: "object",
    properties: {
      echoed: { type: "string" },
      echo_id: { type: "string" },
      echoed_at: { type: "string" },
    },
    required: ["echoed", "echo_id", "echoed_at"],
  },
  errorModel: [],
  sideEffect: "pure",
  idempotencySemantics: { supports_idempotency_key: false },
  requiredContext: [],
  executionModes: ["live"],
  policyMetadata: {},
  constraints: [],
  latencyExpectations: {},
};

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 6)}@example.com`;
}

/**
 * Full setup: migrations (all six schemas), services, a deployment-
 * bootstrapped capability admin, and (optionally) a seeded
 * demo.echo capability@1 + demo.echo provider declaration to attach
 * catalog facts to.
 */
export async function setupCatalog(
  handle: { pg: { connectionString: string } },
  opts: { seedEcho?: boolean; applicationName?: string } = {},
): Promise<CatalogTestContext> {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: opts.applicationName ?? "cp-test-catalog",
  });
  await migrateAuthSchema(db);
  await migrateOrganizationsSchema(db);
  await migrateProjectsSchema(db);
  await migrateCapabilitiesSchema(db);
  await migrateProvidersSchema(db);
  await migrateCatalogSchema(db);
  const auth = new AuthService({ db });
  const capabilities = new CapabilitiesService({ db });
  const providers = new ProvidersService({
    db,
    capabilities,
    adapters: createDefaultAdapterRegistry(),
  });
  const catalog = new CatalogService({ db, capabilities });

  const adminUser = await auth.createUser({
    email: uniqueEmail("catadmin"),
    password: "password123",
  });
  await capabilities.bootstrapCapabilityAdmin({ userId: adminUser.id });
  const adminP = buildPrincipal(adminUser.id, []);

  if (opts.seedEcho !== false) {
    await seedEchoStack({ capabilities, providers, adminP });
  }

  const cleanup = async () => {
    await db.close();
  };
  return { db, auth, capabilities, providers, catalog, adminP, cleanup };
}

/** Seed demo.echo capability@1 (active) + demo.echo provider + declaration. */
export async function seedEchoStack(input: {
  capabilities: CapabilitiesService;
  providers: ProvidersService;
  adminP: Principal;
}): Promise<void> {
  const { capabilities, providers, adminP } = input;
  await capabilities.createCapability({
    capabilityId: "demo.echo",
    name: "Echo",
    actingPrincipal: adminP,
  });
  await capabilities.transitionCapability({
    capabilityId: "demo.echo",
    toStatus: "active",
    actingPrincipal: adminP,
  });
  await capabilities.createVersion({
    capabilityId: "demo.echo",
    version: "1",
    contract: ECHO_CONTRACT,
    actingPrincipal: adminP,
  });
  await capabilities.transitionVersion({
    capabilityId: "demo.echo",
    version: "1",
    toStatus: "active",
    actingPrincipal: adminP,
  });
  await providers.createProvider({
    providerId: "demo.echo",
    name: "Echo Demo Provider",
    actingPrincipal: adminP,
  });
  await providers.declareProviderCapability({
    providerId: "demo.echo",
    capabilityId: "demo.echo",
    capabilityVersion: "1",
    actingPrincipal: adminP,
  });
}

/** Create an ordinary (non-admin) user + principal. */
export async function makeOrdinaryUser(
  ctx: CatalogTestContext,
): Promise<Principal> {
  const u = await ctx.auth.createUser({
    email: uniqueEmail("catuser"),
    password: "password123",
  });
  return buildPrincipal(u.id, []);
}
