// tests/api/capabilities-routes.test.ts — HTTP-level coverage of the WORK-005
// /v1/capabilities routes (real PG via withInfra, in-app Hono request).
// Covers happy paths + idempotency (API-002) + the capability-admin authority
// gate (§22). The security/capability-authority test covers the negative path
// (arbitrary org cannot mutate the global catalog).
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { createApi } from "@cp/api";
import { CapturingLogSink } from "../helpers.ts";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-capabilities-api",
  });
  const sink = new CapturingLogSink();
  const api = createApi({ loggerSink: sink, db });
  await api.migrate();
  const cleanup = async () => {
    await api.runtime.queue.stop();
    await db.close();
  };
  return { db, api, app: api.app, capabilities: api.capabilities, cleanup };
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

const SAMPLE_CONTRACT = {
  input_schema: {
    type: "object",
    properties: { recipient: { type: "string" }, body: { type: "string" } },
    required: ["recipient", "body"],
  },
  output_schema: {
    type: "object",
    properties: {
      provider_message_id: { type: "string" },
      accepted_at: { type: "string" },
    },
    required: ["provider_message_id"],
  },
  error_model: [{ code: "invalid_recipient", message: "bad recipient", retryable: false }],
  side_effect: "idempotent_write",
  idempotency_semantics: { supports_idempotency_key: true, strategy: "content_hash" },
  required_context: ["organization_id"],
  execution_modes: ["live"],
  policy_metadata: { pii: false },
};

describe("WORK-005 capability routes (real PG, in-app)", () => {
  it("bootstrap admin → create capability (idempotent) → publish → create version → publish → add dependency → inspect graph", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        const key = await registerLogin(app, `cap1-${t}@e.com`);
        // Get the caller's own user id (the /v1/auth/me route).
        const me = await app.request("/v1/auth/me", {
          headers: { authorization: `Bearer ${key}` },
        });
        const meBody = (await me.json()) as { user: { id: string } };
        const userId = meBody.user.id;
        // Bootstrap: the capability-admin table is empty, so the first
        // grant is allowed for any authenticated caller. Grant the caller's
        // own id so they become a capability admin.
        const grant = await app.request("/v1/capabilities/admins", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ user_id: userId }),
        });
        expect(grant.status).toBe(201);

        // Create a capability (idempotent — same Idempotency-Key).
        const idemKey = `cap-idem-${t}`;
        const body = JSON.stringify({ capability_id: "message.send", name: "Send a message" });
        const c1 = await app.request("/v1/capabilities", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "idempotency-key": idemKey,
          },
          body,
        });
        expect(c1.status).toBe(201);
        const cap = ((await c1.json()) as { capability: { id: string; capability_id: string; status: string } }).capability;
        expect(cap.capability_id).toBe("message.send");
        expect(cap.status).toBe("draft");

        // Replay → same id, replay header.
        const c2 = await app.request("/v1/capabilities", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "idempotency-key": idemKey,
          },
          body,
        });
        expect(c2.status).toBe(201);
        expect(c2.headers.get("x-idempotent-replay")).toBe("true");
        const cap2 = ((await c2.json()) as { capability: { id: string } }).capability;
        expect(cap2.id).toBe(cap.id);

        // Publish the capability (draft → active).
        const pub = await app.request(`/v1/capabilities/${encodeURIComponent("message.send")}/lifecycle`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ status: "active" }),
        });
        expect(pub.status).toBe(200);
        const pubBody = (await pub.json()) as { capability: { status: string } };
        expect(pubBody.capability.status).toBe("active");

        // Create + publish version 1.
        const v1c = await app.request(`/v1/capabilities/${encodeURIComponent("message.send")}/versions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ version: "1", contract: SAMPLE_CONTRACT }),
        });
        expect(v1c.status).toBe(201);
        const v1 = ((await v1c.json()) as { version: { version: string; status: string; contract: { side_effect: string } } }).version;
        expect(v1.version).toBe("1");
        expect(v1.status).toBe("draft");
        expect(v1.contract.side_effect).toBe("idempotent_write");
        const v1pub = await app.request(`/v1/capabilities/${encodeURIComponent("message.send")}/versions/1/lifecycle`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ status: "active" }),
        });
        expect(v1pub.status).toBe(200);

        // List versions.
        const lv = await app.request(`/v1/capabilities/${encodeURIComponent("message.send")}/versions`, {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(lv.status).toBe(200);
        const lvBody = (await lv.json()) as { versions: { version: string }[] };
        expect(lvBody.versions.length).toBe(1);

        // Create + publish a second capability to depend on.
        await app.request("/v1/capabilities", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ capability_id: "storage.put", name: "Storage put" }),
        });
        await app.request(`/v1/capabilities/${encodeURIComponent("storage.put")}/lifecycle`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ status: "active" }),
        });
        await app.request(`/v1/capabilities/${encodeURIComponent("storage.put")}/versions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ version: "1", contract: SAMPLE_CONTRACT }),
        });
        await app.request(`/v1/capabilities/${encodeURIComponent("storage.put")}/versions/1/lifecycle`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ status: "active" }),
        });

        // Add a dependency: message.send@1 → storage.put (NULL pin → active).
        const dep = await app.request(`/v1/capabilities/${encodeURIComponent("message.send")}/dependencies`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ version: "1", required_capability_id: "storage.put" }),
        });
        expect(dep.status).toBe(201);
        const depBody = (await dep.json()) as { dependency: { resolved_required_version: string } };
        expect(depBody.dependency.resolved_required_version).toBe("1");

        // Inspect the dependency graph.
        const g = await app.request(`/v1/capabilities/${encodeURIComponent("message.send")}/graph?version=1`, {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(g.status).toBe(200);
        const gBody = (await g.json()) as { graph: { direct_dependencies: unknown[]; edges: unknown[]; order: string[]; reachable: string[] } };
        expect(gBody.graph.direct_dependencies.length).toBe(1);
        expect(gBody.graph.edges.length).toBe(1);
        expect(gBody.graph.order.length).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });
  }, 120_000);

  it("a non-admin (arbitrary org owner) cannot create a capability (403 capability.admin.required)", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        // Register a user and create an org (the user becomes an org owner,
        // but is NOT a capability admin — the admin table is empty but no
        // one has bootstrapped, so the table-empty bootstrap path is the
        // ONLY way in; an org owner without a grant cannot mutate).
        const key = await registerLogin(app, `nonadmin-${t}@e.com`);
        await app.request("/v1/organizations", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ name: "Acme", slug: `acme-${t}` }),
        });
        // Try to create a capability → 403.
        const c = await app.request("/v1/capabilities", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ capability_id: "ai.generate", name: "Generate" }),
        });
        expect(c.status).toBe(403);
        const cBody = (await c.json()) as { error: { code: string; details?: { reason?: string } } };
        expect(cBody.error.code).toBe("capability.admin.required");
        expect(cBody.error.details?.reason).toBe("not_a_capability_admin");
      } finally {
        await cleanup();
      }
    });
  });

  it("missing auth → 401; reads require auth", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const list = await app.request("/v1/capabilities");
        expect(list.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  });
});
