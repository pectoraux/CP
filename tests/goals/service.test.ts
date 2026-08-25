// tests/goals/service.test.ts — GoalsService + OutcomesService against
// REAL PostgreSQL (WORK-011 §30). Covers goals, objectives, outcome
// contracts, versioning, tenancy, and concurrency.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase, AppError } from "@cp/platform";
import { buildPrincipal, type Principal } from "@cp/auth";
import { migrateAuthSchema, AuthService } from "@cp/auth";
import { migrateOrganizationsSchema, OrganizationsService } from "@cp/organizations";
import { migrateProjectsSchema, ProjectsService } from "@cp/projects";
import { migrateCapabilitiesSchema, CapabilitiesService } from "@cp/capabilities";
import { migrateProvidersSchema } from "@cp/providers";
import { migrateCatalogSchema } from "@cp/catalog";
import { migratePoliciesSchema } from "@cp/policies";
import { migrateCredentialsSchema } from "@cp/credentials";
import { migrateConnectionsSchema } from "@cp/connections";
import { OutcomesService, migrateOutcomesSchema } from "@cp/outcomes";
import { GoalsService, migrateGoalsSchema } from "@cp/goals";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-goals",
  });
  for (const m of [
    migrateAuthSchema, migrateOrganizationsSchema, migrateProjectsSchema,
    migrateCapabilitiesSchema, migrateProvidersSchema, migrateCatalogSchema,
    migratePoliciesSchema, migrateCredentialsSchema, migrateConnectionsSchema,
    migrateOutcomesSchema, migrateGoalsSchema,
  ]) {
    await m(db);
  }
  const auth = new AuthService({ db });
  const orgs = new OrganizationsService({ db });
  const projects = new ProjectsService({ db });
  const capabilities = new CapabilitiesService({ db });
  const outcomes = new OutcomesService({ db, projects });
  const goals = new GoalsService({ db, projects, outcomes });
  const cleanup = async () => { await db.close(); };
  return { db, auth, orgs, projects, capabilities, outcomes, goals, cleanup };
}

let counter = 0;
interface Tenant {
  organizationId: string;
  projectId: string;
  ownerP: Principal;
  adminP: Principal;
  memberP: Principal;
  ownerUserId: string;
  memberUserId: string;
}

async function makeTenant(ctx: Awaited<ReturnType<typeof setup>>, label: string): Promise<Tenant> {
  const t = `${label}-${Date.now()}-${++counter}`;
  const owner = await ctx.auth.createUser({ email: `${t}-owner@e.com`, password: "password123" });
  const admin = await ctx.auth.createUser({ email: `${t}-admin@e.com`, password: "password123" });
  const member = await ctx.auth.createUser({ email: `${t}-member@e.com`, password: "password123" });
  const { organization } = await ctx.orgs.createOrganizationWithOwner({
    ownerUserId: owner.id, name: `Org ${t}`, slug: `org-${t.toLowerCase()}`,
  });
  const ownerP = await ctx.orgs.buildPrincipalForUser(owner.id);
  await ctx.orgs.addMember({ organizationId: organization.id, userId: admin.id, role: "admin", actingPrincipal: ownerP });
  await ctx.orgs.addMember({ organizationId: organization.id, userId: member.id, role: "member", actingPrincipal: ownerP });
  const adminP = await ctx.orgs.buildPrincipalForUser(admin.id);
  const memberP = await ctx.orgs.buildPrincipalForUser(member.id);
  const project = await ctx.projects.createProject({
    organizationId: organization.id, name: "Proj", slug: `proj-${t.toLowerCase()}`,
    createdByUserId: owner.id, actingPrincipal: ownerP,
  });
  return {
    organizationId: organization.id, projectId: project.id,
    ownerP, adminP, memberP, ownerUserId: owner.id, memberUserId: member.id,
  };
}

const SUCCESS_CONTRACT = {
  metric: "success_rate",
  unit: "ratio",
  direction: "maximize",
  aggregation: "mean",
  threshold: 0.99,
  window_seconds: 300,
  measurement_source: "execution_observation",
  required: true,
  description: "Acceptance success ratio",
};

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

describe("WORK-011 outcome contracts (real PostgreSQL)", () => {
  it("create → draft v1 → activate → immutable; versioning + duplicate names", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const tenant = await makeTenant(ctx, "oc");
        const v1 = await ctx.outcomes.createContract({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          name: "acceptance", description: "success rate contract",
          content: SUCCESS_CONTRACT, actingPrincipal: tenant.adminP,
        });
        expect(v1.version).toBe("1");
        expect(v1.status).toBe("draft");
        expect(v1.content.metric).toBe("success_rate");
        expect(v1.content.threshold).toBe(0.99);

        // Duplicate name rejected.
        await expectRejected("outcome.contract.duplicate", () =>
          ctx.outcomes.createContract({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            name: "Acceptance", content: SUCCESS_CONTRACT, actingPrincipal: tenant.adminP,
          }),
        );

        // Draft replaceable; published immutable.
        await ctx.outcomes.updateDraftContent({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          contractId: v1.contractId, version: "1",
          content: { ...SUCCESS_CONTRACT, threshold: 0.995 }, actingPrincipal: tenant.adminP,
        });
        await ctx.outcomes.transitionVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          contractId: v1.contractId, version: "1", toStatus: "active", actingPrincipal: tenant.adminP,
        });
        await expectRejected("outcome.contract.version.immutable", () =>
          ctx.outcomes.updateDraftContent({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            contractId: v1.contractId, version: "1",
            content: SUCCESS_CONTRACT, actingPrincipal: tenant.adminP,
          }),
        );

        // v2 → activate → v1 auto-deprecated; active version is v2.
        const v2 = await ctx.outcomes.createVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          contractId: v1.contractId, content: { ...SUCCESS_CONTRACT, threshold: 0.98 },
          actingPrincipal: tenant.adminP,
        });
        expect(v2.version).toBe("2");
        await ctx.outcomes.transitionVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          contractId: v1.contractId, version: "2", toStatus: "active", actingPrincipal: tenant.adminP,
        });
        const active = await ctx.outcomes.getActiveVersion(tenant.projectId, v1.contractId);
        expect(active?.version).toBe("2");
        // Invalid transitions.
        await expectRejected("outcome.contract.transition.invalid", () =>
          ctx.outcomes.transitionVersion({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            contractId: v1.contractId, version: "2", toStatus: "draft", actingPrincipal: tenant.adminP,
          }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("contract validation: unknown metric/unit/aggregation/source, family mismatches, thresholds, windows", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const tenant = await makeTenant(ctx, "ocv");
        const base = {
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          name: "x", actingPrincipal: tenant.adminP,
        };
        await expectRejected("outcome.validation", () =>
          ctx.outcomes.createContract({ ...base, name: "a", content: { ...SUCCESS_CONTRACT, metric: "vibe_score" } }),
        );
        await expectRejected("outcome.validation", () =>
          ctx.outcomes.createContract({ ...base, name: "b", content: { ...SUCCESS_CONTRACT, unit: "parsecs" } }),
        );
        await expectRejected("outcome.validation", () =>
          ctx.outcomes.createContract({ ...base, name: "c", content: { ...SUCCESS_CONTRACT, unit: "ms" } }),
        );
        await expectRejected("outcome.validation", () =>
          ctx.outcomes.createContract({ ...base, name: "d", content: { ...SUCCESS_CONTRACT, aggregation: "vibes" } }),
        );
        await expectRejected("outcome.validation", () =>
          ctx.outcomes.createContract({ ...base, name: "e", content: { ...SUCCESS_CONTRACT, threshold: 1.5 } }),
        );
        await expectRejected("outcome.validation", () =>
          ctx.outcomes.createContract({ ...base, name: "f", content: { ...SUCCESS_CONTRACT, window_seconds: 0 } }),
        );
        await expectRejected("outcome.validation", () =>
          ctx.outcomes.createContract({ ...base, name: "g", content: { ...SUCCESS_CONTRACT, measurement_source: "vibes" } }),
        );
        await expectRejected("outcome.validation", () =>
          ctx.outcomes.createContract({ ...base, name: "h", content: { ...SUCCESS_CONTRACT, direction: "sideways" } }),
        );
        // Latency cost threshold must be positive.
        await expectRejected("outcome.validation", () =>
          ctx.outcomes.createContract({
            ...base, name: "i",
            content: { ...SUCCESS_CONTRACT, metric: "latency", unit: "ms", threshold: 0 },
          }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });
});

describe("WORK-011 goals + objectives (real PostgreSQL)", () => {
  it("goal → version (objectives + exact contract ref) → activate; immutability; active version; duplicates", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const tenant = await makeTenant(ctx, "g1");
        // Contract first (the exact measurement definition).
        const contract = await ctx.outcomes.createContract({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          name: "acceptance", content: SUCCESS_CONTRACT, actingPrincipal: tenant.adminP,
        });
        await ctx.outcomes.transitionVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          contractId: contract.contractId, version: "1", toStatus: "active", actingPrincipal: tenant.adminP,
        });

        // Goal + version with composite objectives (hard + preference).
        const goal = await ctx.goals.createGoal({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          name: "maximize-acceptance", description: "Accept as much as possible",
          actingPrincipal: tenant.adminP,
        });
        expect(goal.name).toBe("maximize-acceptance");
        await expectRejected("goal.duplicate", () =>
          ctx.goals.createGoal({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            name: "Maximize-Acceptance", actingPrincipal: tenant.adminP,
          }),
        );

        const v1 = await ctx.goals.createVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          goalId: goal.id,
          objectives: [
            { direction: "maximize", metric: "success_rate", kind: "hard", target: 0.99, unit: "ratio" },
            { direction: "maximize", metric: "success_rate", kind: "preference", notes: "the more the better" },
          ],
          outcomeContractId: contract.contractId,
          outcomeContractVersion: "1",
          actingPrincipal: tenant.adminP,
        });
        expect(v1.version).toBe("1");
        expect(v1.status).toBe("draft");
        expect(v1.objectives.length).toBe(2);
        expect(v1.objectives[0]!.id).toBe("obj_1");
        expect(v1.objectives[0]!.kind).toBe("hard");
        expect(v1.objectives[0]!.target).toBe(0.99);
        expect(v1.objectives[1]!.kind).toBe("preference");
        expect(v1.outcomeContractId).toBe(contract.contractId);

        // Draft update; publish; immutability.
        await ctx.goals.updateDraftVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          goalId: goal.id, version: "1",
          objectives: [{ direction: "maximize", metric: "success_rate", kind: "hard", target: 0.995 }],
          actingPrincipal: tenant.adminP,
        });
        await ctx.goals.transitionVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          goalId: goal.id, version: "1", toStatus: "active", actingPrincipal: tenant.adminP,
        });
        await expectRejected("goal.version.immutable", () =>
          ctx.goals.updateDraftVersion({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            goalId: goal.id, version: "1",
            objectives: [{ direction: "maximize", metric: "success_rate", kind: "hard" }],
            actingPrincipal: tenant.adminP,
          }),
        );
        const active = await ctx.goals.getActiveVersion(
          tenant.organizationId, tenant.projectId, goal.id, tenant.memberP,
        );
        expect(active?.version).toBe("1");
        expect(active?.objectives[0]!.target).toBe(0.995);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("objective validation: directions, kinds, metric vocabulary, family rules, duplicates, caps, contract compatibility", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const tenant = await makeTenant(ctx, "gv");
        const contract = await ctx.outcomes.createContract({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          name: "acceptance", content: SUCCESS_CONTRACT, actingPrincipal: tenant.adminP,
        });
        const goal = await ctx.goals.createGoal({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          name: "g", actingPrincipal: tenant.adminP,
        });
        const base = {
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          goalId: goal.id,
          outcomeContractId: contract.contractId,
          outcomeContractVersion: "1",
          actingPrincipal: tenant.adminP,
        };

        // Invalid direction / kind / metric / target / unit.
        await expectRejected("goal.objectives.invalid", () =>
          ctx.goals.createVersion({ ...base, objectives: [{ direction: "increase", metric: "success_rate", kind: "hard" }] }),
        );
        await expectRejected("goal.objectives.invalid", () =>
          ctx.goals.createVersion({ ...base, objectives: [{ direction: "maximize", metric: "success_rate", kind: "soft" }] }),
        );
        await expectRejected("goal.objectives.invalid", () =>
          ctx.goals.createVersion({ ...base, objectives: [{ direction: "maximize", metric: "happiness", kind: "hard" }] }),
        );
        await expectRejected("goal.objectives.invalid", () =>
          ctx.goals.createVersion({ ...base, objectives: [{ direction: "maximize", metric: "success_rate", kind: "hard", target: 1.5 }] }),
        );
        await expectRejected("goal.objectives.invalid", () =>
          ctx.goals.createVersion({ ...base, objectives: [{ direction: "maximize", metric: "success_rate", kind: "hard", unit: "ms" }] }),
        );
        // Nonsensical direction/metric pairings.
        await expectRejected("goal.objectives.invalid", () =>
          ctx.goals.createVersion({ ...base, objectives: [{ direction: "minimize", metric: "success_rate", kind: "hard" }] }),
        );
        await expectRejected("goal.objectives.invalid", () =>
          ctx.goals.createVersion({ ...base, objectives: [{ direction: "maximize", metric: "error_rate", kind: "hard" }] }),
        );
        // Exact-duplicate objectives rejected (hard + preference on the
        // same metric is a LEGAL composite — the WORK-008 precedent).
        await expectRejected("goal.objectives.invalid", () =>
          ctx.goals.createVersion({
            ...base,
            objectives: [
              { direction: "maximize", metric: "success_rate", kind: "hard" },
              { direction: "maximize", metric: "success_rate", kind: "hard" },
            ],
          }),
        );
        // Empty.
        await expectRejected("goal.objectives.invalid", () => ctx.goals.createVersion({ ...base, objectives: [] }));

        // Contract compatibility: metric not measured by the contract.
        await expectRejected("goal.outcome_contract.mismatch", () =>
          ctx.goals.createVersion({
            ...base,
            objectives: [{ direction: "minimize", metric: "cost", kind: "hard" }],
          }),
        );
        // Unknown contract reference.
        await expectRejected("goal.outcome_contract.not_found", () =>
          ctx.goals.createVersion({
            ...base, outcomeContractId: "oc_missing", outcomeContractVersion: "1",
            objectives: [{ direction: "maximize", metric: "success_rate", kind: "hard" }],
          }),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("TENANCY: cross-org/cross-project rejected; member reads, admin mutates; suspended/removed members lose access", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const tenantA = await makeTenant(ctx, "gta");
        const tenantB = await makeTenant(ctx, "gtb");
        const contract = await ctx.outcomes.createContract({
          organizationId: tenantA.organizationId, projectId: tenantA.projectId,
          name: "c", content: SUCCESS_CONTRACT, actingPrincipal: tenantA.adminP,
        });
        const goal = await ctx.goals.createGoal({
          organizationId: tenantA.organizationId, projectId: tenantA.projectId,
          name: "g", actingPrincipal: tenantA.adminP,
        });

        // Cross-org: org B's admin fails scope resolution.
        await expectRejected("goal.project.not_found", () =>
          ctx.goals.getGoal(tenantB.organizationId, tenantA.projectId, goal.id, tenantB.adminP).then((g) => { void g; }),
        );
        // Cross-project within the org.
        const otherProject = await ctx.projects.createProject({
          organizationId: tenantA.organizationId, name: "Other", slug: `other-${Date.now()}`,
          createdByUserId: tenantA.ownerUserId, actingPrincipal: tenantA.ownerP,
        });
        expect(await ctx.goals.getGoal(tenantA.organizationId, otherProject.id, goal.id, tenantA.adminP)).toBeNull();
        // Non-member mutation refused.
        await expectRejected("goal.membership.required", () =>
          ctx.goals.createGoal({
            organizationId: tenantA.organizationId, projectId: tenantA.projectId,
            name: "intrusion", actingPrincipal: tenantB.adminP,
          }),
        );
        // Member reads; cannot mutate.
        expect(await ctx.goals.getGoal(tenantA.organizationId, tenantA.projectId, goal.id, tenantA.memberP)).not.toBeNull();
        await expectRejected("goal.role.required", () =>
          ctx.goals.createGoal({
            organizationId: tenantA.organizationId, projectId: tenantA.projectId,
            name: "member-made", actingPrincipal: tenantA.memberP,
          }),
        );
        await expectRejected("outcome.role.required", () =>
          ctx.outcomes.createContract({
            organizationId: tenantA.organizationId, projectId: tenantA.projectId,
            name: "member-made", content: SUCCESS_CONTRACT, actingPrincipal: tenantA.memberP,
          }),
        );
        // Suspended member loses access.
        await ctx.orgs.updateMembershipState({
          organizationId: tenantA.organizationId, userId: tenantA.memberUserId,
          status: "suspended", actingPrincipal: tenantA.ownerP,
        });
        const suspendedP = await ctx.orgs.buildPrincipalForUser(tenantA.memberUserId);
        await expectRejected("goal.membership.required", () =>
          ctx.goals.getGoal(tenantA.organizationId, tenantA.projectId, goal.id, suspendedP).then((g) => { void g; }),
        );
        // Removed member likewise.
        await ctx.orgs.updateMembershipState({
          organizationId: tenantA.organizationId, userId: tenantA.memberUserId,
          status: "removed", actingPrincipal: tenantA.ownerP,
        });
        const removedP = await ctx.orgs.buildPrincipalForUser(tenantA.memberUserId);
        await expectRejected("goal.membership.required", () =>
          ctx.goals.getGoal(tenantA.organizationId, tenantA.projectId, goal.id, removedP).then((g) => { void g; }),
        );
        void contract;
      } finally {
        await ctx.cleanup();
      }
    });
  });

  it("CONCURRENCY: duplicate goal creation + concurrent version activation resolve via DB uniqueness", async () => {
    await withInfra(async (handle) => {
      const ctx = await setup(handle);
      try {
        const tenant = await makeTenant(ctx, "gc");
        await Promise.all([
          ctx.capabilities.isCapabilityAdmin("warmup"),
          ctx.capabilities.isCapabilityAdmin("warmup"),
          ctx.capabilities.isCapabilityAdmin("warmup"),
        ]);
        const results = await Promise.allSettled([
          ctx.goals.createGoal({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            name: "race", actingPrincipal: tenant.adminP,
          }),
          ctx.goals.createGoal({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            name: "race", actingPrincipal: tenant.adminP,
          }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);

        const goalId = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value.id;
        const contract = await ctx.outcomes.createContract({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          name: "c", content: SUCCESS_CONTRACT, actingPrincipal: tenant.adminP,
        });
        // Two versions, raced activation: exactly one ACTIVE row afterwards.
        const v1 = await ctx.goals.createVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          goalId, objectives: [{ direction: "maximize", metric: "success_rate", kind: "hard" }],
          outcomeContractId: contract.contractId, outcomeContractVersion: "1",
          actingPrincipal: tenant.adminP,
        });
        const v2 = await ctx.goals.createVersion({
          organizationId: tenant.organizationId, projectId: tenant.projectId,
          goalId, objectives: [{ direction: "maximize", metric: "success_rate", kind: "hard", target: 0.999 }],
          outcomeContractId: contract.contractId, outcomeContractVersion: "1",
          actingPrincipal: tenant.adminP,
        });
        await Promise.allSettled([
          ctx.goals.transitionVersion({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            goalId, version: v1.version, toStatus: "active", actingPrincipal: tenant.adminP,
          }),
          ctx.goals.transitionVersion({
            organizationId: tenant.organizationId, projectId: tenant.projectId,
            goalId, version: v2.version, toStatus: "active", actingPrincipal: tenant.adminP,
          }),
        ]);
        const rows = await ctx.db.query({
          text: `SELECT version FROM cp_goal_versions WHERE goal_id = $1 AND status = 'active'`,
          params: [goalId],
        });
        expect(rows.length).toBe(1);
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
