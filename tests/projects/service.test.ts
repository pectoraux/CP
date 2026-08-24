// tests/projects/service.test.ts — ProjectsService against REAL PostgreSQL
// (WORK-004 PROJ-001, project-level tenant scoping, §concurrency, §pagination).
// Uses the WORK-002 withInfra harness. No mocks for persistence.
//
// Covers:
//   - project creation (any active org member; project belongs to org)
//   - duplicate slug in the same org fails (DB constraint, not silent)
//   - the same slug in a DIFFERENT org succeeds (slug scoped per org)
//   - non-member cannot create (POLICY_BLOCKED not_a_member)
//   - cross-org project id substitution returns null (no row leak)
//   - cursor pagination: pages advance without skip/dup, has_more correct
//   - archived projects excluded by default; includeArchived includes them
//   - update requires admin/owner; member rejected
//   - archive requires owner; admin rejected; idempotent on already-archived
//   - resolveProjectContext: in-org project passes; cross-org rejected
//   - concurrency: two parallel createProject with the same slug → one fails
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase, AppError } from "@cp/platform";
import {
  AuthService,
  migrateAuthSchema,
  buildPrincipal,
} from "@cp/auth";
import {
  OrganizationsService,
  migrateOrganizationsSchema,
} from "@cp/organizations";
import {
  ProjectsService,
  migrateProjectsSchema,
} from "@cp/projects";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-projects",
  });
  await migrateAuthSchema(db);
  await migrateOrganizationsSchema(db);
  await migrateProjectsSchema(db);
  const auth = new AuthService({ db });
  const orgs = new OrganizationsService({ db });
  const projects = new ProjectsService({ db });
  const cleanup = async () => { await db.close(); };
  return { db, auth, orgs, projects, cleanup };
}

async function makeUser(auth: AuthService, n: number) {
  return auth.createUser({
    email: `puser${n}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: "password123",
  });
}

async function freshPrincipal(orgs: OrganizationsService, userId: string) {
  // Re-load memberships so the principal reflects the latest role/status
  // (mirrors what the /api auth middleware does via buildPrincipalForUser).
  return orgs.buildPrincipalForUser(userId);
}

describe("ProjectsService (real PostgreSQL)", () => {
  it("creates a project as an org member; project belongs to the org", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, projects, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id,
          name: "Acme",
          slug: `acme-${Date.now()}`,
        });
        const p = await orgs.buildPrincipalForUser(owner.id);
        const project = await projects.createProject({
          organizationId: organization.id,
          name: "Proj 1",
          slug: `proj1-${Date.now()}`,
          createdByUserId: owner.id,
          actingPrincipal: p,
        });
        expect(project.id.startsWith("proj_")).toBe(true);
        expect(project.organizationId).toBe(organization.id);
        expect(project.status).toBe("active");
        expect(project.createdByUserId).toBe(owner.id);
      } finally {
        await cleanup();
      }
    });
  });

  it("duplicate slug in the same org fails with POLICY_BLOCKED (DB constraint)", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, projects, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id,
          name: "Acme",
          slug: `acme-${Date.now()}`,
        });
        const p = await orgs.buildPrincipalForUser(owner.id);
        const slug = `same-${Date.now()}`;
        await projects.createProject({
          organizationId: organization.id, name: "A", slug,
          createdByUserId: owner.id, actingPrincipal: p,
        });
        let threw = false;
        try {
          await projects.createProject({
            organizationId: organization.id, name: "B", slug,
            createdByUserId: owner.id, actingPrincipal: p,
          });
        } catch (err) {
          threw = true;
          expect(err).toBeInstanceOf(AppError);
          expect((err as AppError).category).toBe("POLICY_BLOCKED");
          expect((err as AppError).code).toBe("project.policy");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("the same slug in a DIFFERENT org succeeds (slug scoped per org)", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, projects, cleanup } = await setup(handle);
      try {
        const ownerA = await makeUser(auth, 1);
        const ownerB = await makeUser(auth, 2);
        const { organization: orgA } = await orgs.createOrganizationWithOwner({
          ownerUserId: ownerA.id, name: "A", slug: `oa-${Date.now()}`,
        });
        const { organization: orgB } = await orgs.createOrganizationWithOwner({
          ownerUserId: ownerB.id, name: "B", slug: `ob-${Date.now()}`,
        });
        const slug = `shared-slug-${Date.now()}`;
        const pA = await orgs.buildPrincipalForUser(ownerA.id);
        const pB = await orgs.buildPrincipalForUser(ownerB.id);
        const projA = await projects.createProject({
          organizationId: orgA.id, name: "PA", slug,
          createdByUserId: ownerA.id, actingPrincipal: pA,
        });
        const projB = await projects.createProject({
          organizationId: orgB.id, name: "PB", slug,
          createdByUserId: ownerB.id, actingPrincipal: pB,
        });
        expect(projA.organizationId).toBe(orgA.id);
        expect(projB.organizationId).toBe(orgB.id);
      } finally {
        await cleanup();
      }
    });
  });

  it("a non-member cannot create a project (POLICY_BLOCKED not_a_member)", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, projects, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const outsider = await makeUser(auth, 2);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `acme-${Date.now()}`,
        });
        const outsiderP = buildPrincipal(outsider.id, []);
        let threw = false;
        try {
          await projects.createProject({
            organizationId: organization.id, name: "X", slug: `x-${Date.now()}`,
            createdByUserId: outsider.id, actingPrincipal: outsiderP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).category).toBe("POLICY_BLOCKED");
          expect((err as AppError).details?.reason).toBe("not_a_member");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("cross-org project id substitution returns null (no row leak)", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, projects, cleanup } = await setup(handle);
      try {
        const ownerA = await makeUser(auth, 1);
        const ownerB = await makeUser(auth, 2);
        const { organization: orgA } = await orgs.createOrganizationWithOwner({
          ownerUserId: ownerA.id, name: "A", slug: `oa-${Date.now()}`,
        });
        const { organization: orgB } = await orgs.createOrganizationWithOwner({
          ownerUserId: ownerB.id, name: "B", slug: `ob-${Date.now()}`,
        });
        const pA = await orgs.buildPrincipalForUser(ownerA.id);
        const projA = await projects.createProject({
          organizationId: orgA.id, name: "PA", slug: `pa-${Date.now()}`,
          createdByUserId: ownerA.id, actingPrincipal: pA,
        });
        // Fetch projA from orgB's perspective → null (belongs to orgA).
        const leaked = await projects.getProject(orgB.id, projA.id);
        expect(leaked).toBeNull();
        // resolveProjectContext for projA under orgB → POLICY_BLOCKED.
        let threw = false;
        try {
          await projects.resolveProjectContext(orgB.id, projA.id);
        } catch (err) {
          threw = true;
          expect((err as AppError).code).toBe("project.not_found");
        }
        expect(threw).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  it("cursor pagination advances without skip/dup; has_more correct", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, projects, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `acme-${Date.now()}`,
        });
        const p = await orgs.buildPrincipalForUser(owner.id);
        // Create 7 projects; page by 3 → 3,3,1.
        const N = 7;
        const created: string[] = [];
        for (let i = 0; i < N; i++) {
          const proj = await projects.createProject({
            organizationId: organization.id,
            name: `P${i}`,
            slug: `p${i}-${Date.now()}-${i}`,
            createdByUserId: owner.id,
            actingPrincipal: p,
          });
          created.push(proj.id);
        }
        // Page through with limit=3.
        const seen: string[] = [];
        let cursor: string | undefined = undefined;
        let pages = 0;
        for (;;) {
          const page = await projects.listProjects(organization.id, { limit: 3, cursor });
          pages++;
          for (const proj of page.projects) seen.push(proj.id);
          if (!page.page.has_more) break;
          cursor = page.page.next_cursor ?? undefined;
          if (pages > 10) throw new Error("pagination did not terminate");
        }
        expect(seen.length).toBe(N);
        // No duplicates.
        expect(new Set(seen).size).toBe(N);
        // Every created project was returned.
        for (const id of created) expect(seen).toContain(id);
      } finally {
        await cleanup();
      }
    });
  });

  it("archived projects excluded by default; includeArchived includes them", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, projects, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `acme-${Date.now()}`,
        });
        const p = await orgs.buildPrincipalForUser(owner.id);
        const active = await projects.createProject({
          organizationId: organization.id, name: "Active", slug: `a-${Date.now()}`,
          createdByUserId: owner.id, actingPrincipal: p,
        });
        const toArchive = await projects.createProject({
          organizationId: organization.id, name: "ToArchive", slug: `b-${Date.now()}`,
          createdByUserId: owner.id, actingPrincipal: p,
        });
        await projects.archiveProject({
          organizationId: organization.id, projectId: toArchive.id, actingPrincipal: p,
        });
        const def = await projects.listProjects(organization.id, { limit: 100 });
        const ids = def.projects.map((x) => x.id);
        expect(ids).toContain(active.id);
        expect(ids).not.toContain(toArchive.id);
        const incl = await projects.listProjects(organization.id, { limit: 100, includeArchived: true });
        const ids2 = incl.projects.map((x) => x.id);
        expect(ids2).toContain(active.id);
        expect(ids2).toContain(toArchive.id);
      } finally {
        await cleanup();
      }
    });
  });

  it("update requires admin/owner; a plain member is rejected", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, projects, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const member = await makeUser(auth, 2);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `acme-${Date.now()}`,
        });
        // Owner invites member.
        const ownerP = await freshPrincipal(orgs, owner.id);
        await orgs.addMember({
          organizationId: organization.id, userId: member.id, role: "member",
          actingPrincipal: ownerP,
        });
        const memberP = await freshPrincipal(orgs, member.id);
        const proj = await projects.createProject({
          organizationId: organization.id, name: "P", slug: `p-${Date.now()}`,
          createdByUserId: owner.id, actingPrincipal: ownerP,
        });
        // Member cannot update.
        let threw = false;
        try {
          await projects.updateProject({
            organizationId: organization.id, projectId: proj.id, name: "Renamed",
            actingPrincipal: memberP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).details?.reason).toBe("insufficient_role");
        }
        expect(threw).toBe(true);
        // Owner can update.
        const ownerP2 = await freshPrincipal(orgs, owner.id);
        const updated = await projects.updateProject({
          organizationId: organization.id, projectId: proj.id, name: "Renamed",
          actingPrincipal: ownerP2,
        });
        expect(updated.name).toBe("Renamed");
      } finally {
        await cleanup();
      }
    });
  });

  it("archive requires owner; an admin is rejected; idempotent on already-archived", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, projects, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const admin = await makeUser(auth, 2);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `acme-${Date.now()}`,
        });
        const ownerP = await freshPrincipal(orgs, owner.id);
        await orgs.addMember({
          organizationId: organization.id, userId: admin.id, role: "admin",
          actingPrincipal: ownerP,
        });
        const proj = await projects.createProject({
          organizationId: organization.id, name: "P", slug: `p-${Date.now()}`,
          createdByUserId: owner.id, actingPrincipal: ownerP,
        });
        // Admin cannot archive.
        const adminP = await freshPrincipal(orgs, admin.id);
        let threw = false;
        try {
          await projects.archiveProject({
            organizationId: organization.id, projectId: proj.id, actingPrincipal: adminP,
          });
        } catch (err) {
          threw = true;
          expect((err as AppError).details?.reason).toBe("insufficient_role");
        }
        expect(threw).toBe(true);
        // Owner archives.
        const ownerP2 = await freshPrincipal(orgs, owner.id);
        const archived = await projects.archiveProject({
          organizationId: organization.id, projectId: proj.id, actingPrincipal: ownerP2,
        });
        expect(archived.status).toBe("archived");
        // Idempotent: archiving again returns the archived record without error.
        const ownerP3 = await freshPrincipal(orgs, owner.id);
        const again = await projects.archiveProject({
          organizationId: organization.id, projectId: proj.id, actingPrincipal: ownerP3,
        });
        expect(again.status).toBe("archived");
      } finally {
        await cleanup();
      }
    });
  });

  it("concurrent createProject with the same slug: exactly one succeeds", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, projects, cleanup } = await setup(handle);
      try {
        const owner = await makeUser(auth, 1);
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "Acme", slug: `acme-${Date.now()}`,
        });
        const p = await orgs.buildPrincipalForUser(owner.id);
        const slug = `race-${Date.now()}`;
        const results = await Promise.allSettled([
          projects.createProject({
            organizationId: organization.id, name: "A", slug,
            createdByUserId: owner.id, actingPrincipal: p,
          }),
          projects.createProject({
            organizationId: organization.id, name: "B", slug,
            createdByUserId: owner.id, actingPrincipal: p,
          }),
        ]);
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const fail = results.filter((r) => r.status === "rejected").length;
        expect(ok).toBe(1);
        expect(fail).toBe(1);
        // The failure must be a structured POLICY_BLOCKED (duplicate_slug),
        // not a generic PLATFORM_FAILURE.
        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        const err = rejected.reason as AppError;
        expect(err.category).toBe("POLICY_BLOCKED");
        expect(err.details?.reason).toBe("duplicate_slug");
      } finally {
        await cleanup();
      }
    });
  });
});
