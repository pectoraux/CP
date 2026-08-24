// tests/api/eligibility-routes.test.ts — HTTP-level coverage of the
// WORK-009 /v1/organizations/:orgId/projects/:projectId/eligibility/evaluate
// route (real PG via withInfra, in-app Hono request). Covers the full
// evaluation flow over HTTP: tenant gates, idempotent evaluation,
// explainable results (hard vs preference vs indeterminate), named
// providers, capability summary, structured errors, and cross-tenant
// rejection.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { createApi } from "@cp/api";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-eligibility-api",
  });
  const api = createApi({ db });
  await api.migrate();
  const cleanup = async () => {
    await api.runtime.queue.stop();
    await db.close();
  };
  return { db, api, app: api.app, cleanup };
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

interface Tenant {
  orgId: string;
  projectId: string;
  ownerKey: string;
  memberKey: string;
  memberUserId: string;
}

async function makeTenant(
  app: ReturnType<typeof createApi>["app"],
  api: ReturnType<typeof createApi>,
  t: string,
): Promise<Tenant> {
  const ownerKey = await registerLogin(app, `elig-owner-${t}@e.com`);
  const memberKey = await registerLogin(app, `elig-member-${t}@e.com`);
  const auth = { "content-type": "application/json", authorization: `Bearer ${ownerKey}` };
  const orgRes = await app.request("/v1/organizations", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Org", slug: `elig-org-${t}` }),
  });
  const orgId = ((await orgRes.json()) as { organization: { id: string } }).organization.id;
  const meMember = await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${memberKey}` } });
  const memberUserId = ((await meMember.json()) as { user: { id: string } }).user.id;
  await app.request(`/v1/organizations/${orgId}/memberships`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ user_id: memberUserId, role: "member" }),
  });
  const projRes = await app.request(`/v1/organizations/${orgId}/projects`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Proj", slug: `elig-proj-${t}` }),
  });
  const projectId = ((await projRes.json()) as { project: { id: string } }).project.id;
  void api;
  return { orgId, projectId, ownerKey, memberKey, memberUserId };
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

/** Seed the global demo.echo offering (capability@1 + provider + declaration)
 * with the provider in the AUTHORITATIVE ACTIVE lifecycle state (only the
 * active state is eligible — architect review of PR #8). The `active`
 * state's live-certification evidence gate is unreachable with the fixture
 * adapter, so the final state is set via the providers service with the
 * deployment-bootstrapped admin — this helper seeds an ELIGIBILITY
 * candidate; the provider lifecycle itself is WORK-006's tested surface.
 */
async function seedEcho(
  app: ReturnType<typeof createApi>["app"],
  api: ReturnType<typeof createApi>,
  ownerKey: string,
  t: string,
): Promise<void> {
  const auth = { "content-type": "application/json", authorization: `Bearer ${ownerKey}` };
  await app.request("/v1/capabilities", {
    method: "POST",
    headers: { ...auth, "idempotency-key": `elig-cap-${t}` },
    body: JSON.stringify({ capability_id: "demo.echo", name: "Echo" }),
  });
  await app.request(`/v1/capabilities/${encodeURIComponent("demo.echo")}/lifecycle`, {
    method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
  });
  await app.request(`/v1/capabilities/${encodeURIComponent("demo.echo")}/versions`, {
    method: "POST", headers: auth, body: JSON.stringify({ version: "1", contract: ECHO_CONTRACT }),
  });
  await app.request(`/v1/capabilities/${encodeURIComponent("demo.echo")}/versions/1/lifecycle`, {
    method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
  });
  await app.request("/v1/providers", {
    method: "POST",
    headers: { ...auth, "idempotency-key": `elig-prov-${t}` },
    body: JSON.stringify({ provider_id: "demo.echo", name: "Echo Demo Provider" }),
  });
  await app.request(`/v1/providers/${encodeURIComponent("demo.echo")}/capabilities`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1" }),
  });
  // Fixture contract tests → declaration contract_verified (evidence for
  // the contract_tested step), then walk the evidence-gated lifecycle.
  await app.request(
    `/v1/providers/${encodeURIComponent("demo.echo")}/capabilities/${encodeURIComponent("demo.echo")}/versions/1/certification-tests`,
    { method: "POST", headers: auth, body: JSON.stringify({}) },
  );
  for (const status of ["integrating", "contract_tested", "observed"]) {
    await app.request(`/v1/providers/${encodeURIComponent("demo.echo")}/lifecycle`, {
      method: "POST", headers: auth, body: JSON.stringify({ status }),
    });
  }
  // Final authoritative ACTIVE state: the HTTP `certified` gate requires
  // live evidence (fixture-unreachable) — set it via the api's runtime
  // database handle (PostgresDatabase from createApi's injected db).
  const db = (api as unknown as { runtime: { db: { exec: (o: { text: string; params: unknown[] }) => Promise<unknown> } } }).runtime.db;
  await db.exec({
    text: `UPDATE cp_providers SET status = 'active' WHERE provider_id = $1`,
    params: ["demo.echo"],
  });
}

/** Create + activate a policy in the tenant's project; returns {policyId}. */
async function seedPolicy(
  app: ReturnType<typeof createApi>["app"],
  tenant: Tenant,
  name: string,
  rules: unknown[],
): Promise<string> {
  const base = `/v1/organizations/${tenant.orgId}/projects/${tenant.projectId}/policies`;
  const auth = { "content-type": "application/json", authorization: `Bearer ${tenant.ownerKey}` };
  const p = await app.request(base, {
    method: "POST", headers: auth, body: JSON.stringify({ name }),
  });
  const policyId = ((await p.json()) as { policy: { id: string } }).policy.id;
  const v = await app.request(`${base}/${policyId}/versions`, {
    method: "POST", headers: auth, body: JSON.stringify({ rules }),
  });
  const version = ((await v.json()) as { version: { version: string } }).version.version;
  await app.request(`${base}/${policyId}/versions/${version}/lifecycle`, {
    method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
  });
  return policyId;
}

describe("WORK-009 eligibility routes (real PG, in-app)", () => {
  it("full evaluation over HTTP: eligible + explainable ineligible + named providers + idempotency", async () => {
    await withInfra(async (handle) => {
      const { app, api, cleanup } = await setup(handle);
      try {
        const t = `${Date.now()}`;
        const tenant = await makeTenant(app, api, t);
        // Bootstrap the capability admin FIRST (the catalog mutations in
        // seedEcho require the grant).
        const ownerAuth = { "content-type": "application/json", authorization: `Bearer ${tenant.ownerKey}` };
        const me = await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${tenant.ownerKey}` } });
        const userId = ((await me.json()) as { user: { id: string } }).user.id;
        await api.capabilities.bootstrapCapabilityAdmin({ userId });
        await seedEcho(app, api, tenant.ownerKey, t);
        await app.request("/v1/catalog/pricing", {
          method: "POST", headers: ownerAuth,
          body: JSON.stringify({
            provider_id: "demo.echo", capability_id: "demo.echo", capability_version: "1",
            model: "per_request", currency: "GHS", amount: "0.05", source_type: "provider_declared",
          }),
        });
        await app.request("/v1/catalog/coverage", {
          method: "POST", headers: ownerAuth,
          body: JSON.stringify({
            provider_id: "demo.echo", capability_id: "demo.echo", capability_version: "1",
            dimension: "country", value: "GH", source_type: "provider_declared",
          }),
        });
        const policyId = await seedPolicy(app, tenant, "gh-policy", [
          { subject: "country", operator: "eq", value: "GH", mode: "hard" },
          { subject: "integration_path", operator: "eq", value: "provider_operated", mode: "preference" },
        ]);
        const base = `/v1/organizations/${tenant.orgId}/projects/${tenant.projectId}/eligibility`;
        const memberAuth = { "content-type": "application/json", authorization: `Bearer ${tenant.memberKey}` };

        // Eligible evaluation (member allowed): hard country GH passes via
        // request fact; preference violated (platform_operated offering) but
        // the candidate REMAINS eligible.
        const idem = `elig-idem-${t}`;
        const body = JSON.stringify({
          capability_id: "demo.echo",
          capability_version: "1",
          policy_id: policyId,
          context: { country: "GH", max_estimated_cost: 0.1 },
        });
        const e1 = await app.request(`${base}/evaluate`, {
          method: "POST", headers: { ...memberAuth, "idempotency-key": idem }, body,
        });
        expect(e1.status).toBe(200);
        const e1Body = (await e1.json()) as {
          eligibility: {
            capability: { exists: boolean; version_exists: boolean };
            policy: { policy_id: string; policy_version: string };
            results: {
              status: string;
              candidate: { provider: { provider_id: string } };
              checks: { check_id: string; result: string; expected: unknown; actual: unknown; reason: string }[];
              policy: { hard_passed: boolean; preference_violated: string[] } | null;
              snapshot: { per_request_pricing_fact: { amount: string } | null };
            }[];
            summary: { evaluated: number; eligible: number; ineligible: number; indeterminate: number };
          };
        };
        const ev = e1Body.eligibility;
        expect(ev.capability.exists).toBe(true);
        expect(ev.capability.version_exists).toBe(true);
        expect(ev.policy.policy_id).toBe(policyId);
        expect(ev.summary.evaluated).toBe(1);
        expect(ev.summary.eligible).toBe(1);
        const r = ev.results[0]!;
        expect(r.status).toBe("eligible");
        expect(r.candidate.provider.provider_id).toBe("demo.echo");
        expect(r.policy?.hard_passed).toBe(true);
        expect(r.policy?.preference_violated).toEqual(["rule_2"]); // recorded, never disqualifying
        expect(r.snapshot.per_request_pricing_fact?.amount).toBe("0.05");
        // Explainability: the pricing check carries expected/actual.
        const pricingCheck = r.checks.find((c) => c.check_id === "pricing.hard_cost")!;
        expect(pricingCheck.result).toBe("pass");
        expect(pricingCheck.actual).toBe(0.05);

        // Idempotent replay → identical response + replay header.
        const e2 = await app.request(`${base}/evaluate`, {
          method: "POST", headers: { ...memberAuth, "idempotency-key": idem }, body,
        });
        expect(e2.status).toBe(200);
        expect(e2.headers.get("x-idempotent-replay")).toBe("true");
        expect(JSON.stringify(await e2.json())).toBe(JSON.stringify(e1Body));

        // Hard policy violation → ineligible with an explainable check.
        const e3 = await app.request(`${base}/evaluate`, {
          method: "POST", headers: memberAuth,
          body: JSON.stringify({
            capability_id: "demo.echo", capability_version: "1", policy_id: policyId,
            context: { country: "US" },
          }),
        });
        const e3Body = (await e3.json()) as {
          eligibility: {
            results: {
              status: string;
              failures: { check_id: string; expected: unknown; actual: unknown; reason: string }[];
            }[];
          };
        };
        const r3 = e3Body.eligibility.results[0]!;
        expect(r3.status).toBe("ineligible");
        const policyCheck = r3.failures.find((c) => c.check_id === "policy.hard_constraints")!;
        expect(policyCheck.reason).toContain("rule_1");
        // The country coverage ALSO fails (GH-only coverage, US requested).
        expect(r3.failures.find((c) => c.check_id === "coverage.country")).toBeTruthy();

        // Named providers: a ghost provider gets a synthetic rejection.
        const e4 = await app.request(`${base}/evaluate`, {
          method: "POST", headers: memberAuth,
          body: JSON.stringify({
            capability_id: "demo.echo", capability_version: "1", policy_id: policyId,
            providers: ["demo.echo", "ghost.provider"],
            context: { country: "GH" },
          }),
        });
        const e4Body = (await e4.json()) as {
          eligibility: {
            results: { status: string; candidate: { provider: { provider_id: string } }; failures: { check_id: string }[] }[];
            summary: { evaluated: number; eligible: number; ineligible: number };
          };
        };
        expect(e4Body.eligibility.summary.evaluated).toBe(2);
        expect(e4Body.eligibility.summary.eligible).toBe(1);
        const ghost = e4Body.eligibility.results.find((x) => x.candidate.provider.provider_id === "ghost.provider")!;
        expect(ghost.status).toBe("ineligible");
        expect(ghost.failures[0]!.check_id).toBe("provider.declaration_exists");
      } finally {
        await cleanup();
      }
    });
  }, 120_000);

  it("tenant gates: missing auth 401; cross-org evaluation rejected; unknown policy 404-shaped", async () => {
    await withInfra(async (handle) => {
      const { app, api, cleanup } = await setup(handle);
      try {
        const t = `${Date.now()}`;
        const a = await makeTenant(app, api, `${t}-a`);
        const b = await makeTenant(app, api, `${t}-b`);
        await seedEcho(app, api, a.ownerKey, t);
        const policyId = await seedPolicy(app, a, "a-policy", [
          { subject: "country", operator: "eq", value: "GH", mode: "hard" },
        ]);
        const base = `/v1/organizations/${a.orgId}/projects/${a.projectId}/eligibility`;

        // Missing auth → 401.
        const noAuth = await app.request(`${base}/evaluate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1", policy_id: policyId }),
        });
        expect(noAuth.status).toBe(401);

        // Org B's member cannot evaluate under org A (org gate → 403).
        const memberB = { "content-type": "application/json", authorization: `Bearer ${b.memberKey}` };
        const foreign = await app.request(`${base}/evaluate`, {
          method: "POST", headers: memberB,
          body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1", policy_id: policyId }),
        });
        expect(foreign.status).toBe(403);

        // Unknown policy under the right scope → structured POLICY_BLOCKED.
        const memberA = { "content-type": "application/json", authorization: `Bearer ${a.memberKey}` };
        const unknown = await app.request(`${base}/evaluate`, {
          method: "POST", headers: memberA,
          body: JSON.stringify({ capability_id: "demo.echo", capability_version: "1", policy_id: "pol_missing" }),
        });
        expect(unknown.status).toBe(403);
        const ub = (await unknown.json()) as { error: { code: string } };
        expect(ub.error.code).toBe("eligibility.policy.no_active_version");

        // Invalid body → 400.
        const bad = await app.request(`${base}/evaluate`, {
          method: "POST", headers: memberA,
          body: JSON.stringify({ capability_id: "demo.echo" }),
        });
        expect(bad.status).toBe(400);
      } finally {
        await cleanup();
      }
    });
  }, 60_000);
});
