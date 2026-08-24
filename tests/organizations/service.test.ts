// tests/organizations/service.test.ts — OrganizationsService against REAL
// PostgreSQL (WORK-003 §17 ORGANIZATION, §10 concurrency). Uses the
// WORK-002 withInfra harness. No mocks for persistence.
//
// Covers:
//   - organization creation (transactional org + owner membership)
//   - initial membership is owner + active
//   - membership uniqueness (DB constraint, not silent)
//   - membership state transitions (active → suspended → active)
//   - role assignment + the last-owner invariant
//   - resolveOrgContext: active member passes; non-member fails;
//     suspended member fails
//   - permission evaluation: member cannot manage; owner can
//   - concurrency: two parallel adds of the same (org, user) → one fails
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase, AppError } from "@cp/platform";
import {
  AuthService,
  migrateAuthSchema,
  buildPrincipal,
  hasPermission,
} from "@cp/auth";
import {
  OrganizationsService,
  migrateOrganizationsSchema,
  ORG_PERMISSIONS,
} from "@cp/organizations";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-org",
  });
  await migrateAuthSchema(db);
  await migrateOrganizationsSchema(db);
  const auth = new AuthService({ db });
  const orgs = new OrganizationsService({ db });
  const cleanup = async () => { await db.close(); };
  return { db, auth, orgs, cleanup };
}

async function makeUser(auth: AuthService, n: number) {
  return auth.createUser({
    email: `user${n}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: "password123",
  });
}

describe("OrganizationsService (real PostgreSQL)", () => {
  it("creates an organization with an initial owner membership atomically", async () => {
    await withInfra(async (handle) => {
      const { db, auth, orgs, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const { organization, ownerMembership } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id,
          name: "Acme",
          slug: `acme-${Date.now()}`,
        });
        expect(organization.id.startsWith("org_")).toBe(true);
        expect(ownerMembership.role).toBe("owner");
        expect(ownerMembership.status).toBe("active");
        expect(ownerMembership.userId).toBe(owner.id);
        // The org + membership both committed (no orphan rows).
        const refetched = await orgs.getOrganization(organization.id);
        expect(refetched?.id).toBe(organization.id);
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        const members = await orgs.listMembers(organization.id, ownerP);
        expect(members.length).toBe(1);
        void db;
      } finally {
        await cleanup();
      }
    });
  });

  it("rejects a duplicate slug (DB unique constraint → POLICY_BLOCKED)", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const slug = `dup-${Date.now()}`;
        await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "First", slug,
        });
        const owner2 = await makeUser(auth, 2);
        await expect(
          orgs.createOrganizationWithOwner({
            ownerUserId: owner2.id, name: "Second", slug,
          }),
        ).rejects.toMatchObject({ category: "POLICY_BLOCKED" });
      } finally {
        await cleanup();
      }
    });
  });

  it("membership is unique per (org, user) — duplicate add fails", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const member = await makeUser(auth, 2);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `a-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        await orgs.addMember({
          organizationId: organization.id, userId: member.id, role: "member",
          actingPrincipal: ownerP,
        });
        // Second add of the same user → POLICY_BLOCKED.
        await expect(
          orgs.addMember({
            organizationId: organization.id, userId: member.id, role: "member",
            actingPrincipal: ownerP,
          }),
        ).rejects.toMatchObject({ category: "POLICY_BLOCKED" });
      } finally {
        await cleanup();
      }
    });
  });

  it("concurrent duplicate adds: exactly one succeeds, one fails", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const member = await makeUser(auth, 2);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `c-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        // Fire two adds in parallel.
        const results = await Promise.allSettled([
          orgs.addMember({
            organizationId: organization.id, userId: member.id, role: "member",
            actingPrincipal: ownerP,
          }),
          orgs.addMember({
            organizationId: organization.id, userId: member.id, role: "member",
            actingPrincipal: ownerP,
          }),
        ]);
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect((rejected[0] as PromiseRejectedResult).reason.category).toBe("POLICY_BLOCKED");
      } finally {
        await cleanup();
      }
    });
  });

  it("membership state transitions: active → suspended → active", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const member = await makeUser(auth, 2);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `t-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        await orgs.addMember({
          organizationId: organization.id, userId: member.id, role: "member",
          actingPrincipal: ownerP,
        });
        // Suspend.
        const suspended = await orgs.updateMembershipState({
          organizationId: organization.id, userId: member.id, status: "suspended",
          actingPrincipal: ownerP,
        });
        expect(suspended.status).toBe("suspended");
        // Reinstate.
        const active = await orgs.updateMembershipState({
          organizationId: organization.id, userId: member.id, status: "active",
          actingPrincipal: ownerP,
        });
        expect(active.status).toBe("active");
      } finally {
        await cleanup();
      }
    });
  });

  it("role changes: owner promotes member to admin; last-owner demotion blocked", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const member = await makeUser(auth, 2);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `r-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        await orgs.addMember({
          organizationId: organization.id, userId: member.id, role: "member",
          actingPrincipal: ownerP,
        });
        // Promote member to admin.
        const promoted = await orgs.updateRole({
          organizationId: organization.id, userId: member.id, role: "admin",
          actingPrincipal: ownerP,
        });
        expect(promoted.role).toBe("admin");
        // Owner cannot demote themselves (last owner).
        await expect(
          orgs.updateRole({
            organizationId: organization.id, userId: owner.id, role: "member",
            actingPrincipal: ownerP,
          }),
        ).rejects.toMatchObject({ category: "POLICY_BLOCKED" });
      } finally {
        await cleanup();
      }
    });
  });

  it("resolveOrgContext: active member passes; non-member fails; suspended fails", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, cleanup } = await setup(handle);
      try {
        const ownerA = await makeUser(auth, 1);
        const userB = await makeUser(auth, 2);
        const { organization: orgA } = await orgs.createOrganizationWithOwner({
          ownerUserId: ownerA.id, name: "OrgA", slug: `orga-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(ownerA.id);
        // Active member passes.
        const ctx = await orgs.resolveOrgContext(ownerP, orgA.id);
        expect(ctx.organizationId).toBe(orgA.id);
        expect(ctx.role).toBe("owner");
        // Non-member (userB) fails with POLICY_BLOCKED.
        const userBP = await orgs.buildPrincipalForUser(userB.id);
        await expect(
          orgs.resolveOrgContext(userBP, orgA.id),
        ).rejects.toMatchObject({ category: "POLICY_BLOCKED" });
        // Suspend the owner... but owner is the last owner, so add a second
        // owner first to enable suspension.
        await orgs.addMember({
          organizationId: orgA.id, userId: userB.id, role: "admin",
          actingPrincipal: ownerP,
        });
        await orgs.updateRole({
          organizationId: orgA.id, userId: userB.id, role: "owner",
          actingPrincipal: ownerP,
        });
        // Now suspend userB.
        await orgs.updateMembershipState({
          organizationId: orgA.id, userId: userB.id, status: "suspended",
          actingPrincipal: ownerP,
        });
        // userB's (now-suspended) principal — re-resolve must fail.
        const userBP2 = await orgs.buildPrincipalForUser(userB.id);
        await expect(
          orgs.resolveOrgContext(userBP2, orgA.id),
        ).rejects.toMatchObject({ category: "POLICY_BLOCKED" });
      } finally {
        await cleanup();
      }
    });
  });

  it("permission evaluation: member cannot add members; owner/admin can", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const member = await makeUser(auth, 2);
        const outsider = await makeUser(auth, 3);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `p-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        await orgs.addMember({
          organizationId: organization.id, userId: member.id, role: "member",
          actingPrincipal: ownerP,
        });
        const memberP = await orgs.buildPrincipalForUser(member.id);
        // member lacks MEMBER_INVITE → fails.
        await expect(
          orgs.addMember({
            organizationId: organization.id, userId: outsider.id, role: "member",
            actingPrincipal: memberP,
          }),
        ).rejects.toMatchObject({ category: "POLICY_BLOCKED" });
        // owner has MEMBER_INVITE → succeeds.
        await expect(
          orgs.addMember({
            organizationId: organization.id, userId: outsider.id, role: "member",
            actingPrincipal: ownerP,
          }),
        ).resolves.toBeDefined();
        // Cross-org authority does not transfer: build a fake principal
        // that is owner of a DIFFERENT org and assert it cannot add to this org.
        const owner2 = await makeUser(auth, 4);
        const { organization: orgB } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner2.id, name: "Other", slug: `other-${Date.now()}`,
        });
        const ownerBP = await orgs.buildPrincipalForUser(owner2.id);
        // owner of orgB attempts to add to orgA → POLICY_BLOCKED.
        await expect(
          orgs.addMember({
            organizationId: organization.id, userId: outsider.id, role: "member",
            actingPrincipal: ownerBP,
          }),
        ).rejects.toMatchObject({ category: "POLICY_BLOCKED" });
        void orgB;
      } finally {
        await cleanup();
      }
    });
  });

  it("buildPrincipalForUser + hasPermission: owner has DELETE; member does not", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const member = await makeUser(auth, 2);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `h-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        await orgs.addMember({
          organizationId: organization.id, userId: member.id, role: "member",
          actingPrincipal: ownerP,
        });
        const memberP = await orgs.buildPrincipalForUser(member.id);
        expect(hasPermission(ownerP, ORG_PERMISSIONS.DELETE, organization.id)).toBe(true);
        expect(hasPermission(memberP, ORG_PERMISSIONS.DELETE, organization.id)).toBe(false);
        expect(hasPermission(memberP, ORG_PERMISSIONS.READ, organization.id)).toBe(true);
        // Cross-org: owner of orgA has DELETE in orgA but NOT in some other org id.
        expect(hasPermission(ownerP, ORG_PERMISSIONS.DELETE, "org_other")).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  it("removing a member is a soft-delete (status=removed); re-resolve fails", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const member = await makeUser(auth, 2);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `rm-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        // Promote member to owner first so we can suspend the original owner.
        await orgs.addMember({
          organizationId: organization.id, userId: member.id, role: "owner",
          actingPrincipal: ownerP,
        });
        // Remove member.
        await orgs.removeMember({
          organizationId: organization.id, userId: member.id,
          actingPrincipal: ownerP,
        });
        // member's principal now resolves to a removed membership → fails.
        const memberP = await orgs.buildPrincipalForUser(member.id);
        await expect(
          orgs.resolveOrgContext(memberP, organization.id),
        ).rejects.toMatchObject({ category: "POLICY_BLOCKED" });
        // AppError type check.
        try {
          await orgs.resolveOrgContext(memberP, organization.id);
          throw new Error("unreachable");
        } catch (err) {
          expect(err).toBeInstanceOf(AppError);
        }
      } finally {
        await cleanup();
      }
    });
  });

  it("listOrganizationsForUser returns orgs the user belongs to", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const { organization: a } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "A", slug: `a-${Date.now()}`,
        });
        const { organization: b } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "B", slug: `b-${Date.now()}`,
        });
        const list = await orgs.listOrganizationsForUser(owner.id);
        expect(list.map((o) => o.id).sort()).toEqual([a.id, b.id].sort());
      } finally {
        await cleanup();
      }
    });
  });
});
