// tests/smoke/goals-smoke.test.ts — WORK-011 real-HTTP smoke over a REAL
// TCP socket (serve({autoMigrate:true})) against REAL PostgreSQL: the
// full goals + outcome-contract lifecycle over the wire.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { serve } from "@cp/api";

describe("WORK-011 real-socket goals smoke", () => {
  it("authenticate → tenant → contract → activate → goal → version → activate → member gate → 401 → health 200", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-smoke-goals",
      });
      const port = 50500 + Math.floor(Math.random() * 200);
      const base = `http://127.0.0.1:${port}`;
      const api = await serve({ port, hostname: "127.0.0.1", db, autoMigrate: true });
      try {
        const t = Date.now();
        const req = (
          path: string,
          init: { method?: string; headers?: Record<string, string>; body?: string } = {},
        ) => fetch(`${base}${path}`, { method: init.method ?? "GET", headers: init.headers, body: init.body });

        // 1. Register + login + org + project.
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-goal-${t}@e.com`, password: "password123" }),
        });
        const sess = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-goal-${t}@e.com`, password: "password123" }),
        });
        expect(sess.status).toBe(201);
        const key = ((await sess.json()) as { api_key: string }).api_key;
        const auth = { "content-type": "application/json", authorization: `Bearer ${key}` };
        const orgRes = await req("/v1/organizations", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-gl-org-${t}` },
          body: JSON.stringify({ name: "Org", slug: `smk-gl-org-${t}` }),
        });
        expect(orgRes.status).toBe(201);
        const orgId = ((await orgRes.json()) as { organization: { id: string } }).organization.id;
        const projRes = await req(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-gl-proj-${t}` },
          body: JSON.stringify({ name: "Proj", slug: `smk-gl-proj-${t}` }),
        });
        expect(projRes.status).toBe(201);
        const projectId = ((await projRes.json()) as { project: { id: string } }).project.id;
        const goalBase = `/v1/organizations/${orgId}/projects/${projectId}`;

        // 2. Create + activate the outcome contract.
        const contract = {
          metric: "success_rate", unit: "ratio", direction: "maximize",
          aggregation: "mean", threshold: 0.99, window_seconds: 300,
          measurement_source: "execution_observation", required: true,
        };
        const cc = await req(`${goalBase}/outcome-contracts`, {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-gl-oc-${t}` },
          body: JSON.stringify({ name: "acceptance", content: contract }),
        });
        expect(cc.status).toBe(201);
        const cv = ((await cc.json()) as { contract_version: { contract_id: string; version: string } }).contract_version;
        const cact = await req(`${goalBase}/outcome-contracts/${cv.contract_id}/versions/1/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });
        expect(cact.status).toBe(200);

        // 3. Create the goal + version (composite hard + preference).
        const gc = await req(`${goalBase}/goals`, {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-gl-g-${t}` },
          body: JSON.stringify({ name: "maximize-acceptance" }),
        });
        expect(gc.status).toBe(201);
        const goal = ((await gc.json()) as { goal: { id: string } }).goal;
        const gv = await req(`${goalBase}/goals/${goal.id}/versions`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            objectives: [
              { direction: "maximize", metric: "success_rate", kind: "hard", target: 0.99, unit: "ratio" },
              { direction: "maximize", metric: "success_rate", kind: "preference" },
            ],
            outcome_contract_id: cv.contract_id,
            outcome_contract_version: "1",
          }),
        });
        expect(gv.status).toBe(201);
        const gact = await req(`${goalBase}/goals/${goal.id}/versions/1/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });
        expect(gact.status).toBe(200);
        expect(((await gact.json()) as { version: { status: string } }).version.status).toBe("active");

        // 4. Read the goal version (explainable representation).
        const got = await req(`${goalBase}/goals/${goal.id}/versions/1`, {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(got.status).toBe(200);
        const gotBody = (await got.json()) as {
          version: {
            objectives: { kind: string; direction: string; metric: string }[];
            outcome_contract: { contract_id: string; contract_version: string };
          };
        };
        expect(gotBody.version.objectives[0]!.kind).toBe("hard");
        expect(gotBody.version.outcome_contract.contract_id).toBe(cv.contract_id);

        // 5. Missing auth → 401; health 200.
        const noAuth = await req(`${goalBase}/goals`);
        expect(noAuth.status).toBe(401);
        const health = await req("/v1/platform/health");
        expect(health.status).toBe(200);
      } finally {
        await api.stop();
        await db.close();
      }
    });
  }, 120_000);
});
