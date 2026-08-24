// tests/capabilities/bootstrap-authority.test.ts — WORK-005 §22 authority
// correction proof (architect review of PR #4, CHANGES REQUESTED).
//
// The capability-admin grant is a CP-level platform-admin authority. The
// previous implementation allowed ANY authenticated principal to grant the
// first admin whenever cp_capability_admins was empty — meaning a tenant
// user could bootstrap themselves into global catalog administration
// merely because the installation was new. This file proves the corrected
// authority model end-to-end against REAL PostgreSQL and a REAL HTTP
// socket:
//
//   (a) fresh installation + ordinary user
//         → cannot become capability admin (403, stays non-admin)
//
//   (b) controlled bootstrap mechanism
//         (CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID → serve() startup)
//         → creates the first capability admin
//
//   (c) existing capability admin
//         → can grant another capability admin over the normal API
//
// Additional invariants proven here:
//   - the deployment bootstrap is a ONE-TIME initial-admin mechanism: when
//     the admin table is already populated, restarting serve() with a
//     different CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID does NOT grant that
//     user (an env-var change cannot silently add admins)
//   - the service-level normal grant path (grantCapabilityAdmin) has NO
//     empty-table bypass — it throws POLICY_BLOCKED for a non-admin actor
//     even when the table is empty
//   - an ordinary user's failed self-grant leaves them a non-admin (no
//     partial state)
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase, AppError } from "@cp/platform";
import { AuthService, migrateAuthSchema, buildPrincipal } from "@cp/auth";
import { CapabilitiesService, migrateCapabilitiesSchema } from "@cp/capabilities";
import { serve } from "@cp/api";

/** Create a user directly via the auth service (pre-listener). */
async function makeUser(db: PostgresDatabase, email: string) {
  const auth = new AuthService({ db });
  return auth.createUser({ email, password: "password123" });
}

/** Login over the real HTTP socket and return the bearer key. */
async function login(
  base: string,
  email: string,
): Promise<string> {
  const sess = await fetch(`${base}/v1/auth/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(sess.status).toBe(201);
  return ((await sess.json()) as { api_key: string }).api_key;
}

async function httpJson(
  base: string,
  path: string,
  init: { method: string; key?: string; body?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method,
    headers: {
      "content-type": "application/json",
      ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

function randomPort(): number {
  return 48000 + Math.floor(Math.random() * 1500);
}

describe("WORK-005 capability-admin bootstrap authority (PR #4 correction)", () => {
  it("(a) fresh installation + ordinary user → cannot become capability admin", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-test-bootstrap-a",
      });
      // Provision the auth schema so the ordinary user can exist before
      // the listener is bound (serve()'s autoMigrate then re-runs all
      // migrations idempotently). The admin table stays EMPTY — that is
      // the fresh-installation condition under test.
      await migrateAuthSchema(db);
      // The admin table is EMPTY (fresh installation) — the ordinary user
      // below will try to self-grant and must be refused.
      const email = `ordinary-a-${Date.now()}@e.com`;
      const user = await makeUser(db, email);
      const port = randomPort();
      const base = `http://127.0.0.1:${port}`;
      // NO bootstrapCapabilityAdminUserId configured.
      const api = await serve({
        port,
        hostname: "127.0.0.1",
        db,
        autoMigrate: true,
      });
      try {
        const key = await login(base, email);
        const me = await httpJson(base, "/v1/auth/me", { method: "GET", key });
        const userId = ((me.body as { user: { id: string } }).user).id;
        expect(userId).toBe(user.id);

        // Self-grant attempt over the normal tenant API → 403. There is no
        // empty-table bootstrap path in the API.
        const selfGrant = await httpJson(base, "/v1/capabilities/admins", {
          method: "POST",
          key,
          body: { user_id: userId },
        });
        expect(selfGrant.status).toBe(403);
        const err = selfGrant.body.error as { code: string; details?: { reason?: string } };
        expect(err.code).toBe("capability.admin.required");
        expect(err.details?.reason).toBe("not_a_capability_admin");

        // The failed self-grant left the user a NON-admin: they still
        // cannot mutate the global catalog.
        const create = await httpJson(base, "/v1/capabilities", {
          method: "POST",
          key,
          body: { capability_id: "payment.accept", name: "Accept a payment" },
        });
        expect(create.status).toBe(403);

        // Service-level proof: grantCapabilityAdmin has no empty-table
        // bypass — a non-admin actor is refused even on an empty table.
        const capabilities = new CapabilitiesService({ db });
        expect(await capabilities.isCapabilityAdmin(user.id)).toBe(false);
        let threw = false;
        try {
          await capabilities.grantCapabilityAdmin({
            userId: user.id,
            actingPrincipal: buildPrincipal(user.id, []),
          });
        } catch (e) {
          threw = true;
          expect((e as AppError).category).toBe("POLICY_BLOCKED");
          expect((e as AppError).code).toBe("capability.admin.required");
        }
        expect(threw).toBe(true);
        // Still not an admin after the refused grant.
        expect(await capabilities.isCapabilityAdmin(user.id)).toBe(false);
      } finally {
        await api.stop();
        await db.close();
      }
    });
  }, 120_000);

  it("(b) controlled bootstrap (CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID → serve() startup) → creates the first capability admin; re-deploy with a different id does NOT grant it", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-test-bootstrap-b",
      });
      // The deployment operator creates the intended first-admin user
      // BEFORE the deployment references them (auth schema must exist for
      // createUser; capabilities schema will be created by serve()'s
      // autoMigrate gate).
      await migrateAuthSchema(db);
      const operatorEmail = `bootstrap-admin-${Date.now()}@e.com`;
      const operator = await makeUser(db, operatorEmail);
      // A second user who must NOT become an admin when the deployment is
      // later reconfigured (re-deployed) to name them.
      const laterEmail = `latecomer-${Date.now()}@e.com`;
      const laterUser = await makeUser(db, laterEmail);

      const port = randomPort();
      const base = `http://127.0.0.1:${port}`;
      // serve() with the deployment/bootstrap configuration naming the
      // operator as the initial capability admin. The bootstrap runs AFTER
      // the migration gate and BEFORE the listener binds.
      const api = await serve({
        port,
        hostname: "127.0.0.1",
        db,
        autoMigrate: true,
        config: {
          mode: "test",
          bootstrapCapabilityAdminUserId: operator.id,
        },
      });
      try {
        // The operator is now a capability admin — prove it over the real
        // HTTP API by mutating the global catalog.
        const key = await login(base, operatorEmail);
        const create = await httpJson(base, "/v1/capabilities", {
          method: "POST",
          key,
          body: { capability_id: "payment.accept", name: "Accept a payment" },
        });
        expect(create.status).toBe(201);
        const cap = create.body.capability as { capability_id: string };
        expect(cap.capability_id).toBe("payment.accept");
      } finally {
        await api.stop();
      }

      // RE-DEPLOY INVARIANT: restart the deployment naming a DIFFERENT user.
      // The admin table is no longer empty, so the bootstrap is an
      // idempotent no-op — the named user does NOT become an admin. An
      // env-var change can never silently add new admins.
      const port2 = randomPort();
      const base2 = `http://127.0.0.1:${port2}`;
      const api2 = await serve({
        port: port2,
        hostname: "127.0.0.1",
        db,
        autoMigrate: true,
        config: {
          mode: "test",
          bootstrapCapabilityAdminUserId: laterUser.id,
        },
      });
      try {
        const key2 = await login(base2, laterEmail);
        const create2 = await httpJson(base2, "/v1/capabilities", {
          method: "POST",
          key: key2,
          body: { capability_id: "ai.generate", name: "Generate" },
        });
        expect(create2.status).toBe(403);
        // Service-level: the later user is not an admin.
        const capabilities = new CapabilitiesService({ db });
        expect(await capabilities.isCapabilityAdmin(laterUser.id)).toBe(false);
        // And the operator still IS an admin.
        expect(await capabilities.isCapabilityAdmin(operator.id)).toBe(true);
      } finally {
        await api2.stop();
        await db.close();
      }
    });
  }, 180_000);

  it("(c) existing capability admin → can grant another admin over the normal API (201)", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-test-bootstrap-c",
      });
      await migrateAuthSchema(db);
      await migrateCapabilitiesSchema(db);
      const adminEmail = `first-admin-${Date.now()}@e.com`;
      const admin = await makeUser(db, adminEmail);
      const secondEmail = `second-admin-${Date.now()}@e.com`;
      const second = await makeUser(db, secondEmail);

      // Controlled bootstrap of the FIRST admin (deployment authority —
      // the same grant serve() performs from
      // CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID; performed directly here so
      // this test isolates the NORMAL API that follows).
      const capabilities = new CapabilitiesService({ db });
      const boot = await capabilities.bootstrapCapabilityAdmin({ userId: admin.id });
      expect(boot.granted).toBe(true);
      expect(boot.reason).toBe("granted");

      const port = randomPort();
      const base = `http://127.0.0.1:${port}`;
      const api = await serve({
        port,
        hostname: "127.0.0.1",
        db,
        autoMigrate: true,
      });
      try {
        const adminKey = await login(base, adminEmail);
        // The existing admin grants ANOTHER admin over the normal API.
        const grant = await httpJson(base, "/v1/capabilities/admins", {
          method: "POST",
          key: adminKey,
          body: { user_id: second.id },
        });
        expect(grant.status).toBe(201);
        const granted = grant.body.granted as { user_id: string; permission: string };
        expect(granted.user_id).toBe(second.id);
        expect(granted.permission).toBe("capability.manage");

        // The second user can now mutate the global catalog.
        const secondKey = await login(base, secondEmail);
        const create = await httpJson(base, "/v1/capabilities", {
          method: "POST",
          key: secondKey,
          body: { capability_id: "message.send", name: "Send a message" },
        });
        expect(create.status).toBe(201);
      } finally {
        await api.stop();
        await db.close();
      }
    });
  }, 120_000);

  it("bootstrapCapabilityAdmin is idempotent and returns table_not_empty when admins exist", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-test-bootstrap-idem",
      });
      await migrateAuthSchema(db);
      await migrateCapabilitiesSchema(db);
      const u1 = await makeUser(db, `idem1-${Date.now()}@e.com`);
      const u2 = await makeUser(db, `idem2-${Date.now()}@e.com`);
      const capabilities = new CapabilitiesService({ db });
      try {
        // First bootstrap on the empty table grants.
        const r1 = await capabilities.bootstrapCapabilityAdmin({ userId: u1.id });
        expect(r1.granted).toBe(true);
        expect(r1.reason).toBe("granted");
        // Re-running the SAME bootstrap (same user) is a safe no-op.
        const r2 = await capabilities.bootstrapCapabilityAdmin({ userId: u1.id });
        expect(r2.granted).toBe(false);
        expect(r2.reason).toBe("table_not_empty");
        // Bootstrapping a DIFFERENT user once the table is populated is
        // also refused — the deployment config is a one-time
        // initial-admin mechanism, not a standing grant source.
        const r3 = await capabilities.bootstrapCapabilityAdmin({ userId: u2.id });
        expect(r3.granted).toBe(false);
        expect(r3.reason).toBe("table_not_empty");
        expect(await capabilities.isCapabilityAdmin(u1.id)).toBe(true);
        expect(await capabilities.isCapabilityAdmin(u2.id)).toBe(false);
        // Empty user_id is a validation error, not a silent skip.
        let threw = false;
        try {
          await capabilities.bootstrapCapabilityAdmin({ userId: "   " });
        } catch (e) {
          threw = true;
          expect((e as AppError).category).toBe("POLICY_BLOCKED");
          expect((e as AppError).code).toBe("capability.validation");
        }
        expect(threw).toBe(true);
      } finally {
        await db.close();
      }
    });
  }, 120_000);
});
