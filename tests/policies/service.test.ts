// tests/policies/service.test.ts — PoliciesService against REAL
// PostgreSQL (WORK-008 §26 POLICY MODEL + CONCURRENCY + TENANCY).
// Uses the WORK-002 withInfra harness; no mocks for persistence.
//
// Covers:
//   - create policy / get / list (project-scoped)
//   - duplicate policy name rejected within the project (DB constraint)
//   - create version (auto + explicit numbering); duplicate version rejected
//   - immutable published versions (update refused after draft)
//   - draft/active/deprecated/retired lifecycle + invalid transitions
//   - effective version selection: at-most-one-active; activation
//     auto-deprecates the previous active; retired/draft never effective
//   - evaluation through the service (version-pinned, pure)
//   - tenancy: cross-org and cross-project access rejected; membership
//     required; mutations require admin/owner
//   - concurrency: concurrent policy creation, concurrent version
//     creation, concurrent activation
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase, AppError } from "@cp/platform";
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
} from "@cp/capabilities";
import { migrateProvidersSchema } from "@cp/providers";
import { migrateCatalogSchema } from "@cp/catalog";
import {
  PoliciesService,
  migratePoliciesSchema,
} from "@cp/policies";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-policies",
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
  const policies = new PoliciesService({ db });
  const cleanup = async () => { await db.close(); };
  return { db, auth, orgs, projects, capabilities, policies, cleanup };
}

interface TestOrg {
  organizationId: string;
  projectId: string;
  ownerP: Principal;
  adminP: Principal;
  memberP: Principal;
}

let counter = 0;
async function makeOrg(
  ctx: Awaited<ReturnType<typeof setup>>,
  label: string,
): Promise<TestOrg> {
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
  return { organizationId: organization.id, projectId: project.id, ownerP, adminP, memberP };
}

const EU_RULES = [
  { subject: "region", operator: "eq", value: "EU", mode: "hard" },
  { subject: "certification", operator: "eq", value: "certified", mode: "hard" },
];
const GLOBAL_RULES = [
  { subject: "region", operator: "in", value: ["EU", "US", "AF"], mode: "hard" },
];

async function expectRejected(code: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    expect((err as AppError).code).toBe(code);
  }
  expect(threw).toBe(true);
}

describe("PoliciesService (real PostgreSQL)", () => {
  it("policy model: create/get/list; duplicate name rejected within the project", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const org = await makeOrg(ctx, "model");
        const p = await ctx.policies.createPolicy({
          organizationId: org.organizationId,
          projectId: org.projectId,
          name: "eu-only",
          description: "EU data residency",
          actingPrincipal: org.adminP,
        });
        expect(p.name).toBe("eu-only");
        const got = await ctx.policies.getPolicy(org.organizationId, org.projectId, p.id);
        expect(got?.id).toBe(p.id);
        const page = await ctx.policies.listPolicies(org.organizationId, org.projectId, {});
        expect(page.policies.length).toBe(1);
        // Duplicate name (case-insensitive) rejected.
        await expectRejected("policy.duplicate", () =>
          ctx.policies.createPolicy({
            organizationId: org.organizationId,
            projectId: org.projectId,
            name: "EU-Only",
            actingPrincipal: org.adminP,
          }),
        );
        // Name validation.
        await expectRejected("policy.validation", () =>
          ctx.policies.createPolicy({
            organizationId: org.organizationId, projectId: org.projectId, name: "  ",
            actingPrincipal: org.adminP,
          }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("versioning: auto + explicit numbering; duplicate version rejected; published versions immutable", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const org = await makeOrg(ctx, "ver");
        const policy = await ctx.policies.createPolicy({
          organizationId: org.organizationId, projectId: org.projectId,
          name: "p", actingPrincipal: org.adminP,
        });
        // Auto-numbered first version.
        const v1 = await ctx.policies.createVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, rules: EU_RULES, actingPrincipal: org.adminP,
        });
        expect(v1.version).toBe("1");
        expect(v1.status).toBe("draft");
        expect(v1.rules.length).toBe(2);
        // Draft rules are replaceable (never published).
        const v1b = await ctx.policies.updateDraftVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "1", rules: GLOBAL_RULES, actingPrincipal: org.adminP,
        });
        expect(v1b.rules.length).toBe(1);
        // Publish v1.
        const active1 = await ctx.policies.transitionVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "1", toStatus: "active", actingPrincipal: org.adminP,
        });
        expect(active1.status).toBe("active");
        // PUBLISHED versions are immutable — update refused.
        await expectRejected("policy.version.immutable", () =>
          ctx.policies.updateDraftVersion({
            organizationId: org.organizationId, projectId: org.projectId,
            policyId: policy.id, version: "1", rules: EU_RULES, actingPrincipal: org.adminP,
          }),
        );
        // Duplicate version rejected (DB constraint).
        await expectRejected("policy.version.duplicate", () =>
          ctx.policies.createVersion({
            organizationId: org.organizationId, projectId: org.projectId,
            policyId: policy.id, version: "1", rules: EU_RULES, actingPrincipal: org.adminP,
          }),
        );
        // Second version (auto = 2), publish → v1 auto-deprecated.
        const v2 = await ctx.policies.createVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, rules: EU_RULES, actingPrincipal: org.adminP,
        });
        expect(v2.version).toBe("2");
        await ctx.policies.transitionVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "2", toStatus: "active", actingPrincipal: org.adminP,
        });
        const effective = await ctx.policies.getEffectiveVersion(org.organizationId, org.projectId, policy.id);
        expect(effective?.version).toBe("2");
        const v1After = await ctx.policies.getVersion(org.organizationId, org.projectId, policy.id, "1");
        expect(v1After?.status).toBe("deprecated");
        // Invalid transitions: retired → active; active → draft; draft → deprecated.
        await ctx.policies.transitionVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "2", toStatus: "deprecated", actingPrincipal: org.adminP,
        });
        await ctx.policies.transitionVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "2", toStatus: "retired", actingPrincipal: org.adminP,
        });
        await expectRejected("policy.transition.invalid", () =>
          ctx.policies.transitionVersion({
            organizationId: org.organizationId, projectId: org.projectId,
            policyId: policy.id, version: "2", toStatus: "active", actingPrincipal: org.adminP,
          }),
        );
        await expectRejected("policy.transition.invalid", () =>
          ctx.policies.transitionVersion({
            organizationId: org.organizationId, projectId: org.projectId,
            policyId: policy.id, version: "1", toStatus: "draft", actingPrincipal: org.adminP,
          }),
        );
        await expectRejected("policy.transition.invalid", () =>
          ctx.policies.transitionVersion({
            organizationId: org.organizationId, projectId: org.projectId,
            policyId: policy.id, version: "1", toStatus: "deprecated", actingPrincipal: org.adminP,
          }),
        );
        // No active version left → effective is null (deterministic).
        expect(await ctx.policies.getEffectiveVersion(org.organizationId, org.projectId, policy.id)).toBeNull();
        // Retire v1 too → the policy is now FULLY retired: hidden from
        // the default list, visible with includeRetired.
        await ctx.policies.transitionVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "1", toStatus: "retired", actingPrincipal: org.adminP,
        });
        const def = await ctx.policies.listPolicies(org.organizationId, org.projectId, {});
        expect(def.policies.length).toBe(0);
        const all = await ctx.policies.listPolicies(org.organizationId, org.projectId, { includeRetired: true });
        expect(all.policies.length).toBe(1);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("effective version: only ACTIVE is effective — a higher draft/retired version never wins", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const org = await makeOrg(ctx, "eff");
        const policy = await ctx.policies.createPolicy({
          organizationId: org.organizationId, projectId: org.projectId,
          name: "p", actingPrincipal: org.adminP,
        });
        await ctx.policies.createVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "1", rules: EU_RULES, actingPrincipal: org.adminP,
        });
        await ctx.policies.transitionVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "1", toStatus: "active", actingPrincipal: org.adminP,
        });
        // Create HIGHER versions that stay draft and retired.
        await ctx.policies.createVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "5", rules: GLOBAL_RULES, actingPrincipal: org.adminP,
        });
        await ctx.policies.createVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "9", rules: EU_RULES, actingPrincipal: org.adminP,
        });
        await ctx.policies.transitionVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "9", toStatus: "retired", actingPrincipal: org.adminP,
        });
        const effective = await ctx.policies.getEffectiveVersion(org.organizationId, org.projectId, policy.id);
        expect(effective?.version).toBe("1"); // NOT "9", NOT "5"
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("evaluation through the service: version-pinned, pure, explainable", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const org = await makeOrg(ctx, "eval");
        const policy = await ctx.policies.createPolicy({
          organizationId: org.organizationId, projectId: org.projectId,
          name: "eu", actingPrincipal: org.adminP,
        });
        await ctx.policies.createVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, rules: [
            ...EU_RULES,
            { subject: "integration_path", operator: "eq", value: "platform_operated", mode: "preference" },
          ],
          actingPrincipal: org.adminP,
        });
        // A MEMBER may evaluate (read-gated, not admin-gated).
        const r = await ctx.policies.evaluatePolicyVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "1",
          context: { region: "EU", certification: "certified", integration_path: "provider_operated" },
          actingPrincipal: org.memberP,
        });
        expect(r.passed).toBe(true);
        expect(r.preferences.violated.length).toBe(1);
        // Unknown version → not found.
        await expectRejected("policy.version.not_found", () =>
          ctx.policies.evaluatePolicyVersion({
            organizationId: org.organizationId, projectId: org.projectId,
            policyId: policy.id, version: "99", context: {},
            actingPrincipal: org.memberP,
          }),
        );
        // Evaluation does not mutate anything: re-evaluating gives the
        // same result and the version state is unchanged.
        const r2 = await ctx.policies.evaluatePolicyVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId: policy.id, version: "1",
          context: { region: "EU", certification: "certified", integration_path: "provider_operated" },
          actingPrincipal: org.memberP,
        });
        expect(JSON.stringify(r2)).toBe(JSON.stringify(r));
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("TENANCY: cross-org, cross-project, non-member, and role gates enforced server-side", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const orgA = await makeOrg(ctx, "tena");
        const orgB = await makeOrg(ctx, "tenb");
        const policy = await ctx.policies.createPolicy({
          organizationId: orgA.organizationId, projectId: orgA.projectId,
          name: "eu", actingPrincipal: orgA.adminP,
        });
        await ctx.policies.createVersion({
          organizationId: orgA.organizationId, projectId: orgA.projectId,
          policyId: policy.id, rules: EU_RULES, actingPrincipal: orgA.adminP,
        });

        // Cross-org: org B's owner querying org A's policy under org B's
        // scope gets NULL (the scoped query cannot resolve another org's
        // project) — and evaluation (principal-carrying read) under org
        // B's scope cannot resolve org A's project either (member of org
        // B, but the project does not belong to org B).
        expect(await ctx.policies.getPolicy(orgB.organizationId, orgA.projectId, policy.id)).toBeNull();
        await expectRejected("policy.project.not_found", () =>
          ctx.policies.evaluatePolicyVersion({
            organizationId: orgB.organizationId, projectId: orgA.projectId,
            policyId: policy.id, version: "1", context: { region: "EU" },
            actingPrincipal: orgB.ownerP,
          }),
        );
        // A non-member of org A cannot evaluate org A's policy even with
        // the correct scope ids (membership gate).
        await expectRejected("policy.membership.required", () =>
          ctx.policies.evaluatePolicyVersion({
            organizationId: orgA.organizationId, projectId: orgA.projectId,
            policyId: policy.id, version: "1", context: { region: "EU" },
            actingPrincipal: orgB.ownerP,
          }),
        );
        // Cross-project: org A's admin cannot access the policy under
        // org B's project scope (returns null — the project join fails).
        expect(await ctx.policies.getPolicy(orgA.organizationId, orgB.projectId, policy.id)).toBeNull();
        // Non-member mutation refused.
        await expectRejected("policy.membership.required", () =>
          ctx.policies.createPolicy({
            organizationId: orgA.organizationId, projectId: orgA.projectId,
            name: "x", actingPrincipal: orgB.ownerP,
          }),
        );
        // MEMBER (ordinary) cannot mutate: create policy / create version
        // / transition — but CAN read and evaluate.
        await expectRejected("policy.role.required", () =>
          ctx.policies.createPolicy({
            organizationId: orgA.organizationId, projectId: orgA.projectId,
            name: "member-made", actingPrincipal: orgA.memberP,
          }),
        );
        await expectRejected("policy.role.required", () =>
          ctx.policies.createVersion({
            organizationId: orgA.organizationId, projectId: orgA.projectId,
            policyId: policy.id, rules: GLOBAL_RULES, actingPrincipal: orgA.memberP,
          }),
        );
        await expectRejected("policy.role.required", () =>
          ctx.policies.transitionVersion({
            organizationId: orgA.organizationId, projectId: orgA.projectId,
            policyId: policy.id, version: "1", toStatus: "active", actingPrincipal: orgA.memberP,
          }),
        );
        const read = await ctx.policies.getPolicy(orgA.organizationId, orgA.projectId, policy.id);
        expect(read?.id).toBe(policy.id);
        // Unknown project id in the same org → not found.
        await expectRejected("policy.project.not_found", () =>
          ctx.policies.createPolicy({
            organizationId: orgA.organizationId, projectId: "proj_missing",
            name: "x", actingPrincipal: orgA.adminP,
          }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("CONCURRENCY: concurrent policy creation / version creation / activation resolve via DB constraints", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const org = await makeOrg(ctx, "conc");
        // Warm the pool so the operations genuinely overlap.
        await Promise.all([
          ctx.capabilities.isCapabilityAdmin("warmup"),
          ctx.capabilities.isCapabilityAdmin("warmup"),
          ctx.capabilities.isCapabilityAdmin("warmup"),
          ctx.capabilities.isCapabilityAdmin("warmup"),
        ]);
        // Concurrent identical policy creation → exactly one succeeds.
        const policyResults = await Promise.allSettled([
          ctx.policies.createPolicy({
            organizationId: org.organizationId, projectId: org.projectId,
            name: "race", actingPrincipal: org.adminP,
          }),
          ctx.policies.createPolicy({
            organizationId: org.organizationId, projectId: org.projectId,
            name: "race", actingPrincipal: org.adminP,
          }),
        ]);
        expect(policyResults.filter((r) => r.status === "fulfilled").length).toBe(1);
        expect((policyResults.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)
          .toBeInstanceOf(AppError);

        const policyId = (policyResults.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value.id;

        // Concurrent identical version creation → exactly one succeeds.
        const versionResults = await Promise.allSettled([
          ctx.policies.createVersion({
            organizationId: org.organizationId, projectId: org.projectId,
            policyId, version: "1", rules: EU_RULES, actingPrincipal: org.adminP,
          }),
          ctx.policies.createVersion({
            organizationId: org.organizationId, projectId: org.projectId,
            policyId, version: "1", rules: EU_RULES, actingPrincipal: org.adminP,
          }),
        ]);
        expect(versionResults.filter((r) => r.status === "fulfilled").length).toBe(1);

        // Create a second version, then race BOTH activations: exactly
        // one version can end up active (partial unique index).
        await ctx.policies.createVersion({
          organizationId: org.organizationId, projectId: org.projectId,
          policyId, version: "2", rules: GLOBAL_RULES, actingPrincipal: org.adminP,
        });
        const activationResults = await Promise.allSettled([
          ctx.policies.transitionVersion({
            organizationId: org.organizationId, projectId: org.projectId,
            policyId, version: "1", toStatus: "active", actingPrincipal: org.adminP,
          }),
          ctx.policies.transitionVersion({
            organizationId: org.organizationId, projectId: org.projectId,
            policyId, version: "2", toStatus: "active", actingPrincipal: org.adminP,
          }),
        ]);
        // At most one activation wins the single active slot. (Both may
        // succeed sequentially in a serialized interleaving — then v1 is
        // deprecated by v2's activation — but exactly one ACTIVE row
        // exists afterwards; the invariant is the assertion.)
        const finalVersions = await ctx.policies.listVersions(org.organizationId, org.projectId, policyId, {});
        const active = finalVersions.versions.filter((v) => v.status === "active");
        expect(active.length).toBe(1);
        void activationResults;
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
