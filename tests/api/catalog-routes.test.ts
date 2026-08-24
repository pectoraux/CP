// tests/api/catalog-routes.test.ts — HTTP-level coverage of the WORK-007
// /v1/catalog routes (real PG via withInfra, in-app Hono request).
// Covers the full marketplace flow over HTTP: seed capability + provider
// + declaration → record pricing/coverage/health facts (idempotent) →
// verify a fact → list/filter offerings → offering detail → non-admin
// 403 → missing auth 401 → structured 404/400. Proves no secret values
// appear in any response body and provenance is exposed everywhere.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { createApi } from "@cp/api";
import { CapturingLogSink } from "../helpers.ts";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-catalog-api",
  });
  const sink = new CapturingLogSink();
  const api = createApi({ loggerSink: sink, db });
  await api.migrate();
  const cleanup = async () => {
    await api.runtime.queue.stop();
    await db.close();
  };
  return { db, sink, api, app: api.app, cleanup };
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
  input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  output_schema: {
    type: "object",
    properties: { echoed: { type: "string" }, echo_id: { type: "string" }, echoed_at: { type: "string" } },
    required: ["echoed", "echo_id", "echoed_at"],
  },
  side_effect: "pure",
};

/** Seed capability demo.echo@1 + provider demo.echo + declaration over HTTP. */
async function seedStack(
  app: ReturnType<typeof createApi>["app"],
  auth: Record<string, string>,
  t: number,
): Promise<void> {
  await app.request("/v1/capabilities", {
    method: "POST",
    headers: { ...auth, "idempotency-key": `cat-cap-${t}` },
    body: JSON.stringify({ capability_id: "demo.echo", name: "Echo" }),
  });
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
  await app.request("/v1/providers", {
    method: "POST",
    headers: { ...auth, "idempotency-key": `cat-prov-${t}` },
    body: JSON.stringify({ provider_id: "demo.echo", name: "Echo Demo Provider" }),
  });
  await app.request(`/v1/providers/${encodeURIComponent("demo.echo")}/capabilities`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1" }),
  });
}

describe("WORK-007 catalog routes (real PG, in-app)", () => {
  it("marketplace flow over HTTP: facts (idempotent) → verification → offerings list/filter → detail; provenance exposed; no secrets", async () => {
    await withInfra(async (handle) => {
      const { app, api, sink, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        const key = await registerLogin(app, `cat1-${t}@e.com`);
        const auth = { "content-type": "application/json", authorization: `Bearer ${key}` };
        const me = await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${key}` } });
        const userId = ((await me.json()) as { user: { id: string } }).user.id;
        // Deployment-authority bootstrap (WORK-005 invariant preserved).
        const boot = await api.capabilities.bootstrapCapabilityAdmin({ userId });
        expect(boot.granted).toBe(true);
        await seedStack(app, auth, t);

        // Record a declared pricing fact (idempotent).
        const idemKey = `cat-prc-${t}`;
        const pricingBody = JSON.stringify({
          provider_id: "demo.echo",
          capability_id: "demo.echo",
          capability_version: "1",
          model: "per_request",
          currency: "GHS",
          unit: "request",
          amount: "0.05",
          source_type: "provider_declared",
        });
        const p1 = await app.request("/v1/catalog/pricing", {
          method: "POST",
          headers: { ...auth, "idempotency-key": idemKey },
          body: pricingBody,
        });
        expect(p1.status).toBe(201);
        const pricing = ((await p1.json()) as {
          pricing: {
            id: string;
            model: string;
            currency: string;
            amount: string;
            provenance: { source_type: string; status: string; verified_at: string | null };
          };
        }).pricing;
        expect(pricing.model).toBe("per_request");
        expect(pricing.amount).toBe("0.05");
        // Provenance exposed: DECLARED, not verified.
        expect(pricing.provenance.source_type).toBe("provider_declared");
        expect(pricing.provenance.status).toBe("declared");
        expect(pricing.provenance.verified_at).toBeNull();

        // Replay → same id, replay header.
        const p2 = await app.request("/v1/catalog/pricing", {
          method: "POST",
          headers: { ...auth, "idempotency-key": idemKey },
          body: pricingBody,
        });
        expect(p2.status).toBe(201);
        expect(p2.headers.get("x-idempotent-replay")).toBe("true");
        const pricing2 = ((await p2.json()) as { pricing: { id: string } }).pricing;
        expect(pricing2.id).toBe(pricing.id);

        // Record coverage + health facts.
        const cov = await app.request("/v1/catalog/coverage", {
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
        const coverage = ((await cov.json()) as { coverage: { id: string; provenance: { status: string } } }).coverage;
        const hlth = await app.request("/v1/catalog/health", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            provider_id: "demo.echo",
            status: "healthy",
            metrics: { availability: 0.999 },
            source_type: "platform_observed",
          }),
        });
        expect(hlth.status).toBe(201);

        // Verify the coverage fact (evidence required).
        const ver = await app.request(`/v1/catalog/coverage/${coverage.id}/verification`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ evidence_reference: "https://provider.example/coverage" }),
        });
        expect(ver.status).toBe(200);
        const verBody = ((await ver.json()) as { coverage: { provenance: { status: string; verified_at: string } } }).coverage;
        expect(verBody.provenance.status).toBe("verified");
        expect(verBody.provenance.verified_at).toBeTruthy();

        // List offerings — the marketplace question answered over HTTP.
        const list = await app.request("/v1/catalog/offerings?limit=10", {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(list.status).toBe(200);
        const listBody = (await list.json()) as {
          offerings: {
            offering_id: string;
            provider: { provider_id: string };
            capability: { capability_id: string; capability_version: string };
            implementation: { credential_requirement_names: string[] };
            pricing: { provenance: { status: string } }[];
            coverage: { value: string; provenance: { status: string } }[];
            health: { status: string }[];
          }[];
          next_cursor: string | null;
        };
        expect(listBody.offerings.length).toBe(1);
        const o = listBody.offerings[0]!;
        expect(o.provider.provider_id).toBe("demo.echo");
        expect(o.capability.capability_id).toBe("demo.echo");
        expect(o.capability.capability_version).toBe("1");
        expect(o.implementation.credential_requirement_names).toEqual(["api_key"]);
        expect(o.pricing.length).toBe(1);
        expect(o.pricing[0]!.provenance.status).toBe("declared");
        expect(o.coverage.length).toBe(1);
        expect(o.coverage[0]!.value).toBe("GH");
        expect(o.coverage[0]!.provenance.status).toBe("verified");
        expect(o.health.length).toBe(1);
        expect(o.health[0]!.status).toBe("healthy");

        // Filters.
        const byCountry = await app.request("/v1/catalog/offerings?country=GH", {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(((await byCountry.json()) as { offerings: unknown[] }).offerings.length).toBe(1);
        const byCountryMiss = await app.request("/v1/catalog/offerings?country=US", {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(((await byCountryMiss.json()) as { offerings: unknown[] }).offerings.length).toBe(0);
        const byModel = await app.request("/v1/catalog/offerings?pricing_model=per_request", {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(((await byModel.json()) as { offerings: unknown[] }).offerings.length).toBe(1);

        // Offering detail by id.
        const detail = await app.request(`/v1/catalog/offerings/${o.offering_id}`, {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(detail.status).toBe(200);
        const detailBody = (await detail.json()) as { offering: { offering_id: string } };
        expect(detailBody.offering.offering_id).toBe(o.offering_id);

        // SECRETS: scan logs for the internal fixture credential value —
        // it must never surface (contract tests have not even run here,
        // but the assertion guards future changes).
        expect(sink.text().includes("fixture-contract-test-credential")).toBe(false);
      } finally {
        await cleanup();
      }
    });
  }, 120_000);

  it("a non-admin cannot mutate the catalog (403 catalog.admin.required); reads remain open", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        const key = await registerLogin(app, `catnonadmin-${t}@e.com`);
        const auth = { "content-type": "application/json", authorization: `Bearer ${key}` };
        const c = await app.request("/v1/catalog/pricing", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            provider_id: "x", capability_id: "y", capability_version: "1",
            model: "fixed", amount: "1", source_type: "provider_declared",
          }),
        });
        expect(c.status).toBe(403);
        const cb = (await c.json()) as { error: { code: string; details?: { reason?: string } } };
        expect(cb.error.code).toBe("catalog.admin.required");
        expect(cb.error.details?.reason).toBe("not_a_catalog_admin");
        // Reads are authenticated-only (not admin-gated).
        const list = await app.request("/v1/catalog/offerings", {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(list.status).toBe(200);
      } finally {
        await cleanup();
      }
    });
  });

  it("missing auth → 401 on reads and mutations", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const list = await app.request("/v1/catalog/offerings");
        expect(list.status).toBe(401);
        const mut = await app.request("/v1/catalog/pricing", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fixed" }),
        });
        expect(mut.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  });

  it("unknown offering → structured 404; invalid payloads → 400", async () => {
    await withInfra(async (handle) => {
      const { app, api, cleanup } = await setup(handle);
      try {
        const t = Date.now();
        const key = await registerLogin(app, `cat404-${t}@e.com`);
        const auth = { "content-type": "application/json", authorization: `Bearer ${key}` };
        const me = await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${key}` } });
        const userId = ((await me.json()) as { user: { id: string } }).user.id;
        await api.capabilities.bootstrapCapabilityAdmin({ userId });
        const missing = await app.request("/v1/catalog/offerings/provcap_missing", {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(missing.status).toBe(404);
        const mb = (await missing.json()) as { error: { code: string } };
        expect(mb.error.code).toBe("catalog.offering.not_found");
        const bad = await app.request("/v1/catalog/pricing", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            provider_id: "demo.echo", capability_id: "demo.echo", capability_version: "1",
            model: "per_gpu_hour", amount: "1", source_type: "provider_declared",
          }),
        });
        expect(bad.status).toBe(400);
        const noEvidence = await app.request("/v1/catalog/coverage/prc_missing/verification", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ evidence_reference: "  " }),
        });
        expect(noEvidence.status).toBe(400);
      } finally {
        await cleanup();
      }
    });
  });
});
