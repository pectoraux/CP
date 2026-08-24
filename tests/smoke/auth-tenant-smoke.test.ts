// tests/smoke/auth-tenant-smoke.test.ts — WORK-003 §22 REQUIRED real HTTP
// smoke test. Exercises the full authenticate → resolve organization →
// authorize → access tenant data path over a REAL TCP socket (serve()),
// against REAL PostgreSQL. Explicitly proves cross-tenant access is
// rejected. This is the end-to-end evidence required by Section 22.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { migrateAuthSchema } from "@cp/auth";
import { migrateOrganizationsSchema } from "@cp/organizations";
import { serve } from "@cp/api";

describe("WORK-003 §22 real-socket smoke", () => {
  it("authenticate → resolve org → authorize → access tenant data; cross-tenant rejected", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-smoke-e2e",
      });
      await migrateAuthSchema(db);
      await migrateOrganizationsSchema(db);
      const port = 47500 + Math.floor(Math.random() * 1000);
      const base = `http://127.0.0.1:${port}`;
      // serve() is async: with autoMigrate off (we pre-migrated above), it
      // resolves immediately after binding the listener.
      const api = await serve({ port, hostname: "127.0.0.1", db });
      try {
        const t = Date.now();
        const emailA = `smk-a-${t}@e.com`;
        const emailB = `smk-b-${t}@e.com`;
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

        // 1. Register + login A
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: emailA, password: "password123" }),
        });
        const sessA = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: emailA, password: "password123" }),
        });
        expect(sessA.status).toBe(201);
        const keyA = ((await sessA.json()) as { api_key: string }).api_key;

        // 2. Create org A as User A (A becomes owner).
        const createA = await req("/v1/organizations", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${keyA}`,
          },
          body: JSON.stringify({ name: "Smoke Org A", slug: `smk-a-${t}` }),
        });
        expect(createA.status).toBe(201);
        const orgA = ((await createA.json()) as {
          organization: { id: string };
        }).organization.id;

        // 3. User A accesses Org A (authorized).
        const aReadsA = await req(`/v1/organizations/${orgA}/memberships`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyA}` },
        });
        expect(aReadsA.status).toBe(200);

        // 4. Register + login B (different user).
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: emailB, password: "password123" }),
        });
        const sessB = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: emailB, password: "password123" }),
        });
        const keyB = ((await sessB.json()) as { api_key: string }).api_key;

        // 5. User B attempts to access Org A (cross-tenant) → 403.
        const bReadsA = await req(`/v1/organizations/${orgA}/memberships`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyB}` },
        });
        expect(bReadsA.status).toBe(403);
        const bBody = (await bReadsA.json()) as {
          error: { category: string; code: string };
        };
        expect(bBody.error.category).toBe("POLICY_BLOCKED");

        // 6. User B attempts to substitute Org A's id on the org detail
        //    route → still 403 (the org_id is only a REQUESTED TARGET; the
        //    Principal's active membership is what grants access).
        const bSub = await req(`/v1/organizations/${orgA}`, {
          method: "GET",
          headers: { authorization: `Bearer ${keyB}` },
        });
        expect(bSub.status).toBe(403);

        // 7. Missing authentication on a tenant route → 401.
        const noAuth = await req(`/v1/organizations/${orgA}/memberships`, {
          method: "GET",
        });
        expect(noAuth.status).toBe(401);

        // 8. Platform health still works (WORK-001 preserved).
        const health = await req("/v1/platform/health");
        expect(health.status).toBe(200);
      } finally {
        await api.stop();
        await db.close();
      }
    });
  }, 120_000);
});
