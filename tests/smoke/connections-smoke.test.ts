// tests/smoke/connections-smoke.test.ts — WORK-010 real-HTTP smoke over a
// REAL TCP socket (serve({autoMigrate:true})) against REAL PostgreSQL +
// REAL Minio. Exercises the full connection lifecycle over the wire:
// authenticate → tenant → bootstrap → seed ACTIVE offering → create
// connection (idempotent) → activation REFUSED before verification →
// attach credential (secret-bearing, redacted idempotency: replay +
// different-secret 409) → verify (structural) → activate → member
// read/mutation gates → cross-org rejected → missing auth 401 → sentinel
// sweep over cp_idempotency → health 200.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase, S3CompatibleObjectStorage } from "@cp/platform";
import { serve } from "@cp/api";

describe("WORK-010 real-socket connections smoke", () => {
  it("authenticate → tenant → seed → connection lifecycle with credential → sentinel sweep → gates → 401 → health 200", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-smoke-connections",
      });
      const storage = new S3CompatibleObjectStorage({
        endpoint: handle.storage.endpoint,
        region: handle.storage.region,
        bucket: handle.storage.bucket,
        accessKeyId: handle.storage.accessKeyId,
        secretAccessKey: handle.storage.secretAccessKey,
        forcePathStyle: true,
      });
      const port = 50300 + Math.floor(Math.random() * 200);
      const base = `http://127.0.0.1:${port}`;
      const prevKey = process.env.CP_CREDENTIAL_MASTER_KEY;
      process.env.CP_CREDENTIAL_MASTER_KEY = "a".repeat(64);
      const api = await serve({
        port, hostname: "127.0.0.1", db, storage, autoMigrate: true,
      });
      try {
        // WORK-010 capability boundary (architect review of PR #9): the
        // served Api exposes NO credential capability — ordinary code
        // cannot reach secret-resolution authority.
        const apiSurface = api as unknown as Record<string, unknown>;
        expect(apiSurface.credentials).toBeUndefined();
        expect(apiSurface.credentialMutations).toBeUndefined();
        expect(apiSurface.adapterResolver).toBeUndefined();

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
          body: JSON.stringify({ email: `smk-conn-${t}@e.com`, password: "password123" }),
        });
        const sess = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-conn-${t}@e.com`, password: "password123" }),
        });
        expect(sess.status).toBe(201);
        const key = ((await sess.json()) as { api_key: string }).api_key;
        const auth = { "content-type": "application/json", authorization: `Bearer ${key}` };
        const me = await req("/v1/auth/me", { headers: { authorization: `Bearer ${key}` } });
        const userId = ((await me.json()) as { user: { id: string } }).user.id;

        // 2. Bootstrap + org + project.
        const boot = await api.capabilities.bootstrapCapabilityAdmin({ userId });
        expect(boot.granted).toBe(true);
        const orgRes = await req("/v1/organizations", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-cn-org-${t}` },
          body: JSON.stringify({ name: "Org", slug: `smk-cn-org-${t}` }),
        });
        expect(orgRes.status).toBe(201);
        const orgId = ((await orgRes.json()) as { organization: { id: string } }).organization.id;
        const projRes = await req(`/v1/organizations/${orgId}/projects`, {
          method: "POST",
          headers: { ...auth, "idempotency-key": `smk-cn-proj-${t}` },
          body: JSON.stringify({ name: "Proj", slug: `smk-cn-proj-${t}` }),
        });
        expect(projRes.status).toBe(201);
        const projectId = ((await projRes.json()) as { project: { id: string } }).project.id;

        // 3. Seed the ACTIVE demo.echo offering.
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
          headers: { ...auth, "idempotency-key": `smk-cn-cap-${t}` },
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
          headers: { ...auth, "idempotency-key": `smk-cn-prov-${t}` },
          body: JSON.stringify({ provider_id: "demo.echo", name: "Echo Demo Provider" }),
        });
        await req(`/v1/providers/${encodeURIComponent("demo.echo")}/capabilities`, {
          method: "POST", headers: auth,
          body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1" }),
        });
        await req(
          `/v1/providers/${encodeURIComponent("demo.echo")}/capabilities/${encodeURIComponent("demo.echo")}/versions/1/certification-tests`,
          { method: "POST", headers: auth, body: JSON.stringify({}) },
        );
        for (const status of ["integrating", "contract_tested", "observed"]) {
          await req(`/v1/providers/${encodeURIComponent("demo.echo")}/lifecycle`, {
            method: "POST", headers: auth, body: JSON.stringify({ status }),
          });
        }
        await db.exec({
          text: `UPDATE cp_providers SET status = 'active' WHERE provider_id = 'demo.echo'`,
          params: [],
        });

        // 4. Create the connection (idempotent).
        const connBase = `/v1/organizations/${orgId}/projects/${projectId}/connections`;
        const idem = `smk-cn-idem-${t}`;
        const connBody = JSON.stringify({
          provider_id: "demo.echo",
          capability_id: "demo.echo",
          capability_version: "1",
          environment: "production",
        });
        const c1 = await req(connBase, {
          method: "POST", headers: { ...auth, "idempotency-key": idem }, body: connBody,
        });
        expect(c1.status).toBe(201);
        const conn = ((await c1.json()) as { connection: { id: string; status: string } }).connection;
        expect(conn.status).toBe("draft");
        const c2 = await req(connBase, {
          method: "POST", headers: { ...auth, "idempotency-key": idem }, body: connBody,
        });
        expect(c2.headers.get("x-idempotent-replay")).toBe("true");

        // 5. Activation REFUSED before verification.
        const early = await req(`${connBase}/${conn.id}/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });
        expect(early.status).toBe(403);

        // 6. Attach the credential (SENTINEL secret; redacted idempotency).
        const SENTINEL = `SENTINEL-SMOKE-SECRET-${t}`;
        const credIdem = `smk-cn-cred-${t}`;
        const credBody = JSON.stringify({ kind: "api_key", name: "primary", secret_value: SENTINEL });
        const a1 = await req(`${connBase}/${conn.id}/credential`, {
          method: "POST", headers: { ...auth, "idempotency-key": credIdem }, body: credBody,
        });
        expect(a1.status).toBe(201);
        const a1Body = ((await a1.json()) as {
          connection: { credential: { credential_configured: boolean; credential_kind: string } | null };
        }).connection;
        expect(a1Body.credential!.credential_configured).toBe(true);
        expect(a1Body.credential!.credential_kind).toBe("api_key");
        // Replay → metadata only.
        const a2 = await req(`${connBase}/${conn.id}/credential`, {
          method: "POST", headers: { ...auth, "idempotency-key": credIdem }, body: credBody,
        });
        expect(a2.headers.get("x-idempotent-replay")).toBe("true");
        expect((await a2.text()).includes(SENTINEL)).toBe(false);
        // Different secret, same key → 409.
        const a3 = await req(`${connBase}/${conn.id}/credential`, {
          method: "POST",
          headers: { ...auth, "idempotency-key": credIdem },
          body: JSON.stringify({ kind: "api_key", name: "primary", secret_value: "DIFFERENT" }),
        });
        expect(a3.status).toBe(409);

        // 7. Verify → activate.
        const v = await req(`${connBase}/${conn.id}/verify`, {
          method: "POST", headers: auth, body: JSON.stringify({}),
        });
        expect(v.status).toBe(200);
        const vb = (await v.json()) as { verification: { passed: boolean } };
        expect(vb.verification.passed).toBe(true);
        const act = await req(`${connBase}/${conn.id}/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });
        expect(act.status).toBe(200);
        expect(((await act.json()) as { connection: { status: string } }).connection.status).toBe("active");

        // 8. SENTINEL SWEEP over cp_idempotency (the raw secret must never
        //    reach the idempotency store — only the redacted fingerprint).
        const sweep = await db.query({
          text: `SELECT count(*)::int AS n FROM cp_idempotency
                 WHERE request_body_hash LIKE '%' || $1 || '%'
                    OR response_body LIKE '%' || $1 || '%'`,
          params: [SENTINEL],
        });
        expect(Number(sweep[0]!.n)).toBe(0);

        // 9. A second user (org B) cannot access the connection (org gate).
        await req("/v1/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-conn2-${t}@e.com`, password: "password123" }),
        });
        const sess2 = await req("/v1/auth/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `smk-conn2-${t}@e.com`, password: "password123" }),
        });
        const key2 = ((await sess2.json()) as { api_key: string }).api_key;
        const foreign = await req(`${connBase}/${conn.id}`, {
          headers: { authorization: `Bearer ${key2}` },
        });
        expect(foreign.status).toBe(403);

        // 10. Missing auth → 401. Platform health still works.
        const noAuth = await req(connBase);
        expect(noAuth.status).toBe(401);
        const health = await req("/v1/platform/health");
        expect(health.status).toBe(200);
      } finally {
        await api.stop();
        await db.close();
        if (prevKey === undefined) {
          delete process.env.CP_CREDENTIAL_MASTER_KEY;
        } else {
          process.env.CP_CREDENTIAL_MASTER_KEY = prevKey;
        }
      }
    });
  }, 120_000);
});
