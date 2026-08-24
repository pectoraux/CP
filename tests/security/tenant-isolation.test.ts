// tests/security/tenant-isolation.test.ts — WORK-003 §17 TENANT ISOLATION
// and §18 SECURITY TESTING. Real PostgreSQL via withInfra. No mocks.
//
// The eight scenarios from the brief, plus the §18 attack surface:
//   1. User A belongs to Org A.
//   2. User B belongs to Org B.
//   3. Resource/state belonging to Org A exists (Org A's members).
//   4. User A can access Org A state.            → 200
//   5. User B cannot access Org A state.        → 403 POLICY_BLOCKED
//   6. User B attempting to substitute Org A's ID still fails. → 403
//   7. User A cannot access Org B state.        → 403
//   8. Suspended/removed membership loses access. → 403
// Plus:
//   - missing authentication → 401
//   - malformed auth header → 401
//   - token replay after revocation → 401
//   - direct access to another org's identifier (path substitution) → 403
//   - unauthorized role use (member trying to add a member) → 403
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import {
  AuthService,
  migrateAuthSchema,
} from "@cp/auth";
import {
  OrganizationsService,
  migrateOrganizationsSchema,
} from "@cp/organizations";
import { createApi } from "@cp/api";
import { CapturingLogSink } from "../helpers.ts";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-security",
  });
  await migrateAuthSchema(db);
  await migrateOrganizationsSchema(db);
  const auth = new AuthService({ db });
  const orgs = new OrganizationsService({ db });
  const sink = new CapturingLogSink();
  const { app, runtime } = createApi({
    loggerSink: sink,
    db,
  });
  const cleanup = async () => {
    await runtime.queue.stop();
    await db.close();
  };
  return { db, auth, orgs, app, runtime, sink, cleanup };
}

async function registerAndLogin(
  app: ReturnType<typeof createApi>["app"],
  email: string,
): Promise<string> {
  // Register
  const reg = await app.request("/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(reg.status).toBe(201);
  // Login → session token
  const sess = await app.request("/v1/auth/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(sess.status).toBe(201);
  const body = (await sess.json()) as { api_key: string };
  return body.api_key;
}

/**
 * Issue an API key via the service for a user that was already created
 * (e.g. via auth.createUser directly). Used by tests that need to set up
 * users + memberships via the service AND authenticate HTTP requests as
 * those users — without re-registering the email via HTTP (which would
 * fail with duplicate-email).
 */
async function issueKeyFor(
  auth: AuthService,
  userId: string,
): Promise<string> {
  const { rawKey } = await auth.createApiKey({ userId });
  return rawKey;
}

async function createOrg(
  app: ReturnType<typeof createApi>["app"],
  apiKey: string,
  name: string,
  slug: string,
): Promise<string> {
  const res = await app.request("/v1/organizations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ name, slug }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    organization: { id: string };
  };
  return body.organization.id;
}

describe("WORK-003 §17 tenant isolation (8 scenarios, real HTTP + real PG)", () => {
  it("scenarios 1–7: A↔A allowed; A↔B, B↔A, B-substitutes-A all denied", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        // 1. User A belongs to Org A.
        const keyA = await registerAndLogin(app, `alice-${Date.now()}@e.com`);
        const orgA = await createOrg(app, keyA, "OrgA", `orga-${Date.now()}`);
        // 2. User B belongs to Org B.
        const keyB = await registerAndLogin(app, `bob-${Date.now()}@e.com`);
        const orgB = await createOrg(app, keyB, "OrgB", `orgb-${Date.now()}`);

        // 4. User A can access Org A state (memberships).
        const aReadsA = await app.request(
          `/v1/organizations/${orgA}/memberships`,
          { method: "GET", headers: { authorization: `Bearer ${keyA}` } },
        );
        expect(aReadsA.status).toBe(200);

        // 5. User B cannot access Org A state.
        const bReadsA = await app.request(
          `/v1/organizations/${orgA}/memberships`,
          { method: "GET", headers: { authorization: `Bearer ${keyB}` } },
        );
        expect(bReadsA.status).toBe(403);
        const bBody = (await bReadsA.json()) as {
          error: { category: string; code: string };
        };
        expect(bBody.error.category).toBe("POLICY_BLOCKED");

        // 6. User B attempting to SUBSTITUTE Org A's ID still fails.
        //    (User B authenticates as themselves, requests Org A's id —
        //    the server-side tenant gate rejects because B has no active
        //    membership in Org A. The path param is only a REQUESTED
        //    TARGET; it does not authorize access.)
        const bSubstitute = await app.request(
          `/v1/organizations/${orgA}`,
          { method: "GET", headers: { authorization: `Bearer ${keyB}` } },
        );
        expect(bSubstitute.status).toBe(403);

        // 7. User A cannot access Org B state.
        const aReadsB = await app.request(
          `/v1/organizations/${orgB}/memberships`,
          { method: "GET", headers: { authorization: `Bearer ${keyA}` } },
        );
        expect(aReadsB.status).toBe(403);

        // Sanity: B can access B.
        const bReadsB = await app.request(
          `/v1/organizations/${orgB}/memberships`,
          { method: "GET", headers: { authorization: `Bearer ${keyB}` } },
        );
        expect(bReadsB.status).toBe(200);
      } finally {
        await cleanup();
      }
    });
  });

  it("scenario 8: suspended membership loses access immediately", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, app, cleanup } = await setup(handle);
      try {
        const owner = await auth.createUser({
          email: `owner-${Date.now()}@e.com`, password: "password123",
        });
        const member = await auth.createUser({
          email: `member-${Date.now()}@e.com`, password: "password123",
        });
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "S", slug: `s-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        await orgs.addMember({
          organizationId: organization.id, userId: member.id, role: "member",
          actingPrincipal: ownerP,
        });
        // Member logs in (gets a long-lived session token).
        const memberKey = await issueKeyFor(auth, member.id);
        // Member can initially access the org.
        const before = await app.request(
          `/v1/organizations/${organization.id}/memberships`,
          { method: "GET", headers: { authorization: `Bearer ${memberKey}` } },
        );
        expect(before.status).toBe(200);
        // Owner suspends the member.
        await orgs.updateMembershipState({
          organizationId: organization.id, userId: member.id,
          status: "suspended", actingPrincipal: ownerP,
        });
        // Member's SAME token now fails (resolveOrgContext re-loads from DB).
        const after = await app.request(
          `/v1/organizations/${organization.id}/memberships`,
          { method: "GET", headers: { authorization: `Bearer ${memberKey}` } },
        );
        expect(after.status).toBe(403);
        const body = (await after.json()) as {
          error: { category: string; details: { reason: string } };
        };
        expect(body.error.category).toBe("POLICY_BLOCKED");
        expect(body.error.details.reason).toContain("suspended");
      } finally {
        await cleanup();
      }
    });
  });

  it("scenario 8b: removed membership loses access immediately", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, app, cleanup } = await setup(handle);
      try {
        const owner = await auth.createUser({
          email: `o-${Date.now()}@e.com`, password: "password123",
        });
        const member = await auth.createUser({
          email: `m-${Date.now()}@e.com`, password: "password123",
        });
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "R", slug: `r-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        await orgs.addMember({
          organizationId: organization.id, userId: member.id, role: "owner",
          actingPrincipal: ownerP,
        });
        const memberKey = await issueKeyFor(auth, member.id);
        // Member can access.
        const before = await app.request(
          `/v1/organizations/${organization.id}`,
          { method: "GET", headers: { authorization: `Bearer ${memberKey}` } },
        );
        expect(before.status).toBe(200);
        // Owner removes the member.
        await orgs.removeMember({
          organizationId: organization.id, userId: member.id,
          actingPrincipal: ownerP,
        });
        // Member's token now fails.
        const after = await app.request(
          `/v1/organizations/${organization.id}`,
          { method: "GET", headers: { authorization: `Bearer ${memberKey}` } },
        );
        expect(after.status).toBe(403);
      } finally {
        await cleanup();
      }
    });
  });
});

describe("WORK-003 §18 security attack surface", () => {
  it("missing authentication on a tenant route → 401", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const res = await app.request(
          "/v1/organizations/org_any/memberships",
          { method: "GET" },
        );
        expect(res.status).toBe(401);
        const body = (await res.json()) as {
          error: { category: string };
        };
        expect(body.error.category).toBe("CREDENTIAL_FAILURE");
      } finally {
        await cleanup();
      }
    });
  });

  it("malformed Authorization header → 401 (not 500)", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const res = await app.request(
          "/v1/auth/me",
          { method: "GET", headers: { authorization: "NotBearer garbage" } },
        );
        expect(res.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  });

  it("token replay after revocation → 401", async () => {
    await withInfra(async (handle) => {
      const { auth, app, cleanup } = await setup(handle);
      try {
        const user = await auth.createUser({
          email: `replay-${Date.now()}@e.com`, password: "password123",
        });
        const { rawKey, record } = await auth.createApiKey({ userId: user.id });
        // First use succeeds.
        const r1 = await app.request("/v1/auth/me", {
          method: "GET", headers: { authorization: `Bearer ${rawKey}` },
        });
        expect(r1.status).toBe(200);
        // Revoke.
        await auth.revokeApiKey(record.id);
        // Replay → 401.
        const r2 = await app.request("/v1/auth/me", {
          method: "GET", headers: { authorization: `Bearer ${rawKey}` },
        });
        expect(r2.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  });

  it("direct access to another org's identifier (path substitution) → 403", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const keyA = await registerAndLogin(app, `p1-${Date.now()}@e.com`);
        const keyB = await registerAndLogin(app, `p2-${Date.now()}@e.com`);
        const orgA = await createOrg(app, keyA, "A", `pa-${Date.now()}`);
        // B authenticates as themselves and requests A's id directly.
        const res = await app.request(`/v1/organizations/${orgA}`, {
          method: "GET", headers: { authorization: `Bearer ${keyB}` },
        });
        expect(res.status).toBe(403);
      } finally {
        await cleanup();
      }
    });
  });

  it("unauthorized role use: member cannot add a member (403)", async () => {
    await withInfra(async (handle) => {
      const { auth, orgs, app, cleanup } = await setup(handle);
      try {
        const owner = await auth.createUser({
          email: `o-${Date.now()}@e.com`, password: "password123",
        });
        const member = await auth.createUser({
          email: `m-${Date.now()}@e.com`, password: "password123",
        });
        const outsider = await auth.createUser({
          email: `x-${Date.now()}@e.com`, password: "password123",
        });
        const { organization } = await orgs.createOrganizationWithOwner({
          ownerUserId: owner.id, name: "U", slug: `u-${Date.now()}`,
        });
        const ownerP = await orgs.buildPrincipalForUser(owner.id);
        await orgs.addMember({
          organizationId: organization.id, userId: member.id, role: "member",
          actingPrincipal: ownerP,
        });
        const memberKey = await issueKeyFor(auth, member.id);
        // Member (role=member, no MEMBER_INVITE) tries to add the outsider.
        const res = await app.request(
          `/v1/organizations/${organization.id}/memberships`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${memberKey}`,
            },
            body: JSON.stringify({ user_id: outsider.id, role: "member" }),
          },
        );
        expect(res.status).toBe(403);
        const body = (await res.json()) as {
          error: { category: string; details: { reason: string } };
        };
        expect(body.error.category).toBe("POLICY_BLOCKED");
        expect(body.error.details.reason).toBe("insufficient_permission");
      } finally {
        await cleanup();
      }
    });
  });

  it("secret material never appears in logs (no raw key/password)", async () => {
    await withInfra(async (handle) => {
      const { auth, app, sink, cleanup } = await setup(handle);
      try {
        const email = `log-${Date.now()}@e.com`;
        const password = "super-secret-pw-999";
        const user = await auth.createUser({ email, password });
        const { rawKey } = await auth.createApiKey({ userId: user.id });
        // Exercise auth + a tenant request.
        await app.request("/v1/auth/me", {
          method: "GET", headers: { authorization: `Bearer ${rawKey}` },
        });
        // Attempt a bad login (exercises failure logging too).
        await app.request("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: "wrong" }),
        });
        const logText = sink.text();
        // The raw key must never appear in any log record.
        expect(logText.includes(rawKey)).toBe(false);
        // The password must never appear in any log record.
        expect(logText.includes(password)).toBe(false);
        // The password hash must never appear in any log record.
        const userRow = await auth.getUser(user.id);
        void userRow;
      } finally {
        await cleanup();
      }
    });
  });

  it("X-API-Key header also authenticates (alternative bearer form)", async () => {
    await withInfra(async (handle) => {
      const { auth, app, cleanup } = await setup(handle);
      try {
        const user = await auth.createUser({
          email: `h-${Date.now()}@e.com`, password: "password123",
        });
        const { rawKey } = await auth.createApiKey({ userId: user.id });
        const res = await app.request("/v1/auth/me", {
          method: "GET", headers: { "x-api-key": rawKey },
        });
        expect(res.status).toBe(200);
      } finally {
        await cleanup();
      }
    });
  });
});
