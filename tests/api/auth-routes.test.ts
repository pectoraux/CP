// tests/api/auth-routes.test.ts — HTTP-level happy-path coverage of the
// WORK-003 /v1/auth + /v1/organizations routes (real PG via withInfra).
// The security tests cover the negative path; this covers the positive
// path end-to-end via the Hono app (no real socket).
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { migrateAuthSchema } from "@cp/auth";
import { migrateOrganizationsSchema } from "@cp/organizations";
import { createApi } from "@cp/api";
import { CapturingLogSink } from "../helpers.ts";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-api",
  });
  await migrateAuthSchema(db);
  await migrateOrganizationsSchema(db);
  const sink = new CapturingLogSink();
  const { app, runtime } = createApi({ loggerSink: sink, db });
  const cleanup = async () => {
    await runtime.queue.stop();
    await db.close();
  };
  return { db, app, runtime, sink, cleanup };
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
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ name: `Org ${slug}`, slug }),
  });
  return ((await res.json()) as { organization: { id: string } }).organization.id;
}

describe("WORK-003 API happy paths (real PG, in-app)", () => {
  it("register → sessions → /me → list api-keys → create api-key → revoke", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const email = `hp1-${Date.now()}@e.com`;
        const key = await registerLogin(app, email);

        // GET /v1/auth/me
        const me = await app.request("/v1/auth/me", {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        expect(me.status).toBe(200);
        const meBody = (await me.json()) as {
          user: { email: string };
          memberships: unknown[];
        };
        expect(meBody.user.email).toBe(email);
        expect(meBody.memberships).toEqual([]);

        // GET /v1/auth/api-keys (list — the session key)
        const list = await app.request("/v1/auth/api-keys", {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        expect(list.status).toBe(200);
        const listBody = (await list.json()) as {
          api_keys: { id: string; name: string | null }[];
        };
        expect(listBody.api_keys.length).toBe(1); // the session key

        // POST /v1/auth/api-keys (create a new key)
        const created = await app.request("/v1/auth/api-keys", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ name: "ci-key", expires_in_seconds: 3600 }),
        });
        expect(created.status).toBe(201);
        const createdBody = (await created.json()) as {
          api_key: string;
          record: { id: string };
        };
        expect(createdBody.api_key.startsWith("cpkey_")).toBe(true);

        // The new key also works.
        const me2 = await app.request("/v1/auth/me", {
          method: "GET",
          headers: { authorization: `Bearer ${createdBody.api_key}` },
        });
        expect(me2.status).toBe(200);

        // DELETE /v1/auth/api-keys/:id (revoke the new key)
        const del = await app.request(
          `/v1/auth/api-keys/${createdBody.record.id}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${key}` },
          },
        );
        expect(del.status).toBe(200);
        // The revoked key no longer works.
        const me3 = await app.request("/v1/auth/me", {
          method: "GET",
          headers: { authorization: `Bearer ${createdBody.api_key}` },
        });
        expect(me3.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  });

  it("create org → list orgs → get org → add member → list members → update role → remove", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        // Owner
        const ownerKey = await registerLogin(app, `o-${Date.now()}@e.com`);
        // Member (separate user)
        const memberEmail = `m-${Date.now()}@e.com`;
        await app.request("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: memberEmail, password: "password123" }),
        });
        const memberLogin = await app.request("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: memberEmail, password: "password123" }),
        });
        const memberBody = (await memberLogin.json()) as { user_id: string };
        const memberId = memberBody.user_id;

        // Create org
        const orgId = await createOrg(app, ownerKey, `o-${Date.now()}`);

        // GET /v1/organizations (list)
        const list = await app.request("/v1/organizations", {
          method: "GET",
          headers: { authorization: `Bearer ${ownerKey}` },
        });
        expect(list.status).toBe(200);
        const listBody = (await list.json()) as {
          organizations: { id: string }[];
        };
        expect(listBody.organizations.map((o) => o.id)).toContain(orgId);

        // GET /v1/organizations/:orgId
        const getOrg = await app.request(`/v1/organizations/${orgId}`, {
          method: "GET",
          headers: { authorization: `Bearer ${ownerKey}` },
        });
        expect(getOrg.status).toBe(200);

        // GET /v1/organizations/:orgId/memberships (initially just the owner)
        const members0 = await app.request(
          `/v1/organizations/${orgId}/memberships`,
          { method: "GET", headers: { authorization: `Bearer ${ownerKey}` } },
        );
        expect(members0.status).toBe(200);
        const m0 = (await members0.json()) as {
          memberships: { user_id: string; role: string }[];
        };
        expect(m0.memberships.length).toBe(1);

        // POST add member
        const add = await app.request(
          `/v1/organizations/${orgId}/memberships`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${ownerKey}`,
            },
            body: JSON.stringify({ user_id: memberId, role: "member" }),
          },
        );
        expect(add.status).toBe(201);

        // PATCH update role to admin
        const patch = await app.request(
          `/v1/organizations/${orgId}/memberships/${memberId}`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${ownerKey}`,
            },
            body: JSON.stringify({ role: "admin" }),
          },
        );
        expect(patch.status).toBe(200);
        const patchBody = (await patch.json()) as {
          membership: { role: string };
        };
        expect(patchBody.membership.role).toBe("admin");

        // GET members now includes the new admin
        const members2 = await app.request(
          `/v1/organizations/${orgId}/memberships`,
          { method: "GET", headers: { authorization: `Bearer ${ownerKey}` } },
        );
        const m2 = (await members2.json()) as {
          memberships: { user_id: string; role: string }[];
        };
        expect(m2.memberships.length).toBe(2);

        // DELETE remove the member
        const del = await app.request(
          `/v1/organizations/${orgId}/memberships/${memberId}`,
          { method: "DELETE", headers: { authorization: `Bearer ${ownerKey}` } },
        );
        expect(del.status).toBe(200);

        // Member (now removed) cannot access the org.
        const memberKey = await registerLogin(app, memberEmail);
        const memberAccess = await app.request(
          `/v1/organizations/${orgId}`,
          { method: "GET", headers: { authorization: `Bearer ${memberKey}` } },
        );
        expect(memberAccess.status).toBe(403);
      } finally {
        await cleanup();
      }
    });
  });

  it("GET /v1/auth/me without credential → 401", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const res = await app.request("/v1/auth/me", { method: "GET" });
        expect(res.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  });

  it("POST /v1/organizations without credential → 401", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const res = await app.request("/v1/organizations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "x", slug: "x" }),
        });
        expect(res.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  });
});
