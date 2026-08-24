// tests/smoke/providers-smoke.test.ts — WORK-006 real-HTTP smoke over a
// REAL TCP socket (serve({autoMigrate:true})) against REAL PostgreSQL.
// Exercises the full first-party integration path over the wire:
// authenticate → no self-bootstrap (403) → deployment bootstrap → create
// capability+version → create provider (idempotent) → declare
// implementation → evidence-gated lifecycle (403 then OK) → run
// certification contract tests (fixture) → evidence list → non-admin
// rejected → missing auth 401 → health 200. Uses autoMigrate:true so the
// readiness gate runs the providers migration before binding the listener
// (proving the gate covers the WORK-006 schema).
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { serve } from "@cp/api";

describe("WORK-006 real-socket provider smoke", () => {
  it("authenticate → bootstrap admin → capability → provider (idempotent) → declare → contract tests → evidence → lifecycle → non-admin 403 → 401 → health 200", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-smoke-providers",
      });
      const port = 49500 + Math.floor(Math.random() * 1000);
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

        // 1. Register + login + user id.
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-prov-${t}@e.com`, password: "password123" }),
        });
        const sess = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-prov-${t}@e.com`, password: "password123" }),
        });
        expect(sess.status).toBe(201);
        const key = ((await sess.json()) as { api_key: string }).api_key;
        const auth = { "content-type": "application/json", authorization: `Bearer ${key}` };
        const me = await req("/v1/auth/me", { headers: { authorization: `Bearer ${key}` } });
        const userId = ((await me.json()) as { user: { id: string } }).user.id;

        // 2. No tenant self-bootstrap (WORK-005 invariant preserved).
        const selfGrant = await req("/v1/capabilities/admins", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ user_id: userId }),
        });
        expect(selfGrant.status).toBe(403);

        // 3. Deployment bootstrap (operator authority, service level).
        const boot = await api.capabilities.bootstrapCapabilityAdmin({ userId });
        expect(boot.granted).toBe(true);

        // 4. Seed the demo.echo capability + active version 1.
        const cap = await req("/v1/capabilities", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-prov-cap-${t}` },
          body: JSON.stringify({ capability_id: "demo.echo", name: "Echo" }),
        });
        expect(cap.status).toBe(201);
        await req(`/v1/capabilities/${encodeURIComponent("demo.echo")}/lifecycle`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: "active" }),
        });
        await req(`/v1/capabilities/${encodeURIComponent("demo.echo")}/versions`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            version: "1",
            contract: {
              input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
              output_schema: {
                type: "object",
                properties: { echoed: { type: "string" }, echo_id: { type: "string" }, echoed_at: { type: "string" } },
                required: ["echoed", "echo_id", "echoed_at"],
              },
              side_effect: "pure",
            },
          }),
        });
        await req(`/v1/capabilities/${encodeURIComponent("demo.echo")}/versions/1/lifecycle`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: "active" }),
        });

        // 5. Create the provider (idempotent replay).
        const idemKey = `smk-prov-idem-${t}`;
        const provBody = JSON.stringify({ provider_id: "demo.echo", name: "Echo Demo Provider" });
        const pc1 = await req("/v1/providers", {
          method: "POST",
          headers: { ...auth, "idempotency-key": idemKey },
          body: provBody,
        });
        expect(pc1.status).toBe(201);
        const pc2 = await req("/v1/providers", {
          method: "POST",
          headers: { ...auth, "idempotency-key": idemKey },
          body: provBody,
        });
        expect(pc2.status).toBe(201);
        expect(pc2.headers.get("x-idempotent-replay")).toBe("true");

        // 6. Declare the implementation.
        const decl = await req(`/v1/providers/${encodeURIComponent("demo.echo")}/capabilities`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1" }),
        });
        expect(decl.status).toBe(201);

        // 7. Lifecycle: discovered → integrating; contract_tested is
        //    evidence-gated (403 until the contract suite passes).
        const tr1 = await req(`/v1/providers/${encodeURIComponent("demo.echo")}/lifecycle`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: "integrating" }),
        });
        expect(tr1.status).toBe(200);
        const trGate = await req(`/v1/providers/${encodeURIComponent("demo.echo")}/lifecycle`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: "contract_tested" }),
        });
        expect(trGate.status).toBe(403);

        // 8. Run the certification contract tests (fixture environment).
        const run = await req(
          `/v1/providers/${encodeURIComponent("demo.echo")}/capabilities/${encodeURIComponent("demo.echo")}/versions/1/certification-tests`,
          { method: "POST", headers: auth, body: JSON.stringify({}) },
        );
        expect(run.status).toBe(200);
        const runBody = (await run.json()) as {
          environment: string;
          declaration_results: { status_after: string; outcomes: { result: string }[] }[];
        };
        expect(runBody.environment).toBe("fixture");
        expect(runBody.declaration_results[0]!.status_after).toBe("contract_verified");
        expect(runBody.declaration_results[0]!.outcomes.every((o) => o.result === "pass")).toBe(true);

        // 9. Evidence-gated transition now succeeds.
        const tr2 = await req(`/v1/providers/${encodeURIComponent("demo.echo")}/lifecycle`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: "contract_tested" }),
        });
        expect(tr2.status).toBe(200);

        // 10. Evidence trail is inspectable.
        const ev = await req(`/v1/providers/${encodeURIComponent("demo.echo")}/certification`, {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(ev.status).toBe(200);
        const evBody = (await ev.json()) as { evidence: { environment: string }[] };
        expect(evBody.evidence.length).toBe(7);
        expect(evBody.evidence.every((e) => e.environment === "fixture")).toBe(true);

        // 11. A second user (no grant) cannot mutate; CAN read.
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-prov2-${t}@e.com`, password: "password123" }),
        });
        const sess2 = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-prov2-${t}@e.com`, password: "password123" }),
        });
        const key2 = ((await sess2.json()) as { api_key: string }).api_key;
        const blocked = await req("/v1/providers", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key2}` },
          body: JSON.stringify({ provider_id: "stripe", name: "Stripe" }),
        });
        expect(blocked.status).toBe(403);
        const read = await req("/v1/providers?limit=10", {
          headers: { authorization: `Bearer ${key2}` },
        });
        expect(read.status).toBe(200);

        // 12. Missing auth → 401. Health still works.
        const noAuth = await req("/v1/providers");
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
