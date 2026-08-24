// tests/smoke/projects-smoke.test.ts — WORK-004 real-HTTP smoke over a REAL
// TCP socket (serve()) against REAL PostgreSQL. Exercises the full
// authenticate → resolve org → create project → list (paginated) → get →
// idempotent replay → cross-org project access rejected path. Uses
// autoMigrate:true so the readiness gate runs the auth+organizations+
// projects+idempotency migrations before binding the listener (proving the
// gate covers the WORK-004 schemas too).
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { serve } from "@cp/api";

describe("WORK-004 real-socket project smoke", () => {
  it("authenticate → create org → create project (idempotent) → list → get → cross-org rejected", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-smoke-projects",
      });
      const port = 49000 + Math.floor(Math.random() * 1000);
      const base = `http://127.0.0.1:${port}`;
      // serve({ autoMigrate: true }) runs ALL schema migrations (auth +
      // organizations + projects + idempotency) before binding the listener.
      const api = await serve({ port, hostname: "127.0.0.1", db, autoMigrate: true });
      try {
        const t = Date.now();
        const req = (
          path: string,
          init: {
            method: string;
            headers?: Record<string, string>;
            body?: string;
          } = { method: "GET" },
        ) =>
          fetch(`${base}${path}`, {
            method: init.method,
            headers: init.headers,
            body: init.body,
          });

        // 1. Register + login User A (org A owner).
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-a-${t}@e.com`, password: "password123" }),
        });
        const sessA = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-a-${t}@e.com`, password: "password123" }),
        });
        expect(sessA.status).toBe(201);
        const keyA = ((await sessA.json()) as { api_key: string }).api_key;

        // 2. Create org A as User A.
        const createOrgA = await req("/v1/organizations", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${keyA}` },
          body: JSON.stringify({ name: "Smoke Org A", slug: `smk-oa-${t}` }),
        });
        expect(createOrgA.status).toBe(201);
        const orgA = ((await createOrgA.json()) as { organization: { id: string } }).organization.id;

        // 3. Create a project in Org A (idempotent — same Idempotency-Key).
        const idemKey = `smk-idem-${t}`;
        const projBody = JSON.stringify({ name: "Smoke Proj A", slug: `smk-pa-${t}` });
        const pc1 = await req(`/v1/organizations/${orgA}/projects`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${keyA}`,
            "idempotency-key": idemKey,
          },
          body: projBody,
        });
        expect(pc1.status).toBe(201);
        const projA = ((await pc1.json()) as { project: { id: string; organization_id: string } }).project;
        expect(projA.organization_id).toBe(orgA);

        // 4. Replay the same Idempotency-Key + body → same project id, replay header.
        const pc2 = await req(`/v1/organizations/${orgA}/projects`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${keyA}`,
            "idempotency-key": idemKey,
          },
          body: projBody,
        });
        expect(pc2.status).toBe(201);
        expect(pc2.headers.get("x-idempotent-replay")).toBe("true");
        const projA2 = ((await pc2.json()) as { project: { id: string } }).project;
        expect(projA2.id).toBe(projA.id);

        // 5. List projects (paginated) in Org A.
        const list = await req(`/v1/organizations/${orgA}/projects?limit=10`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyA}` },
        });
        expect(list.status).toBe(200);
        const lb = (await list.json()) as {
          projects: { id: string }[];
          page: { next_cursor: string | null; has_more: boolean };
        };
        expect(lb.projects.length).toBe(1);
        expect(lb.projects[0]!.id).toBe(projA.id);
        expect(lb.page.has_more).toBe(false);

        // 6. Get the project.
        const get = await req(`/v1/organizations/${orgA}/projects/${projA.id}`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyA}` },
        });
        expect(get.status).toBe(200);

        // 7. Register + login User B (org B owner, NOT a member of Org A).
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-b-${t}@e.com`, password: "password123" }),
        });
        const sessB = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-b-${t}@e.com`, password: "password123" }),
        });
        const keyB = ((await sessB.json()) as { api_key: string }).api_key;
        const createOrgB = await req("/v1/organizations", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${keyB}` },
          body: JSON.stringify({ name: "Smoke Org B", slug: `smk-ob-${t}` }),
        });
        const orgB = ((await createOrgB.json()) as { organization: { id: string } }).organization.id;
        // B creates a project in Org B.
        const pcB = await req(`/v1/organizations/${orgB}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${keyB}` },
          body: JSON.stringify({ name: "Smoke Proj B", slug: `smk-pb-${t}` }),
        });
        const projB = ((await pcB.json()) as { project: { id: string } }).project.id;

        // 8. User B (not in Org A) reads Org A's project → 403 (org gate).
        const bReadsA = await req(`/v1/organizations/${orgA}/projects/${projA.id}`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyB}` },
        });
        expect(bReadsA.status).toBe(403);

        // 9. User A (in Org A) puts Org B's project id under Org A's path
        //    → 403 project.not_found (project belongs to Org B, not Org A;
        //    cross-org project id substitution is rejected, no leak).
        const aReadsB = await req(`/v1/organizations/${orgA}/projects/${projB}`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyA}` },
        });
        expect(aReadsB.status).toBe(403);
        const aBody = (await aReadsB.json()) as { error: { code: string; details?: { reason?: string } } };
        expect(aBody.error.code).toBe("project.not_found");
        expect(aBody.error.details?.reason).toBe("no_such_project");

        // 10. Missing auth on a project route → 401.
        const noAuth = await req(`/v1/organizations/${orgA}/projects/${projA.id}`, { method: "GET" });
        expect(noAuth.status).toBe(401);

        // 11. Platform health still works (WORK-001 preserved).
        const health = await req("/v1/platform/health");
        expect(health.status).toBe(200);
      } finally {
        await api.stop();
        await db.close();
      }
    });
  }, 120_000);
});
