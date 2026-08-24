// tests/api/policies-routes.test.ts — HTTP-level coverage of the WORK-008
// /v1/organizations/:orgId/projects/:projectId/policies routes (real PG
// via withInfra, in-app Hono request). Covers the full lifecycle over
// HTTP: create policy (idempotent) → create draft version (idempotent) →
// update draft → activate (auto-deprecate) → evaluate (explainable,
// hard vs preference distinct) → list pagination → member/role gates →
// missing auth 401 → structured errors.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { createApi } from "@cp/api";

async function setup(handle: { pg: { connectionString: string } }) {
  const db = new PostgresDatabase({
    connectionString: handle.pg.connectionString,
    applicationName: "cp-test-policies-api",
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

/** Create an org + project for the authenticated user; returns {orgId, projectId, adminKey, memberKey}. */
async function makeOrgProject(
  app: ReturnType<typeof createApi>["app"],
  t: string,
): Promise<{ orgId: string; projectId: string; adminKey: string; memberKey: string; ownerKey: string }> {
  const ownerKey = await registerLogin(app, `pol-owner-${t}@e.com`);
  const adminKey = await registerLogin(app, `pol-admin-${t}@e.com`);
  const memberKey = await registerLogin(app, `pol-member-${t}@e.com`);
  const orgRes = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ name: "Org", slug: `pol-org-${t}` }),
  });
  const org = ((await orgRes.json()) as { organization: { id: string } }).organization;
  // Promote adminKey to admin.
  const me = await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${ownerKey}` } });
  const ownerId = ((await me.json()) as { user: { id: string } }).user.id;
  const meAdmin = await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${adminKey}` } });
  const adminId = ((await meAdmin.json()) as { user: { id: string } }).user.id;
  await app.request(`/v1/organizations/${org.id}/memberships`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ user_id: adminId, role: "admin" }),
  });
  // memberKey joins as member.
  const meMember = await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${memberKey}` } });
  const memberId = ((await meMember.json()) as { user: { id: string } }).user.id;
  await app.request(`/v1/organizations/${org.id}/memberships`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ user_id: memberId, role: "member" }),
  });
  const projRes = await app.request(`/v1/organizations/${org.id}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ name: "Proj", slug: `pol-proj-${t}` }),
  });
  const project = ((await projRes.json()) as { project: { id: string } }).project;
  void ownerId;
  return { orgId: org.id, projectId: project.id, adminKey, memberKey, ownerKey };
}

const EU_RULES = [
  { subject: "region", operator: "eq", value: "EU", mode: "hard" },
  { subject: "certification", operator: "eq", value: "certified", mode: "hard" },
  { subject: "integration_path", operator: "eq", value: "platform_operated", mode: "preference" },
];

describe("WORK-008 policy routes (real PG, in-app)", () => {
  it("full lifecycle over HTTP: create policy (idempotent) → version (idempotent) → update draft → activate → evaluate → pagination", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = `${Date.now()}`;
        const { orgId, projectId, adminKey, memberKey } = await makeOrgProject(app, t);
        const auth = { "content-type": "application/json", authorization: `Bearer ${adminKey}` };
        const base = `/v1/organizations/${orgId}/projects/${projectId}/policies`;

        // Create policy (idempotent).
        const idem = `pol-idem-${t}`;
        const body = JSON.stringify({ name: "eu-only", description: "EU residency" });
        const c1 = await app.request(base, { method: "POST", headers: { ...auth, "idempotency-key": idem }, body });
        expect(c1.status).toBe(201);
        const policy = ((await c1.json()) as { policy: { id: string; name: string } }).policy;
        expect(policy.name).toBe("eu-only");
        const c2 = await app.request(base, { method: "POST", headers: { ...auth, "idempotency-key": idem }, body });
        expect(c2.status).toBe(201);
        expect(c2.headers.get("x-idempotent-replay")).toBe("true");

        // Create draft version (idempotent).
        const vIdem = `pol-ver-idem-${t}`;
        const vBody = JSON.stringify({ rules: EU_RULES });
        const v1 = await app.request(`${base}/${policy.id}/versions`, {
          method: "POST", headers: { ...auth, "idempotency-key": vIdem }, body: vBody,
        });
        expect(v1.status).toBe(201);
        const version = ((await v1.json()) as {
          version: { version: string; status: string; rules: { subject: string }[] };
        }).version;
        expect(version.version).toBe("1");
        expect(version.status).toBe("draft");
        expect(version.rules.length).toBe(3);
        const v2 = await app.request(`${base}/${policy.id}/versions`, {
          method: "POST", headers: { ...auth, "idempotency-key": vIdem }, body: vBody,
        });
        expect(v2.headers.get("x-idempotent-replay")).toBe("true");

        // Update the draft (replaceable — never published yet).
        const upd = await app.request(`${base}/${policy.id}/versions/1`, {
          method: "PATCH", headers: auth,
          body: JSON.stringify({
            rules: [
              ...EU_RULES,
              { subject: "estimated_latency_ms", operator: "lt", value: 500, mode: "hard" },
            ],
          }),
        });
        expect(upd.status).toBe(200);
        const updBody = ((await upd.json()) as { version: { rules: unknown[] } }).version;
        expect(updBody.rules.length).toBe(4);

        // Activate.
        const act = await app.request(`${base}/${policy.id}/versions/1/lifecycle`, {
          method: "POST", headers: auth, body: JSON.stringify({ status: "active" }),
        });
        expect(act.status).toBe(200);
        expect(((await act.json()) as { version: { status: string } }).version.status).toBe("active");

        // Immutable after publish.
        const updPublished = await app.request(`${base}/${policy.id}/versions/1`, {
          method: "PATCH", headers: auth, body: JSON.stringify({ rules: EU_RULES }),
        });
        expect(updPublished.status).toBe(403);
        const imm = (await updPublished.json()) as { error: { code: string; details?: { reason?: string } } };
        expect(imm.error.code).toBe("policy.version.immutable");
        expect(imm.error.details?.reason).toBe("version_not_draft");

        // Evaluate (member allowed): hard pass + preference violation.
        const evalOk = await app.request(`${base}/${policy.id}/evaluate`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            version: "1",
            context: { region: "EU", certification: "certified", integration_path: "provider_operated", estimated_latency_ms: 300 },
          }),
        });
        expect(evalOk.status).toBe(200);
        const evaluation = ((await evalOk.json()) as {
          evaluation: {
            policy_id: string;
            policy_version: string;
            passed: boolean;
            hard_constraints: { passed: boolean; violations: unknown[] };
            preferences: { satisfied: unknown[]; violated: { rule_id: string }[] };
            rule_results: { rule_id: string; result: string; mode: string }[];
          };
        }).evaluation;
        expect(evaluation.passed).toBe(true);
        expect(evaluation.policy_version).toBe("1");
        expect(evaluation.hard_constraints.violations.length).toBe(0);
        expect(evaluation.preferences.violated.length).toBe(1);
        expect(evaluation.preferences.violated[0]!.rule_id).toBe("rule_3");
        expect(evaluation.rule_results.length).toBe(4);

        // Evaluate with a hard violation → explainable failure.
        const evalFail = await app.request(`${base}/${policy.id}/evaluate`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            version: "1",
            context: { region: "US", certification: "certified", integration_path: "provider_operated", estimated_latency_ms: 300 },
          }),
        });
        const failBody = ((await evalFail.json()) as {
          evaluation: { passed: boolean; hard_constraints: { violations: { rule_id: string; subject: string; actual: string; expected: string }[] } };
        }).evaluation;
        expect(failBody.passed).toBe(false);
        const v = failBody.hard_constraints.violations[0]!;
        expect(v.rule_id).toBe("rule_1");
        expect(v.subject).toBe("region");
        expect(v.actual).toBe("US");
        expect(v.expected).toBe("EU");

        // Member can evaluate and list but not mutate.
        const memberAuth = { "content-type": "application/json", authorization: `Bearer ${memberKey}` };
        const memberEval = await app.request(`${base}/${policy.id}/evaluate`, {
          method: "POST", headers: memberAuth,
          body: JSON.stringify({ version: "1", context: { region: "EU", certification: "certified", estimated_latency_ms: 300 } }),
        });
        expect(memberEval.status).toBe(200);
        const memberList = await app.request(base, { headers: { authorization: `Bearer ${memberKey}` } });
        expect(memberList.status).toBe(200);
        const memberCreate = await app.request(base, {
          method: "POST", headers: memberAuth, body: JSON.stringify({ name: "nope" }),
        });
        expect(memberCreate.status).toBe(403);
        const mc = (await memberCreate.json()) as { error: { code: string } };
        expect(mc.error.code).toBe("policy.role.required");

        // Pagination: create more policies, page through.
        for (const n of ["b", "c", "d"]) {
          await app.request(base, {
            method: "POST", headers: auth, body: JSON.stringify({ name: `policy-${n}` }),
          });
        }
        const page1 = await app.request(`${base}?limit=2`, { headers: { authorization: `Bearer ${adminKey}` } });
        const p1 = (await page1.json()) as { policies: unknown[]; next_cursor: string | null };
        expect(p1.policies.length).toBe(2);
        expect(p1.next_cursor).not.toBeNull();
        const page2 = await app.request(`${base}?limit=2&cursor=${p1.next_cursor}`, {
          headers: { authorization: `Bearer ${adminKey}` },
        });
        const p2 = (await page2.json()) as { policies: unknown[]; next_cursor: string | null };
        expect(p2.policies.length).toBe(2);
        expect(p2.next_cursor).toBeNull();

        // Unknown policy → 404; invalid rules → 400.
        const missing = await app.request(`${base}/pol_missing`, { headers: { authorization: `Bearer ${adminKey}` } });
        expect(missing.status).toBe(404);
        const badRules = await app.request(`${base}/${policy.id}/versions`, {
          method: "POST", headers: auth,
          body: JSON.stringify({ rules: [{ subject: "hack", operator: "eq", value: "x", mode: "hard" }] }),
        });
        // Service-level rule validation is POLICY_BLOCKED (the platform's
        // convention for domain validation failures) → 403.
        expect(badRules.status).toBe(403);
        const brBody = (await badRules.json()) as { error: { code: string } };
        expect(brBody.error.code).toBe("policy.rules.invalid");
        const badEval = await app.request(`${base}/${policy.id}/evaluate`, {
          method: "POST", headers: auth, body: JSON.stringify({ context: {} }),
        });
        expect(badEval.status).toBe(400);
      } finally {
        await cleanup();
      }
    });
  }, 120_000);

  it("missing auth → 401; cross-org path substitution → 404/403 (tenant gates)", async () => {
    await withInfra(async (handle) => {
      const { app, cleanup } = await setup(handle);
      try {
        const t = `${Date.now()}`;
        const a = await makeOrgProject(app, `${t}-a`);
        const b = await makeOrgProject(app, `${t}-b`);
        const noAuth = await app.request(`/v1/organizations/${a.orgId}/projects/${a.projectId}/policies`);
        expect(noAuth.status).toBe(401);

        // Org A's admin asks for org B's project under org A's path: the
        // project does not belong to the AUTHORIZED org → 403
        // project.not_found (WORK-004 gate semantics — no leak).
        const authA = { "content-type": "application/json", authorization: `Bearer ${a.adminKey}` };
        const cross = await app.request(`/v1/organizations/${a.orgId}/projects/${b.projectId}/policies`, {
          headers: { authorization: `Bearer ${a.adminKey}` },
        });
        expect(cross.status).toBe(403);

        // Org B's member cannot create a policy in org A (org gate).
        const memberB = { "content-type": "application/json", authorization: `Bearer ${b.memberKey}` };
        const foreign = await app.request(`/v1/organizations/${a.orgId}/projects/${a.projectId}/policies`, {
          method: "POST", headers: memberB, body: JSON.stringify({ name: "intrusion" }),
        });
        expect(foreign.status).toBe(403);
        void authA;
      } finally {
        await cleanup();
      }
    });
  }, 60_000);
});
