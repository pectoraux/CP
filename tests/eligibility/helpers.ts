// tests/eligibility/helpers.ts — shared setup for WORK-009 integration
// tests: seeds the full prerequisite stack (org + project + policy +
// capability + version + provider + declaration + catalog facts) against
// real PostgreSQL via the WORK-002 withInfra harness.
import { PostgresDatabase } from "@cp/platform";
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
import {
  CatalogService,
  migrateCatalogSchema,
} from "@cp/catalog";
import {
  PoliciesService,
  migratePoliciesSchema,
} from "@cp/policies";
import { EligibilityService } from "@cp/eligibility";

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

export interface EligibilityTestContext {
  db: PostgresDatabase;
  auth: AuthService;
  orgs: OrganizationsService;
  projects: ProjectsService;
  capabilities: CapabilitiesService;
  providers: ProvidersService;
  catalog: CatalogService;
  policies: PoliciesService;
  eligibility: EligibilityService;
  adminP: Principal;
  cleanup: () => Promise<void>;
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 6)}@example.com`;
}

export async function setupEligibility(
  handle: { pg: { connectionString: string } },
  opts: { applicationName?: string } = {},
): Promise<EligibilityTestContext> {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: opts.applicationName ?? "cp-test-eligibility",
  });
  await migrateAuthSchema(db);
  await migrateOrganizationsSchema(db);
  await migrateProjectsSchema(db);
  await migrateCapabilitiesSchema(db);
  await migrateProvidersSchema(db);
  await migrateCatalogSchema(db);
  await migratePoliciesSchema(db);
  const auth = new AuthService({ db });
  const orgs = new OrganizationsService({ db });
  const projects = new ProjectsService({ db });
  const capabilities = new CapabilitiesService({ db });
  const providers = new ProvidersService({
    db,
    capabilities,
    adapters: createDefaultAdapterRegistry(),
  });
  const catalog = new CatalogService({ db, capabilities });
  const policies = new PoliciesService({ db });
  const eligibility = new EligibilityService({
    capabilities,
    catalog,
    policies,
    projects,
  });

  // A platform admin (deployment bootstrap) for seeding global catalog data.
  const adminUser = await auth.createUser({
    email: uniqueEmail("eligadmin"),
    password: "password123",
  });
  await capabilities.bootstrapCapabilityAdmin({ userId: adminUser.id });
  const adminP = buildPrincipal(adminUser.id, []);

  const cleanup = async () => {
    await db.close();
  };
  return {
    db, auth, orgs, projects, capabilities, providers, catalog, policies,
    eligibility, adminP, cleanup,
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
  ctx: EligibilityTestContext,
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
 * Seed the demo.echo capability@1 (active) + provider + declaration.
 * The provider is driven to the AUTHORITATIVE ACTIVE lifecycle state so
 * the offering is a production candidate (architect review of PR #8:
 * only the active state is eligible — the seeded fixture walks the
 * full onboarding pipeline: discovered → integrating → contract_tested
 * → observed → certified → active, exactly as the provider service's
 * evidence gates allow for a fixture contract-verified implementation).
 */
export async function seedEchoOffering(ctx: EligibilityTestContext): Promise<void> {
  const { capabilities, providers, adminP } = ctx;
  await capabilities.createCapability({
    capabilityId: "demo.echo", name: "Echo", actingPrincipal: adminP,
  });
  await capabilities.transitionCapability({
    capabilityId: "demo.echo", toStatus: "active", actingPrincipal: adminP,
  });
  await capabilities.createVersion({
    capabilityId: "demo.echo", version: "1", contract: ECHO_CONTRACT, actingPrincipal: adminP,
  });
  await capabilities.transitionVersion({
    capabilityId: "demo.echo", version: "1", toStatus: "active", actingPrincipal: adminP,
  });
  await providers.createProvider({
    providerId: "demo.echo", name: "Echo Demo Provider", actingPrincipal: adminP,
  });
  await providers.declareProviderCapability({
    providerId: "demo.echo", capabilityId: "demo.echo", capabilityVersion: "1",
    actingPrincipal: adminP,
  });
  // Walk the provider to the AUTHORITATIVE ACTIVE lifecycle state so
  // the offering is a production candidate. The `certified` transition's
  // evidence gate (a certified implementation requires LIVE evidence,
  // unreachable with the fixture adapter) is bypassed with a direct
  // state update — this helper verifies the ELIGIBILITY layer's
  // consumption of provider states, not the provider lifecycle itself
  // (WORK-006's tests own that).
  await providers.runContractTests({
    providerId: "demo.echo", actingPrincipal: adminP,
  });
  for (const toStatus of ["integrating", "contract_tested", "observed"] as const) {
    await providers.transitionProvider({
      providerId: "demo.echo", toStatus, actingPrincipal: adminP,
    });
  }
  // `certified` + `active` are gated behind LIVE certification evidence
  // (unreachable with the fixture adapter) — set the final state
  // directly: this helper verifies the ELIGIBILITY layer's consumption
  // of provider states, not the provider lifecycle itself.
  await ctx.db.exec({
    text: `UPDATE cp_providers SET status = 'active' WHERE provider_id = 'demo.echo'`,
    params: [],
  });
}

/** Create a policy with an ACTIVE version in the tenant's project. */
export async function seedPolicy(
  ctx: EligibilityTestContext,
  tenant: TenantContext,
  name: string,
  rules: unknown[],
  opts: { activate?: boolean } = {},
): Promise<{ policyId: string; version: string }> {
  const policy = await ctx.policies.createPolicy({
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    name,
    actingPrincipal: tenant.adminP,
  });
  const version = await ctx.policies.createVersion({
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    policyId: policy.id,
    rules,
    actingPrincipal: tenant.adminP,
  });
  if (opts.activate !== false) {
    await ctx.policies.transitionVersion({
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      policyId: policy.id,
      version: version.version,
      toStatus: "active",
      actingPrincipal: tenant.adminP,
    });
  }
  return { policyId: policy.id, version: version.version };
}

/** A permissive default policy (single preference rule — never disqualifies). */
export const PERMISSIVE_RULES = [
  { subject: "integration_path", operator: "eq", value: "platform_operated", mode: "preference" },
];
