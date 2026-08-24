// tests/smoke/catalog-smoke.test.ts — WORK-007 real-HTTP smoke over a
// REAL TCP socket (serve({autoMigrate:true})) against REAL PostgreSQL.
// Exercises the full marketplace path over the wire: authenticate →
// deployment bootstrap → seed capability/provider/declaration → record
// pricing/coverage/health facts → verify a coverage fact → list/filter
// offerings → offering detail → non-admin 403 → missing auth 401 →
// health 200. Uses autoMigrate:true so the readiness gate runs the
// catalog migration before binding the listener (proving the gate covers
// the WORK-007 schema).
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { serve } from "@cp/api";

describe("WORK-007 real-socket catalog smoke", () => {
  it("authenticate → bootstrap → stack → facts → verification → offerings list/filter/detail → non-admin 403 → 401 → health 200", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-smoke-catalog",
      });
      const port = 49700 + Math.floor(Math.random() * 200);
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
          body: JSON.stringify({ email: `smk-cat-${t}@e.com`, password: "password123" }),
        });
        const sess = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-cat-${t}@e.com`, password: "password123" }),
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

        // 3. Deployment bootstrap (operator authority).
        const boot = await api.capabilities.bootstrapCapabilityAdmin({ userId });
        expect(boot.granted).toBe(true);

        // 4. Seed the stack: capability + version + provider + declaration.
        const cap = await req("/v1/capabilities", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-cat-cap-${t}` },
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
        const prov = await req("/v1/providers", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-cat-prov-${t}` },
          body: JSON.stringify({ provider_id: "demo.echo", name: "Echo Demo Provider" }),
        });
        expect(prov.status).toBe(201);
        const decl = await req(`/v1/providers/${encodeURIComponent("demo.echo")}/capabilities`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1" }),
        });
        expect(decl.status).toBe(201);

        // 5. Record marketplace facts.
        const pricing = await req("/v1/catalog/pricing", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-cat-prc-${t}` },
          body: JSON.stringify({
            provider_id: "demo.echo",
            capability_id: "demo.echo",
            capability_version: "1",
            model: "per_request",
            currency: "GHS",
            amount: "0.05",
            source_type: "provider_declared",
          }),
        });
        expect(pricing.status).toBe(201);
        const cov = await req("/v1/catalog/coverage", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            provider_id: "demo.echo",
            capability_id: "demo.echo",
            capability_version: "1",
            dimension: "country",
            value: "GH",
            source_type: "provider_declared",
          }),
        });
        expect(cov.status).toBe(201);
        const coverageId = ((await cov.json()) as { coverage: { id: string } }).coverage.id;
        const hlth = await req("/v1/catalog/health", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            provider_id: "demo.echo",
            status: "healthy",
            source_type: "platform_observed",
          }),
        });
        expect(hlth.status).toBe(201);

        // 6. Verify the coverage fact with evidence.
        const ver = await req(`/v1/catalog/coverage/${coverageId}/verification`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ evidence_reference: "https://provider.example/coverage" }),
        });
        expect(ver.status).toBe(200);
        const verBody = ((await ver.json()) as { coverage: { provenance: { status: string } } }).coverage;
        expect(verBody.provenance.status).toBe("verified");

        // 7. List + filter offerings.
        const list = await req("/v1/catalog/offerings?limit=10", {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(list.status).toBe(200);
        const listBody = (await list.json()) as {
          offerings: {
            offering_id: string;
            pricing: unknown[];
            coverage: { provenance: { status: string } }[];
            health: unknown[];
          }[];
        };
        expect(listBody.offerings.length).toBe(1);
        const o = listBody.offerings[0]!;
        expect(o.pricing.length).toBe(1);
        expect(o.coverage[0]!.provenance.status).toBe("verified");
        expect(o.health.length).toBe(1);

        const byCountry = await req("/v1/catalog/offerings?country=GH", {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(((await byCountry.json()) as { offerings: unknown[] }).offerings.length).toBe(1);

        // 8. Offering detail.
        const detail = await req(`/v1/catalog/offerings/${o.offering_id}`, {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(detail.status).toBe(200);

        // 9. A second user cannot mutate; CAN read.
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-cat2-${t}@e.com`, password: "password123" }),
        });
        const sess2 = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-cat2-${t}@e.com`, password: "password123" }),
        });
        const key2 = ((await sess2.json()) as { api_key: string }).api_key;
        const blocked = await req("/v1/catalog/pricing", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key2}` },
          body: JSON.stringify({
            provider_id: "demo.echo", capability_id: "demo.echo", capability_version: "1",
            model: "fixed", amount: "1", source_type: "provider_declared",
          }),
        });
        expect(blocked.status).toBe(403);
        const read = await req("/v1/catalog/offerings", {
          headers: { authorization: `Bearer ${key2}` },
        });
        expect(read.status).toBe(200);

        // 10. Missing auth → 401. Platform health still works.
        const noAuth = await req("/v1/catalog/offerings");
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
