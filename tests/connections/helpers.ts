// tests/connections/helpers.ts — shared setup for WORK-010 connection +
// credential tests: seeds the full prerequisite stack (org + project +
// capability + version + provider + declaration + ACTIVE provider state)
// against real PostgreSQL AND real Minio object storage via the WORK-002
// withInfra harness.
import { PostgresDatabase, S3CompatibleObjectStorage } from "@cp/platform";
import {
  AuthService,
  migrateAuthSchema,
  buildPrincipal,
  type Principal,
} from "@cp/auth";
import {
  OrganizationsService,
  migrateOrganizationsSchema,
} from "@cp/organizations";
import {
  ProjectsService,
  migrateProjectsSchema,
} from "@cp/projects";
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
import { migrateCatalogSchema } from "@cp/catalog";
import { migratePoliciesSchema } from "@cp/policies";
import {
  migrateCredentialsSchema,
  type CredentialsService,
  type CredentialMutationAuthority,
  type AdapterCredentialResolver,
} from "@cp/credentials";
// WORK-010 (architect review #2 of PR #9): the capability factory is NOT
// on the public interface — tests import the trusted composition entry
// directly (the verification layer sits outside the src/ module graph the
// architecture checker governs), mirroring exactly what the composition
// root does.
import { createCredentialsBoundary } from "../../src/credentials/composition.ts";
import {
  ConnectionsService,
  migrateConnectionsSchema,
} from "@cp/connections";
import type { InfraHandle } from "../infra/harness.ts";

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

export interface ConnectionsTestContext {
  db: PostgresDatabase;
  storage: S3CompatibleObjectStorage;
  auth: AuthService;
  orgs: OrganizationsService;
  projects: ProjectsService;
  capabilities: CapabilitiesService;
  providers: ProvidersService;
  credentials: CredentialsService;
  credentialMutations: CredentialMutationAuthority;
  adapterResolver: AdapterCredentialResolver;
  connections: ConnectionsService;
  platformAdminP: Principal;
  cleanup: () => Promise<void>;
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 6)}@example.com`;
}

/** A fixed 32-byte test master key (hex) — NEVER a production key. */
export const TEST_MASTER_KEY_HEX = "a".repeat(64);

export async function setupConnections(
  handle: InfraHandle,
  opts: { applicationName?: string } = {},
): Promise<ConnectionsTestContext> {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: opts.applicationName ?? "cp-test-connections",
  });
  const storage = new S3CompatibleObjectStorage({
    endpoint: handle.storage.endpoint,
    region: handle.storage.region,
    bucket: handle.storage.bucket,
    accessKeyId: handle.storage.accessKeyId,
    secretAccessKey: handle.storage.secretAccessKey,
    forcePathStyle: true,
  });
  await migrateAuthSchema(db);
  await migrateOrganizationsSchema(db);
  await migrateProjectsSchema(db);
  await migrateCapabilitiesSchema(db);
  await migrateProvidersSchema(db);
  await migrateCatalogSchema(db);
  await migratePoliciesSchema(db);
  await migrateCredentialsSchema(db);
  await migrateConnectionsSchema(db);
  const auth = new AuthService({ db });
  const orgs = new OrganizationsService({ db });
  const projects = new ProjectsService({ db });
  const capabilities = new CapabilitiesService({ db });
  const providers = new ProvidersService({
    db,
    capabilities,
    adapters: createDefaultAdapterRegistry(),
  });
  // WORK-010 (architect review of PR #9): the boundary factory is the
  // SINGLE capability distribution point — the metadata service +
  // mutation capability go to the connection layer; the adapter resolver
  // is exposed on the test context ONLY to verify the seam CAN receive
  // and use it (never to the HTTP surface).
  const credentialsBoundary = createCredentialsBoundary({
    db,
    storage,
    masterKeyHex: TEST_MASTER_KEY_HEX,
  });
  const credentials = credentialsBoundary.service;
  const credentialMutations = credentialsBoundary.mutationAuthority;
  const adapterResolver = credentialsBoundary.adapterResolver;
  const connections = new ConnectionsService({
    db,
    projects,
    capabilities,
    providers,
    credentials,
    credentialMutations,
  });

  // A platform admin (deployment bootstrap) for seeding global catalog data.
  const adminUser = await auth.createUser({
    email: uniqueEmail("connadmin"),
    password: "password123",
  });
  await capabilities.bootstrapCapabilityAdmin({ userId: adminUser.id });
  const platformAdminP = buildPrincipal(adminUser.id, []);

  const cleanup = async () => {
    await db.close();
  };
  return {
    db, storage, auth, orgs, projects, capabilities, providers,
    credentials, credentialMutations, adapterResolver, connections,
    platformAdminP, cleanup,
  };
}

export interface TenantContext {
  organizationId: string;
  projectId: string;
  ownerP: Principal;
  adminP: Principal;
  memberP: Principal;
  ownerUserId: string;
  memberUserId: string;
}

/** Create an org with owner/admin/member and a project. */
export async function makeTenant(
  ctx: ConnectionsTestContext,
  label: string,
): Promise<TenantContext> {
  const t = `${label}-${Date.now()}-${++counter}`;
  const owner = await ctx.auth.createUser({ email: `${t}-owner@e.com`, password: "password123" });
  const admin = await ctx.auth.createUser({ email: `${t}-admin@e.com`, password: "password123" });
  const member = await ctx.auth.createUser({ email: `${t}-member@e.com`, password: "password123" });
  const { organization } = await ctx.orgs.createOrganizationWithOwner({
    ownerUserId: owner.id, name: `Org ${t}`, slug: `org-${t.toLowerCase()}`,
  });
  const ownerP = await ctx.orgs.buildPrincipalForUser(owner.id);
  await ctx.orgs.addMember({
    organizationId: organization.id, userId: admin.id, role: "admin", actingPrincipal: ownerP,
  });
  await ctx.orgs.addMember({
    organizationId: organization.id, userId: member.id, role: "member", actingPrincipal: ownerP,
  });
  const adminP = await ctx.orgs.buildPrincipalForUser(admin.id);
  const memberP = await ctx.orgs.buildPrincipalForUser(member.id);
  const project = await ctx.projects.createProject({
    organizationId: organization.id, name: "Proj", slug: `proj-${t.toLowerCase()}`,
    createdByUserId: owner.id, actingPrincipal: ownerP,
  });
  return {
    organizationId: organization.id,
    projectId: project.id,
    ownerP, adminP, memberP,
    ownerUserId: owner.id,
    memberUserId: member.id,
  };
}

/**
 * Seed the demo.echo capability@1 (active) + provider + declaration with
 * the provider in the AUTHORITATIVE ACTIVE lifecycle state (the fixture
 * adapter's contract tests gate contract_tested; the final state's
 * live-certification gate is fixture-unreachable, so it is set directly —
 * the provider lifecycle itself is WORK-006's tested surface).
 */
export async function seedEchoOffering(ctx: ConnectionsTestContext): Promise<void> {
  const { capabilities, providers, db, platformAdminP } = ctx;
  await capabilities.createCapability({
    capabilityId: "demo.echo", name: "Echo", actingPrincipal: platformAdminP,
  });
  await capabilities.transitionCapability({
    capabilityId: "demo.echo", toStatus: "active", actingPrincipal: platformAdminP,
  });
  await capabilities.createVersion({
    capabilityId: "demo.echo", version: "1", contract: ECHO_CONTRACT, actingPrincipal: platformAdminP,
  });
  await capabilities.transitionVersion({
    capabilityId: "demo.echo", version: "1", toStatus: "active", actingPrincipal: platformAdminP,
  });
  await providers.createProvider({
    providerId: "demo.echo", name: "Echo Demo Provider", actingPrincipal: platformAdminP,
  });
  await providers.declareProviderCapability({
    providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
    actingPrincipal: platformAdminP,
  });
  await providers.runContractTests({
    providerId: "demo.echo", actingPrincipal: platformAdminP,
  });
  for (const toStatus of ["integrating", "contract_tested", "observed"] as const) {
    await providers.transitionProvider({
      providerId: "demo.echo", toStatus, actingPrincipal: platformAdminP,
    });
  }
  await db.exec({
    text: `UPDATE cp_providers SET status = 'active' WHERE provider_id = 'demo.echo'`,
    params: [],
  });
}
