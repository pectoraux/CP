// tests/api/projects-routes.test.ts — HTTP-level coverage of the WORK-004
// /v1/organizations/:orgId/projects routes (real PG via withInfra, in-app
// Hono request). Covers happy paths + idempotency (API-002) + pagination
// (API-003). The security/tenant-isolation tests cover the negative path.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { createApi } from "@cp/api";
import { CapturingLogSink } from "../helpers.ts";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-projects-api",
  });
  const sink = new CapturingLogSink();
  const api = createApi({ loggerSink: sink, db });
  // Run the full schema migration (auth + organizations + projects +
  // idempotency) via the public migrate() method — the same path main.ts
  // uses on startup.
  await api.migrate();
  const cleanup = async () => {
    await api.runtime.queue.stop();
    await db.close();
  };
  return { db, api, app: api.app, cleanup };
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

describe("WORK-004 project routes (real PG, in-app)", () => {
  it("create → get → list (paginated) → update → archive", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const email = `pr1-${Date.now()}@e.com`;
        const key = await registerLogin(app, email);
        const orgId = await createOrg(app, key, `org-${Date.now()}`);

        // Create a project.
        const create = await app.request(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ name: "Proj 1", slug: `p1-${Date.now()}` }),
        });
        expect(create.status).toBe(201);
        const proj = (await create.json()) as { project: { id: string; organization_id: string; status: string } };
        expect(proj.project.organization_id).toBe(orgId);
        expect(proj.project.status).toBe("active");

        // Get it back.
        const get = await app.request(`/v1/organizations/${orgId}/projects/${proj.project.id}`, {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        expect(get.status).toBe(200);

        // List (paginated) — page metadata present.
        const list = await app.request(`/v1/organizations/${orgId}/projects?limit=10`, {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        expect(list.status).toBe(200);
        const lb = (await list.json()) as { projects: { id: string }[]; page: { next_cursor: string | null; has_more: boolean } };
        expect(lb.projects.length).toBe(1);
        expect(lb.page.has_more).toBe(false);
        expect(lb.page.next_cursor).toBe(null);

        // Update (owner).
        const upd = await app.request(`/v1/organizations/${orgId}/projects/${proj.project.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ name: "Renamed" }),
        });
        expect(upd.status).toBe(200);
        const updBody = (await upd.json()) as { project: { name: string } };
        expect(updBody.project.name).toBe("Renamed");

        // Archive (owner).
        const del = await app.request(`/v1/organizations/${orgId}/projects/${proj.project.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${key}` },
        });
        expect(del.status).toBe(200);
        const delBody = (await del.json()) as { project: { status: string } };
        expect(delBody.project.status).toBe("archived");

        // Default list now excludes the archived project.
        const list2 = await app.request(`/v1/organizations/${orgId}/projects?limit=10`, {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        const lb2 = (await list2.json()) as { projects: { id: string }[] };
        expect(lb2.projects.length).toBe(0);

        // include_archived=true shows it.
        const list3 = await app.request(`/v1/organizations/${orgId}/projects?limit=10&include_archived=true`, {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        const lb3 = (await list3.json()) as { projects: { id: string }[] };
        expect(lb3.projects.length).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  it("idempotent create: same Idempotency-Key + body replays the same response (one project)", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const email = `idem1-${Date.now()}@e.com`;
        const key = await registerLogin(app, email);
        const orgId = await createOrg(app, key, `org-${Date.now()}`);
        const idemKey = `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const body = JSON.stringify({ name: "Idem Proj", slug: `idem-${Date.now()}` });

        // First request.
        const r1 = await app.request(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "idempotency-key": idemKey,
          },
          body,
        });
        expect(r1.status).toBe(201);
        expect(r1.headers.get("x-idempotent-replay")).toBeNull();
        const proj1 = (await r1.json()) as { project: { id: string } };

        // Replay with the same key + body → same project id, replay header set.
        const r2 = await app.request(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "idempotency-key": idemKey,
          },
          body,
        });
        expect(r2.status).toBe(201);
        expect(r2.headers.get("x-idempotent-replay")).toBe("true");
        const proj2 = (await r2.json()) as { project: { id: string } };
        expect(proj2.project.id).toBe(proj1.project.id);

        // Exactly one project exists in the org.
        const list = await app.request(`/v1/organizations/${orgId}/projects?limit=100`, {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        const lb = (await list.json()) as { projects: { id: string }[] };
        expect(lb.projects.length).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  it("idempotency key reused with a DIFFERENT body → 409 idempotency_key_reused", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const email = `idem2-${Date.now()}@e.com`;
        const key = await registerLogin(app, email);
        const orgId = await createOrg(app, key, `org-${Date.now()}`);
        const idemKey = `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const r1 = await app.request(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "idempotency-key": idemKey,
          },
          body: JSON.stringify({ name: "First", slug: `first-${Date.now()}` }),
        });
        expect(r1.status).toBe(201);

        // Same key, different body → 409.
        const r2 = await app.request(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "idempotency-key": idemKey,
          },
          body: JSON.stringify({ name: "Second", slug: `second-${Date.now()}` }),
        });
        expect(r2.status).toBe(409);
        const e = (await r2.json()) as { error: { code: string } };
        expect(e.error.code).toBe("idempotency_key_reused");
      } finally {
        await cleanup();
      }
    });
  });

  it("create without Idempotency-Key still works (opt-in)", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const email = `noidem-${Date.now()}@e.com`;
        const key = await registerLogin(app, email);
        const orgId = await createOrg(app, key, `org-${Date.now()}`);
        // No Idempotency-Key header → two creates with different slugs make
        // two projects (no dedup).
        const r1 = await app.request(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ name: "A", slug: `a-${Date.now()}` }),
        });
        expect(r1.status).toBe(201);
        const r2 = await app.request(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ name: "B", slug: `b-${Date.now()}` }),
        });
        expect(r2.status).toBe(201);
        const list = await app.request(`/v1/organizations/${orgId}/projects?limit=100`, {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        const lb = (await list.json()) as { projects: unknown[] };
        expect(lb.projects.length).toBe(2);
      } finally {
        await cleanup();
      }
    });
  });

  it("POST /v1/organizations supports idempotency (cross-resource consistency)", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const email = `idemorg-${Date.now()}@e.com`;
        const key = await registerLogin(app, email);
        const idemKey = `idem-org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const body = JSON.stringify({ name: "Idem Org", slug: `idem-org-${Date.now()}` });

        const r1 = await app.request("/v1/organizations", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "idempotency-key": idemKey },
          body,
        });
        expect(r1.status).toBe(201);
        const o1 = (await r1.json()) as { organization: { id: string } };

        const r2 = await app.request("/v1/organizations", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "idempotency-key": idemKey },
          body,
        });
        expect(r2.status).toBe(201);
        expect(r2.headers.get("x-idempotent-replay")).toBe("true");
        const o2 = (await r2.json()) as { organization: { id: string } };
        expect(o2.organization.id).toBe(o1.organization.id);

        // Exactly one org created.
        const list = await app.request("/v1/organizations", {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        const lb = (await list.json()) as { organizations: { id: string }[] };
        expect(lb.organizations.length).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });
});
