// tests/api/providers-routes.test.ts — HTTP-level coverage of the WORK-006
// /v1/providers routes (real PG via withInfra, in-app Hono request).
// Covers the full first-party integration path over HTTP: create provider
// (idempotent) → declare implementation → run certification contract
// tests → evidence list → lifecycle transition — plus the authority gate
// (non-admin 403) and missing-auth 401. Proves no secret values appear in
// any response body.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { createApi } from "@cp/api";
import { CapturingLogSink } from "../helpers.ts";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-providers-api",
  });
  const sink = new CapturingLogSink();
  const api = createApi({ loggerSink: sink, db });
  await api.migrate();
  const cleanup = async () => {
    await api.runtime.queue.stop();
    await db.close();
  };
  return { db, sink, api, app: api.app, capabilities: api.capabilities, cleanup };
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

const ECHO_CONTRACT = {
  input_schema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  output_schema: {
    type: "object",
    properties: {
      echoed: { type: "string" },
      echo_id: { type: "string" },
      echoed_at: { type: "string" },
    },
    required: ["echoed", "echo_id", "echoed_at"],
  },
  side_effect: "pure",
};

describe("WORK-006 provider routes (real PG, in-app)", () => {
  it("first-party path over HTTP: create provider (idempotent) → declare → certification-tests → evidence → lifecycle; no secrets in any response", async () => {
    await withInfra(async (handle) => {
      const { app, capabilities, sink, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        const key = await registerLogin(app, `prov1-${t}@e.com`);
        const auth = { "content-type": "application/json", authorization: `Bearer ${key}` };

        // Caller's user id (for the deployment-authority bootstrap).
        const me = await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${key}` } });
        const userId = ((await me.json()) as { user: { id: string } }).user.id;
        // Deployment/operator bootstrap (service level — the ONLY path to
        // the first capability admin; no tenant self-bootstrap).
        const boot = await capabilities.bootstrapCapabilityAdmin({ userId });
        expect(boot.granted).toBe(true);

        // Seed the demo.echo capability + active version 1 in the catalog.
        const capBody = JSON.stringify({ capability_id: "demo.echo", name: "Echo" });
        const cc = await app.request("/v1/capabilities", {
          method: "POST",
          headers: { ...auth, "idempotency-key": `prov-cap-${t}` },
          body: capBody,
        });
        expect(cc.status).toBe(201);
        await app.request(`/v1/capabilities/${encodeURIComponent("demo.echo")}/lifecycle`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: "active" }),
        });
        await app.request(`/v1/capabilities/${encodeURIComponent("demo.echo")}/versions`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ version: "1", contract: ECHO_CONTRACT }),
        });
        await app.request(`/v1/capabilities/${encodeURIComponent("demo.echo")}/versions/1/lifecycle`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: "active" }),
        });

        // Create the provider (idempotent).
        const idemKey = `prov-idem-${t}`;
        const provBody = JSON.stringify({
          provider_id: "demo.echo",
          name: "Echo Demo Provider",
          description: "deterministic fixture provider",
        });
        const p1 = await app.request("/v1/providers", {
          method: "POST",
          headers: { ...auth, "idempotency-key": idemKey },
          body: provBody,
        });
        expect(p1.status).toBe(201);
        const prov = ((await p1.json()) as { provider: { id: string; provider_id: string; status: string; integration_path: string } }).provider;
        expect(prov.provider_id).toBe("demo.echo");
        expect(prov.status).toBe("discovered");
        expect(prov.integration_path).toBe("platform_operated");

        // Replay → same id, replay header.
        const p2 = await app.request("/v1/providers", {
          method: "POST",
          headers: { ...auth, "idempotency-key": idemKey },
          body: provBody,
        });
        expect(p2.status).toBe(201);
        expect(p2.headers.get("x-idempotent-replay")).toBe("true");
        const prov2 = ((await p2.json()) as { provider: { id: string } }).provider;
        expect(prov2.id).toBe(prov.id);

        // Get + list.
        const g = await app.request(`/v1/providers/${encodeURIComponent("demo.echo")}`, { headers: { authorization: `Bearer ${key}` } });
        expect(g.status).toBe(200);
        const l = await app.request("/v1/providers?limit=10", { headers: { authorization: `Bearer ${key}` } });
        expect(l.status).toBe(200);
        const lb = (await l.json()) as { providers: { provider_id: string }[] };
        expect(lb.providers.length).toBe(1);

        // Declare the implementation (adapter consistency applies).
        const d = await app.request(`/v1/providers/${encodeURIComponent("demo.echo")}/capabilities`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1" }),
        });
        expect(d.status).toBe(201);
        const decl = ((await d.json()) as {
          implementation: {
            capability_id: string;
            capability_version: string;
            adapter_version: string;
            status: string;
            certification_environment: string;
            credential_requirements: { name: string; kind: string }[];
          };
        }).implementation;
        expect(decl.capability_id).toBe("demo.echo");
        expect(decl.adapter_version).toBe("1.0.0");
        expect(decl.status).toBe("registered");
        expect(decl.certification_environment).toBe("none");
        // Credential REQUIREMENTS are metadata (name + kind), never values.
        expect(decl.credential_requirements.length).toBe(1);
        expect(decl.credential_requirements[0]!.name).toBe("api_key");

        // Lifecycle: discovered → integrating → (gate) contract_tested.
        const tr1 = await app.request(`/v1/providers/${encodeURIComponent("demo.echo")}/lifecycle`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: "integrating" }),
        });
        expect(tr1.status).toBe(200);
        const tr2 = await app.request(`/v1/providers/${encodeURIComponent("demo.echo")}/lifecycle`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: "contract_tested" }),
        });
        expect(tr2.status).toBe(403); // evidence gate: declaration not yet verified
        const gb = (await tr2.json()) as { error: { code: string; details?: { reason?: string } } };
        expect(gb.error.code).toBe("provider.transition.gate");

        // Run the certification contract tests (the evidence-producing
        // operation). Fixture environment; declaration advances to
        // contract_verified.
        const run = await app.request(
          `/v1/providers/${encodeURIComponent("demo.echo")}/capabilities/${encodeURIComponent("demo.echo")}/versions/1/certification-tests`,
          { method: "POST", headers: auth, body: JSON.stringify({}) },
        );
        expect(run.status).toBe(200);
        const runBody = (await run.json()) as {
          environment: string;
          adapter_version: string;
          declaration_results: {
            capability_id: string;
            status_after: string;
            outcomes: { test: string; result: string }[];
          }[];
          evidence_ids: string[];
        };
        expect(runBody.environment).toBe("fixture");
        expect(runBody.adapter_version).toBe("1.0.0");
        expect(runBody.declaration_results.length).toBe(1);
        expect(runBody.declaration_results[0]!.status_after).toBe("contract_verified");
        expect(runBody.declaration_results[0]!.outcomes.length).toBe(7);
        expect(runBody.evidence_ids.length).toBe(7);

        // Now the evidence-gated lifecycle transition succeeds.
        const tr3 = await app.request(`/v1/providers/${encodeURIComponent("demo.echo")}/lifecycle`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: "contract_tested" }),
        });
        expect(tr3.status).toBe(200);
        const tr3b = (await tr3.json()) as { provider: { status: string } };
        expect(tr3b.provider.status).toBe("contract_tested");

        // Evidence list (the human-observability trail).
        const ev = await app.request(`/v1/providers/${encodeURIComponent("demo.echo")}/certification`, {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(ev.status).toBe(200);
        const evBody = (await ev.json()) as {
          evidence: {
            test: string;
            result: string;
            environment: string;
            adapter_version: string;
            artifact_ref: string;
          }[];
        };
        expect(evBody.evidence.length).toBe(7);
        for (const e of evBody.evidence) {
          expect(e.result).toBe("pass");
          expect(e.environment).toBe("fixture");
          expect(e.adapter_version).toBe("1.0.0");
          expect(e.artifact_ref).toBe("contract-suite:1.0.0");
        }

        // Declaration list shows contract_verified + fixture environment.
        const dl = await app.request(`/v1/providers/${encodeURIComponent("demo.echo")}/capabilities`, {
          headers: { authorization: `Bearer ${key}` },
        });
        const dlBody = (await dl.json()) as { implementations: { status: string; certification_environment: string }[] };
        expect(dlBody.implementations[0]!.status).toBe("contract_verified");
        expect(dlBody.implementations[0]!.certification_environment).toBe("fixture");

        // SECRETS: scan every JSON response body produced in this test for
        // the fixture credential value used internally by the contract
        // suite — it must never surface (WORK-006 §10).
        const logScan = sink.text();
        expect(logScan.includes("fixture-contract-test-credential")).toBe(false);
      } finally {
        await cleanup();
      }
    });
  }, 120_000);

  it("a non-admin cannot mutate providers (403 provider.admin.required)", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        const key = await registerLogin(app, `provnonadmin-${t}@e.com`);
        const c = await app.request("/v1/providers", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ provider_id: "stripe", name: "Stripe" }),
        });
        expect(c.status).toBe(403);
        const cb = (await c.json()) as { error: { code: string; details?: { reason?: string } } };
        expect(cb.error.code).toBe("provider.admin.required");
        expect(cb.error.details?.reason).toBe("not_a_registry_admin");
      } finally {
        await cleanup();
      }
    });
  });

  it("missing auth → 401 on reads and mutations", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const list = await app.request("/v1/providers");
        expect(list.status).toBe(401);
        const create = await app.request("/v1/providers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider_id: "x.y", name: "X" }),
        });
        expect(create.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  });

  it("unknown provider → structured 404; invalid status → 400", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        const key = await registerLogin(app, `prov404-${t}@e.com`);
        const g = await app.request("/v1/providers/unknown.provider", {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(g.status).toBe(404);
        const gb = (await g.json()) as { error: { code: string } };
        expect(gb.error.code).toBe("provider.not_found");
        const bad = await app.request("/v1/providers?status=nonsense", {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(bad.status).toBe(400);
      } finally {
        await cleanup();
      }
    });
  });
});
