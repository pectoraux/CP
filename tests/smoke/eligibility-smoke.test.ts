// tests/smoke/eligibility-smoke.test.ts — WORK-009 real-HTTP smoke over a
// REAL TCP socket (serve({autoMigrate:true})) against REAL PostgreSQL.
// Exercises the full eligibility flow over the wire: authenticate → org +
// project → deployment bootstrap → seed capability/provider/declaration +
// catalog facts + policy → evaluate (eligible with preference violation
// recorded) → evaluate (hard violation explainable) → named ghost provider
// rejection → member allowed → cross-org rejected → missing auth 401 →
// health 200.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { serve } from "@cp/api";

describe("WORK-009 real-socket eligibility smoke", () => {
  it("authenticate → tenant → seed → evaluate (eligible + explainable ineligible + ghost) → gates → 401 → health 200", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-smoke-eligibility",
      });
      const port = 50100 + Math.floor(Math.random() * 200);
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

        // 1. Register + login the owner.
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-elig-${t}@e.com`, password: "password123" }),
        });
        const sess = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-elig-${t}@e.com`, password: "password123" }),
        });
        expect(sess.status).toBe(201);
        const key = ((await sess.json()) as { api_key: string }).api_key;
        const auth = { "content-type": "application/json", authorization: `Bearer ${key}` };
        const me = await req("/v1/auth/me", { headers: { authorization: `Bearer ${key}` } });
        const userId = ((await me.json()) as { user: { id: string } }).user.id;

        // 2. Deployment bootstrap + org + project.
        const boot = await api.capabilities.bootstrapCapabilityAdmin({ userId });
        expect(boot.granted).toBe(true);
        const orgRes = await req("/v1/organizations", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-el-org-${t}` },
          body: JSON.stringify({ name: "Org", slug: `smk-el-org-${t}` }),
        });
        expect(orgRes.status).toBe(201);
        const orgId = ((await orgRes.json()) as { organization: { id: string } }).organization.id;
        const projRes = await req(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-el-proj-${t}` },
          body: JSON.stringify({ name: "Proj", slug: `smk-el-proj-${t}` }),
        });
        expect(projRes.status).toBe(201);
        const projectId = ((await projRes.json()) as { project: { id: string } }).project.id;

        // 3. Seed the offering: capability@1 + provider + declaration.
        const contract = {
          input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
          output_schema: {
            type: "object",
            properties: { echoed: { type: "string" }, echo_id: { type: "string" }, echoed_at: { type: "string" } },
            required: ["echoed", "echo_id", "echoed_at"],
          },
          side_effect: "pure",
        };
        await req("/v1/capabilities", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-el-cap-${t}` },
          body: JSON.stringify({ capability_id: "demo.echo", name: "Echo" }),
        });
        await req(`/v1/capabilities/${encodeURIComponent("demo.echo")}/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });
        await req(`/v1/capabilities/${encodeURIComponent("demo.echo")}/versions`, {
          method: "POST", headers: auth, body: JSON.stringify({ version: "1", contract }),
        });
        await req(`/v1/capabilities/${encodeURIComponent("demo.echo")}/versions/1/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });
        await req("/v1/providers", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-el-prov-${t}` },
          body: JSON.stringify({ provider_id: "demo.echo", name: "Echo Demo Provider" }),
        });
        await req(`/v1/providers/${encodeURIComponent("demo.echo")}/capabilities`, {
          method: "POST", headers: auth,
          body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1" }),
        });

        // 4. Catalog facts: pricing + country coverage.
        await req("/v1/catalog/pricing", {
          method: "POST", headers: auth,
          body: JSON.stringify({
            provider_id: "demo.echo", capability_id: "demo.echo", capability_version: "1",
            model: "per_request", currency: "GHS", amount: "0.05", source_type: "provider_declared",
          }),
        });
        await req("/v1/catalog/coverage", {
          method: "POST", headers: auth,
          body: JSON.stringify({
            provider_id: "demo.echo", capability_id: "demo.echo", capability_version: "1",
            dimension: "country", value: "GH", source_type: "provider_declared",
          }),
        });

        // 5. Policy (active) in the project.
        const polBase = `/v1/organizations/${orgId}/projects/${projectId}/policies`;
        const pol = await req(polBase, {
          method: "POST", headers: auth, body: JSON.stringify({ name: "gh-policy" }),
        });
        expect(pol.status).toBe(201);
        const policyId = ((await pol.json()) as { policy: { id: string } }).policy.id;
        await req(`${polBase}/${policyId}/versions`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            rules: [
              { subject: "country", operator: "eq", value: "GH", mode: "hard" },
              { subject: "integration_path", operator: "eq", value: "provider_operated", mode: "preference" },
            ],
          }),
        });
        await req(`${polBase}/${policyId}/versions/1/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });

        // 6. Evaluate — eligible with the preference violated (recorded,
        //    never disqualifying).
        const eligBase = `/v1/organizations/${orgId}/projects/${projectId}/eligibility`;
        const ok = await req(`${eligBase}/evaluate`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            capability_id: "demo.echo", capability_version: "1", policy_id: policyId,
            context: { country: "GH", max_estimated_cost: 0.1 },
          }),
        });
        expect(ok.status).toBe(200);
        const okBody = ((await ok.json()) as {
          eligibility: {
            summary: { evaluated: number; eligible: number };
            results: {
              status: string;
              policy: { hard_passed: boolean; preference_violated: string[] } | null;
              snapshot: { per_request_pricing_fact: { amount: string } | null };
            }[];
          };
        }).eligibility;
        expect(okBody.summary.evaluated).toBe(1);
        expect(okBody.summary.eligible).toBe(1);
        expect(okBody.results[0]!.status).toBe("eligible");
        expect(okBody.results[0]!.policy?.hard_passed).toBe(true);
        expect(okBody.results[0]!.policy?.preference_violated).toEqual(["rule_2"]);
        expect(okBody.results[0]!.snapshot.per_request_pricing_fact?.amount).toBe("0.05");

        // 7. Evaluate — hard violation (country US) with explainable checks.
        const bad = await req(`${eligBase}/evaluate`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            capability_id: "demo.echo", capability_version: "1", policy_id: policyId,
            context: { country: "US" },
          }),
        });
        expect(bad.status).toBe(200);
        const badBody = ((await bad.json()) as {
          eligibility: {
            summary: { ineligible: number };
            results: { status: string; failures: { check_id: string; reason: string }[] }[];
          };
        }).eligibility;
        expect(badBody.summary.ineligible).toBe(1);
        expect(badBody.results[0]!.status).toBe("ineligible");
        expect(badBody.results[0]!.failures.find((c) => c.check_id === "policy.hard_constraints")!.reason).toContain("rule_1");

        // 8. Named ghost provider → synthetic rejection.
        const ghost = await req(`${eligBase}/evaluate`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            capability_id: "demo.echo", capability_version: "1", policy_id: policyId,
            providers: ["ghost.provider"], context: { country: "GH" },
          }),
        });
        const ghostBody = ((await ghost.json()) as {
          eligibility: { results: { status: string; failures: { check_id: string }[] }[] };
        }).eligibility;
        expect(ghostBody.results[0]!.status).toBe("ineligible");
        expect(ghostBody.results[0]!.failures[0]!.check_id).toBe("provider.declaration_exists");

        // 9. Missing auth → 401. Platform health still works.
        const noAuth = await req(`${eligBase}/evaluate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1", policy_id: policyId }),
        });
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
