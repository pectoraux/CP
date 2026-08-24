// tests/security/project-tenant-isolation.test.ts — WORK-004 project-level
// tenant isolation (architecture §2.16, §34, lock §10, WORK-004 §project-
// level tenant scoping). All cases use REAL PostgreSQL (withInfra). No mocks.
//
// The project-level tenant-scoping rule under test:
//   - the :orgId in the path is resolved by the WORK-003 org gate
//     (principal must be an ACTIVE member);
//   - the :projectId in the path is a REQUESTED TARGET only; the
//     projectContextMiddleware verifies the project belongs to the AUTHORIZED
//     org. A cross-org project id substitution is rejected
//     (POLICY_BLOCKED / project.not_found) — the existence of a project in a
//     different org is never leaked.
//
// Covers:
//   1. cross-org access: User B (not in Org A) → GET orgA's project → 403
//   2. cross-org project id substitution: User A (in Org A) puts Org B's
//      project id under Org A's path → 403 (project.not_found)
//   3. missing authentication on a project route → 401
//   4. a suspended member loses project access immediately (org gate
//      rejects suspended memberships; project routes inherit this)
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { createApi } from "@cp/api";
import { CapturingLogSink } from "../helpers.ts";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-proj-sec",
  });
  const sink = new CapturingLogSink();
  const api = createApi({ loggerSink: sink, db });
  await api.migrate();
  const cleanup = async () => {
    await api.runtime.queue.stop();
    await db.close();
  };
  return { db, api, app: api.app, orgs: api.orgs, auth: api.auth, cleanup };
}

async function registerLogin(
  app: ReturnType<typeof createApi>["app"],
  email: string,
): Promise<string> {
  await app.request("/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const sess = await app.request("/v1/auth/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  return ((await sess.json()) as { api_key: string }).api_key;
}

async function createOrg(
  app: ReturnType<typeof createApi>["app"],
  key: string,
  slug: string,
): Promise<string> {
  const res = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ name: `Org ${slug}`, slug }),
  });
  return ((await res.json()) as { organization: { id: string } }).organization.id;
}

async function createProject(
  app: ReturnType<typeof createApi>["app"],
  key: string,
  orgId: string,
  slug: string,
): Promise<string> {
  const res = await app.request(`/v1/organizations/${orgId}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ name: `Proj ${slug}`, slug }),
  });
  return ((await res.json()) as { project: { id: string } }).project.id;
}

describe("WORK-004 project-level tenant isolation (real PG)", () => {
  it("cross-org access: a user not in Org A cannot read Org A's project (403)", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        const keyA = await registerLogin(app, `sec-a-${t}@e.com`);
        const keyB = await registerLogin(app, `sec-b-${t}@e.com`);
        const orgA = await createOrg(app, keyA, `oa-${t}`);
        const projA = await createProject(app, keyA, orgA, `pa-${t}`);

        // User B is not a member of Org A. The org gate (orgContextMiddleware)
        // rejects with 403 POLICY_BLOCKED before the project is even resolved.
        const bReadsA = await app.request(`/v1/organizations/${orgA}/projects/${projA}`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyB}` },
        });
        expect(bReadsA.status).toBe(403);
        const body = (await bReadsA.json()) as { error: { category: string; code: string } };
        expect(body.error.category).toBe("POLICY_BLOCKED");
      } finally {
        await cleanup();
      }
    });
  });

  it("cross-org project id substitution: Org B's project under Org A's path → 403 (project.not_found, no leak)", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        // User A owns Org A; User B owns Org B.
        const keyA = await registerLogin(app, `sub-a-${t}@e.com`);
        const keyB = await registerLogin(app, `sub-b-${t}@e.com`);
        const orgA = await createOrg(app, keyA, `suboa-${t}`);
        const orgB = await createOrg(app, keyB, `subob-${t}`);
        const projB = await createProject(app, keyB, orgB, `pb-${t}`);

        // User A IS a member of Org A (the owner), so the org gate passes.
        // But projB belongs to Org B, not Org A. The project-level gate
        // (projectContextMiddleware) verifies project.organization_id ===
        // authorizedOrgId; it does NOT, so the request is rejected with
        // project.not_found (403). The existence of projB in Org B is not
        // leaked to User A.
        const aReadsB = await app.request(`/v1/organizations/${orgA}/projects/${projB}`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyA}` },
        });
        expect(aReadsB.status).toBe(403);
        const body = (await aReadsB.json()) as { error: { code: string; details?: { reason?: string } } };
        expect(body.error.code).toBe("project.not_found");
        expect(body.error.details?.reason).toBe("no_such_project");
      } finally {
        await cleanup();
      }
    });
  });

  it("missing authentication on a project route → 401", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        const keyA = await registerLogin(app, `noauth-${t}@e.com`);
        const orgA = await createOrg(app, keyA, `noauth-oa-${t}`);
        const projA = await createProject(app, keyA, orgA, `noauth-pa-${t}`);

        // No Authorization header → 401 (the org gate requires a principal).
        const noAuth = await app.request(`/v1/organizations/${orgA}/projects/${projA}`, {
          method: "GET",
        });
        expect(noAuth.status).toBe(401);
        const body = (await noAuth.json()) as { error: { category: string; code: string } };
        expect(body.error.category).toBe("CREDENTIAL_FAILURE");

        // Same on the list endpoint.
        const noAuthList = await app.request(`/v1/organizations/${orgA}/projects`, {
          method: "GET",
        });
        expect(noAuthList.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  });

  it("a suspended member immediately loses project access (org gate rejects)", async () => {
    await withInfra(async (handle) => {
      const { app, orgs, auth, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        const keyOwner = await registerLogin(app, `susp-o-${t}@e.com`);
        const keyMember = await registerLogin(app, `susp-m-${t}@e.com`);
        const orgA = await createOrg(app, keyOwner, `suspoa-${t}`);
        const projA = await createProject(app, keyOwner, orgA, `suspp-${t}`);

        // Owner invites the member. Resolve user ids from their session
        // keys via the auth service (server-side; the path param is the
        // only thing that comes from the request, never the identity).
        const memberUserId = (await auth.verifyApiKey(keyMember)).userId;
        const ownerPrincipal = await orgs.buildPrincipalForUser((await auth.verifyApiKey(keyOwner)).userId);
        await orgs.addMember({
          organizationId: orgA,
          userId: memberUserId,
          role: "member",
          actingPrincipal: ownerPrincipal,
        });

        // Member can read the project before suspension.
        const before = await app.request(`/v1/organizations/${orgA}/projects/${projA}`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyMember}` },
        });
        expect(before.status).toBe(200);

        // Owner suspends the member.
        const ownerPrincipal2 = await orgs.buildPrincipalForUser((await auth.verifyApiKey(keyOwner)).userId);
        await orgs.updateMembershipState({
          organizationId: orgA,
          userId: memberUserId,
          status: "suspended",
          actingPrincipal: ownerPrincipal2,
        });

        // Member's long-lived credential is still valid (not revoked), but
        // the org gate re-resolves membership on every request and rejects
        // the now-suspended membership → 403.
        const after = await app.request(`/v1/organizations/${orgA}/projects/${projA}`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyMember}` },
        });
        expect(after.status).toBe(403);
        const body = (await after.json()) as { error: { details?: { reason?: string } } };
        expect(body.error.details?.reason).toBe("membership_suspended");
      } finally {
        await cleanup();
      }
    });
  });
});
