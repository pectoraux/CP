// tests/smoke/policies-smoke.test.ts — WORK-008 real-HTTP smoke over a
// REAL TCP socket (serve({autoMigrate:true})) against REAL PostgreSQL.
// Exercises the full policy lifecycle over the wire: authenticate →
// create org + project → create policy (idempotent) → create draft
// version (idempotent) → activate → evaluate (hard pass / hard fail with
// explainable violation) → member cannot mutate → cross-org rejected →
// missing auth 401 → health 200. Uses autoMigrate:true so the readiness
// gate runs the policies migration before binding the listener (proving
// the gate covers the WORK-008 schema).
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { serve } from "@cp/api";

describe("WORK-008 real-socket policy smoke", () => {
  it("authenticate → org+project → policy (idempotent) → version (idempotent) → activate → evaluate (pass + explainable fail) → member gate → cross-org gate → 401 → health 200", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-smoke-policies",
      });
      const port = 49900 + Math.floor(Math.random() * 100);
      const base = `http://127.0.0.1:${port}`;
      const api = await serve({ port, hostname: "127.0.0.1", db, autoMigrate: true });
      try {
        const t = Date.now();
        const req = (
          path: string,
          init: {
            method?: string;
            headers?: Record<string, string>;
            body?: string;
          } = {},
        ) =>
          fetch(`${base}${path}`, {
            method: init.method ?? "GET",
            headers: init.headers,
            body: init.body,
          });

        // 1. Register + login the (owner) user.
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-pol-${t}@e.com`, password: "password123" }),
        });
        const sess = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-pol-${t}@e.com`, password: "password123" }),
        });
        expect(sess.status).toBe(201);
        const key = ((await sess.json()) as { api_key: string }).api_key;
        const auth = { "content-type": "application/json", authorization: `Bearer ${key}` };

        // 2. Org + project.
        const orgRes = await req("/v1/organizations", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-pol-org-${t}` },
          body: JSON.stringify({ name: "Org", slug: `smk-pol-org-${t}` }),
        });
        expect(orgRes.status).toBe(201);
        const orgId = ((await orgRes.json()) as { organization: { id: string } }).organization.id;
        const projRes = await req(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-pol-proj-${t}` },
          body: JSON.stringify({ name: "Proj", slug: `smk-pol-proj-${t}` }),
        });
        expect(projRes.status).toBe(201);
        const projectId = ((await projRes.json()) as { project: { id: string } }).project.id;
        const polBase = `/v1/organizations/${orgId}/projects/${projectId}/policies`;

        // 3. Create policy (idempotent).
        const idem = `smk-pol-idem-${t}`;
        const polBody = JSON.stringify({ name: "eu-only", description: "EU residency" });
        const c1 = await req(polBase, { method: "POST", headers: { ...auth, "idempotency-key": idem }, body: polBody });
        expect(c1.status).toBe(201);
        const policy = ((await c1.json()) as { policy: { id: string } }).policy;
        const c2 = await req(polBase, { method: "POST", headers: { ...auth, "idempotency-key": idem }, body: polBody });
        expect(c2.status).toBe(201);
        expect(c2.headers.get("x-idempotent-replay")).toBe("true");

        // 4. Create draft version (idempotent).
        const vIdem = `smk-pol-ver-${t}`;
        const rules = [
          { subject: "region", operator: "eq", value: "EU", mode: "hard" },
          { subject: "certification", operator: "eq", value: "certified", mode: "hard" },
          { subject: "integration_path", operator: "eq", value: "platform_operated", mode: "preference" },
        ];
        const vBody = JSON.stringify({ rules });
        const v1 = await req(`${polBase}/${policy.id}/versions`, {
          method: "POST", headers: { ...auth, "idempotency-key": vIdem }, body: vBody,
        });
        expect(v1.status).toBe(201);
        const v2 = await req(`${polBase}/${policy.id}/versions`, {
          method: "POST", headers: { ...auth, "idempotency-key": vIdem }, body: vBody,
        });
        expect(v2.headers.get("x-idempotent-replay")).toBe("true");

        // 5. Activate.
        const act = await req(`${polBase}/${policy.id}/versions/1/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });
        expect(act.status).toBe(200);
        expect(((await act.json()) as { version: { status: string } }).version.status).toBe("active");

        // 6. Evaluate — hard constraints pass, preference violated.
        const ok = await req(`${polBase}/${policy.id}/evaluate`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            version: "1",
            context: { region: "EU", certification: "certified", integration_path: "provider_operated" },
          }),
        });
        expect(ok.status).toBe(200);
        const okBody = ((await ok.json()) as {
          evaluation: { passed: boolean; preferences: { violated: unknown[] } };
        }).evaluation;
        expect(okBody.passed).toBe(true);
        expect(okBody.preferences.violated.length).toBe(1);

        // 7. Evaluate — hard violation with an explainable result.
        const bad = await req(`${polBase}/${policy.id}/evaluate`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            version: "1",
            context: { region: "US", certification: "certified", integration_path: "provider_operated" },
          }),
        });
        expect(bad.status).toBe(200);
        const badBody = ((await bad.json()) as {
          evaluation: {
            passed: boolean;
            hard_constraints: { violations: { rule_id: string; subject: string; actual: string; expected: string; mode: string }[] };
          };
        }).evaluation;
        expect(badBody.passed).toBe(false);
        const v = badBody.hard_constraints.violations[0]!;
        expect(v.rule_id).toBe("rule_1");
        expect(v.subject).toBe("region");
        expect(v.actual).toBe("US");
        expect(v.expected).toBe("EU");
        expect(v.mode).toBe("hard");

        // 8. A second user (no membership) cannot mutate (org gate).
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-pol2-${t}@e.com`, password: "password123" }),
        });
        const sess2 = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-pol2-${t}@e.com`, password: "password123" }),
        });
        const key2 = ((await sess2.json()) as { api_key: string }).api_key;
        const blocked = await req(polBase, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key2}` },
          body: JSON.stringify({ name: "intrusion" }),
        });
        expect(blocked.status).toBe(403);

        // 9. Missing auth → 401. Platform health still works.
        const noAuth = await req(polBase);
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
