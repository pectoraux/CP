// tests/api/goals-routes.test.ts — HTTP-level coverage of the WORK-011
// /goals + /outcome-contracts routes (real PG via withInfra, in-app Hono
// request): full lifecycle over HTTP with idempotency, tenant gates,
// pagination, structured errors.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { createApi } from "@cp/api";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-goals-api",
  });
  const api = createApi({ db });
  await api.migrate();
  const cleanup = async () => {
    await api.runtime.queue.stop();
    await db.close();
  };
  return { db, api, app: api.app, cleanup };
}

async function registerLogin(app: ReturnType<typeof createApi>["app"], email: string): Promise<string> {
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
}

async function makeTenant(app: ReturnType<typeof createApi>["app"], t: string): Promise<Tenant> {
  const ownerKey = await registerLogin(app, `goal-owner-${t}@e.com`);
  const memberKey = await registerLogin(app, `goal-member-${t}@e.com`);
  const auth = { "content-type": "application/json", authorization: `Bearer ${ownerKey}` };
  const orgRes = await app.request("/v1/organizations", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Org", slug: `goal-org-${t}` }),
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
    body: JSON.stringify({ name: "Proj", slug: `goal-proj-${t}` }),
  });
  const projectId = ((await projRes.json()) as { project: { id: string } }).project.id;
  return { orgId, projectId, ownerKey, memberKey };
}

const SUCCESS_CONTRACT = {
  metric: "success_rate",
  unit: "ratio",
  direction: "maximize",
  aggregation: "mean",
  threshold: 0.99,
  window_seconds: 300,
  measurement_source: "execution_observation",
  required: true,
};

describe("WORK-011 goals + outcome contracts routes (real PG, in-app)", () => {
  it("full lifecycle over HTTP: contract → goal → version → activate; idempotency; member gates", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = `${Date.now()}`;
        const tenant = await makeTenant(app, t);
        const auth = { "content-type": "application/json", authorization: `Bearer ${tenant.ownerKey}` };
        const base = `/v1/organizations/${tenant.orgId}/projects/${tenant.projectId}`;

        // 1. Create the outcome contract (idempotent).
        const idem = `goal-oc-${t}`;
        const contractBody = JSON.stringify({ name: "acceptance", content: SUCCESS_CONTRACT });
        const c1 = await app.request(`${base}/outcome-contracts`, {
          method: "POST", headers: { ...auth, "idempotency-key": idem }, body: contractBody,
        });
        expect(c1.status).toBe(201);
        const cv = ((await c1.json()) as {
          contract_version: { contract_id: string; version: string; status: string; content: { metric: string } };
        }).contract_version;
        expect(cv.status).toBe("draft");
        expect(cv.content.metric).toBe("success_rate");
        const c2 = await app.request(`${base}/outcome-contracts`, {
          method: "POST", headers: { ...auth, "idempotency-key": idem }, body: contractBody,
        });
        expect(c2.headers.get("x-idempotent-replay")).toBe("true");

        // Activate the contract.
        const act = await app.request(`${base}/outcome-contracts/${cv.contract_id}/versions/1/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });
        expect(act.status).toBe(200);

        // 2. Create the goal (idempotent).
        const goalIdem = `goal-g-${t}`;
        const goalBody = JSON.stringify({ name: "maximize-acceptance", description: "more acceptance" });
        const g1 = await app.request(`${base}/goals`, {
          method: "POST", headers: { ...auth, "idempotency-key": goalIdem }, body: goalBody,
        });
        expect(g1.status).toBe(201);
        const goal = ((await g1.json()) as { goal: { id: string } }).goal;
        const g2 = await app.request(`${base}/goals`, {
          method: "POST", headers: { ...auth, "idempotency-key": goalIdem }, body: goalBody,
        });
        expect(g2.headers.get("x-idempotent-replay")).toBe("true");

        // 3. Create the goal version (composite objectives + exact ref).
        const gv = await app.request(`${base}/goals/${goal.id}/versions`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            objectives: [
              { direction: "maximize", metric: "success_rate", kind: "hard", target: 0.99, unit: "ratio" },
              { direction: "maximize", metric: "success_rate", kind: "preference", notes: "higher is better" },
            ],
            outcome_contract_id: cv.contract_id,
            outcome_contract_version: "1",
          }),
        });
        expect(gv.status).toBe(201);
        const version = ((await gv.json()) as {
          version: {
            version: string; status: string;
            objectives: { id: string; direction: string; metric: string; kind: string; target?: number }[];
            outcome_contract: { contract_id: string; contract_version: string };
          };
        }).version;
        expect(version.version).toBe("1");
        expect(version.status).toBe("draft");
        expect(version.objectives.length).toBe(2);
        expect(version.objectives[0]!.kind).toBe("hard");
        expect(version.objectives[0]!.target).toBe(0.99);
        expect(version.objectives[1]!.kind).toBe("preference");
        expect(version.outcome_contract.contract_id).toBe(cv.contract_id);

        // 3b. VERSION INTEGRITY over HTTP: a goal version referencing a
        // DRAFT (still-mutable) contract version is rejected with a
        // structured error — a mutable measurement definition can never
        // back an activatable goal version.
        const draftC = await app.request(`${base}/outcome-contracts`, {
          method: "POST", headers: auth,
          body: JSON.stringify({ name: "draft-contract", content: SUCCESS_CONTRACT }),
        });
        expect(draftC.status).toBe(201);
        const draftCv = ((await draftC.json()) as { contract_version: { contract_id: string } }).contract_version;
        const draftRef = await app.request(`${base}/goals/${goal.id}/versions`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            objectives: [{ direction: "maximize", metric: "success_rate", kind: "hard" }],
            outcome_contract_id: draftCv.contract_id,
            outcome_contract_version: "1",
          }),
        });
        expect(draftRef.status).toBe(403);
        const draftRefBody = (await draftRef.json()) as { error: { code: string; details?: { stage?: string } } };
        expect(draftRefBody.error.code).toBe("goal.outcome_contract.mutable");
        expect(draftRefBody.error.details?.stage).toBe("creation");

        // 4. Activate the goal version; verify the active resolution.
        const gact = await app.request(`${base}/goals/${goal.id}/versions/1/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });
        expect(gact.status).toBe(200);
        expect(((await gact.json()) as { version: { status: string } }).version.status).toBe("active");

        // 5. Member can read; cannot mutate.
        const memberAuth = { "content-type": "application/json", authorization: `Bearer ${tenant.memberKey}` };
        const list = await app.request(`${base}/goals?limit=10`, { headers: { authorization: `Bearer ${tenant.memberKey}` } });
        expect(list.status).toBe(200);
        const memberCreate = await app.request(`${base}/goals`, {
          method: "POST", headers: memberAuth, body: JSON.stringify({ name: "nope" }),
        });
        expect(memberCreate.status).toBe(403);

        // 6. Invalid contract content → 403 (service POLICY_BLOCKED convention).
        const bad = await app.request(`${base}/outcome-contracts`, {
          method: "POST", headers: auth,
          body: JSON.stringify({ name: "bad", content: { ...SUCCESS_CONTRACT, metric: "vibe_score" } }),
        });
        expect(bad.status).toBe(403);
        const bb = (await bad.json()) as { error: { code: string } };
        expect(bb.error.code).toBe("outcome.validation");

        // 7. Pagination on goals.
        for (const n of ["b", "c"]) {
          await app.request(`${base}/goals`, {
            method: "POST", headers: auth, body: JSON.stringify({ name: `goal-${n}` }),
          });
        }
        const page1 = await app.request(`${base}/goals?limit=2`, { headers: { authorization: `Bearer ${tenant.ownerKey}` } });
        const p1 = (await page1.json()) as { goals: unknown[]; next_cursor: string | null };
        expect(p1.goals.length).toBe(2);
        expect(p1.next_cursor).not.toBeNull();
        const page2 = await app.request(`${base}/goals?limit=2&cursor=${p1.next_cursor}`, {
          headers: { authorization: `Bearer ${tenant.ownerKey}` },
        });
        const p2 = (await page2.json()) as { goals: unknown[]; next_cursor: string | null };
        expect(p2.goals.length).toBe(1);
        expect(p2.next_cursor).toBeNull();

        // 8. Unknown goal → 404; missing auth → 401.
        const missing = await app.request(`${base}/goals/goal_missing`, { headers: { authorization: `Bearer ${tenant.ownerKey}` } });
        expect(missing.status).toBe(404);
        const noAuth = await app.request(`${base}/goals`);
        expect(noAuth.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  }, 120_000);

  it("tenant gates: cross-org 403; suspended member 403", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = `${Date.now()}`;
        const a = await makeTenant(app, `${t}-a`);
        const b = await makeTenant(app, `${t}-b`);
        const authA = { "content-type": "application/json", authorization: `Bearer ${a.ownerKey}` };
        const baseA = `/v1/organizations/${a.orgId}/projects/${a.projectId}/goals`;

        const created = await app.request(baseA, {
          method: "POST", headers: authA, body: JSON.stringify({ name: "g" }),
        });
        expect(created.status).toBe(201);

        // Org B's owner cannot access org A's goals (org gate).
        const foreign = await app.request(baseA, { headers: { authorization: `Bearer ${b.ownerKey}` } });
        expect(foreign.status).toBe(403);

        // Missing auth → 401.
        const noAuth = await app.request(baseA);
        expect(noAuth.status).toBe(401);
      } finally {
        await cleanup();
      }
    });
  }, 60_000);
});
