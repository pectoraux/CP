// tests/smoke/capabilities-smoke.test.ts — WORK-005 real-HTTP smoke over a
// REAL TCP socket (serve({autoMigrate:true})) against REAL PostgreSQL.
// Exercises the full authenticate → bootstrap capability-admin → create
// capability (idempotent) → publish → create+publish version → add
// dependency → inspect graph → non-admin rejected → missing auth 401 →
// health 200 path. Uses autoMigrate:true so the readiness gate runs the
// auth+organizations+projects+capabilities+idempotency migrations before
// binding the listener (proving the gate covers the WORK-005 schemas too).
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { serve } from "@cp/api";

describe("WORK-005 real-socket capability smoke", () => {
  it("authenticate → bootstrap admin → create capability (idempotent) → publish → version → dependency → graph → non-admin 403 → 401 → health 200", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-smoke-capabilities",
      });
      const port = 49000 + Math.floor(Math.random() * 1000);
      const base = `http://127.0.0.1:${port}`;
      // serve({ autoMigrate: true }) runs ALL schema migrations (auth +
      // organizations + projects + capabilities + idempotency) before
      // binding the listener.
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

        // 1. Register + login.
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-cap-${t}@e.com`, password: "password123" }),
        });
        const sess = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-cap-${t}@e.com`, password: "password123" }),
        });
        expect(sess.status).toBe(201);
        const key = ((await sess.json()) as { api_key: string }).api_key;

        // 2. Get the caller's user id.
        const me = await req("/v1/auth/me", { method: "GET", headers: { authorization: `Bearer ${key}` } });
        const userId = ((await me.json()) as { user: { id: string } }).user.id;

        // 3. Bootstrap: grant the caller capability-admin (table empty).
        const grant = await req("/v1/capabilities/admins", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ user_id: userId }),
        });
        expect(grant.status).toBe(201);

        // 4. Create a capability (idempotent — same Idempotency-Key).
        const idemKey = `smk-cap-idem-${t}`;
        const capBody = JSON.stringify({
          capability_id: "payment.accept",
          name: "Accept a payment",
        });
        const pc1 = await req("/v1/capabilities", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "idempotency-key": idemKey,
          },
          body: capBody,
        });
        expect(pc1.status).toBe(201);
        const cap = ((await pc1.json()) as { capability: { id: string; capability_id: string } }).capability;
        expect(cap.capability_id).toBe("payment.accept");

        // 5. Replay the same Idempotency-Key + body → same id, replay header.
        const pc2 = await req("/v1/capabilities", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "idempotency-key": idemKey,
          },
          body: capBody,
        });
        expect(pc2.status).toBe(201);
        expect(pc2.headers.get("x-idempotent-replay")).toBe("true");
        const cap2 = ((await pc2.json()) as { capability: { id: string } }).capability;
        expect(cap2.id).toBe(cap.id);

        // 6. Publish the capability.
        const pub = await req(`/v1/capabilities/${encodeURIComponent("payment.accept")}/lifecycle`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ status: "active" }),
        });
        expect(pub.status).toBe(200);

        // 7. Create + publish version 1.
        const vc = await req(`/v1/capabilities/${encodeURIComponent("payment.accept")}/versions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            version: "1",
            contract: {
              input_schema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
              output_schema: { type: "object", properties: { charge_id: { type: "string" } } },
              side_effect: "idempotent_write",
            },
          }),
        });
        expect(vc.status).toBe(201);
        const vpub = await req(`/v1/capabilities/${encodeURIComponent("payment.accept")}/versions/1/lifecycle`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ status: "active" }),
        });
        expect(vpub.status).toBe(200);

        // 8. List capabilities (paginated).
        const list = await req("/v1/capabilities?limit=10", {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        expect(list.status).toBe(200);
        const lb = (await list.json()) as { capabilities: { capability_id: string }[] };
        expect(lb.capabilities.length).toBe(1);
        expect(lb.capabilities[0]!.capability_id).toBe("payment.accept");

        // 9. Create a second capability + version, then add a dependency.
        await req("/v1/capabilities", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ capability_id: "fraud.check", name: "Fraud check" }),
        });
        await req(`/v1/capabilities/${encodeURIComponent("fraud.check")}/lifecycle`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ status: "active" }),
        });
        await req(`/v1/capabilities/${encodeURIComponent("fraud.check")}/versions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ version: "1", contract: { input_schema: { type: "object" }, output_schema: { type: "object" }, side_effect: "read_only" } }),
        });
        await req(`/v1/capabilities/${encodeURIComponent("fraud.check")}/versions/1/lifecycle`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ status: "active" }),
        });
        const dep = await req(`/v1/capabilities/${encodeURIComponent("payment.accept")}/dependencies`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ version: "1", required_capability_id: "fraud.check" }),
        });
        expect(dep.status).toBe(201);

        // 10. Inspect the dependency graph.
        const g = await req(`/v1/capabilities/${encodeURIComponent("payment.accept")}/graph?version=1`, {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
        });
        expect(g.status).toBe(200);
        const gb = (await g.json()) as { graph: { direct_dependencies: unknown[]; edges: unknown[]; order: string[] } };
        expect(gb.graph.direct_dependencies.length).toBe(1);
        expect(gb.graph.edges.length).toBe(1);

        // 11. Register a second user (no capability-admin grant) → cannot
        //     create a capability (403 capability.admin.required).
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-cap2-${t}@e.com`, password: "password123" }),
        });
        const sess2 = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-cap2-${t}@e.com`, password: "password123" }),
        });
        const key2 = ((await sess2.json()) as { api_key: string }).api_key;
        const blocked = await req("/v1/capabilities", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key2}` },
          body: JSON.stringify({ capability_id: "ai.generate", name: "Gen" }),
        });
        expect(blocked.status).toBe(403);
        const bb = (await blocked.json()) as { error: { code: string; details?: { reason?: string } } };
        expect(bb.error.code).toBe("capability.admin.required");
        expect(bb.error.details?.reason).toBe("not_a_capability_admin");

        // 12. But user2 CAN read the catalog (globally readable).
        const read = await req("/v1/capabilities?limit=10", {
          method: "GET",
          headers: { authorization: `Bearer ${key2}` },
        });
        expect(read.status).toBe(200);

        // 13. Missing auth → 401.
        const noAuth = await req("/v1/capabilities", { method: "GET" });
        expect(noAuth.status).toBe(401);

        // 14. Platform health still works (WORK-001 preserved).
        const health = await req("/v1/platform/health");
        expect(health.status).toBe(200);
      } finally {
        await api.stop();
        await db.close();
      }
    });
  }, 120_000);
});
