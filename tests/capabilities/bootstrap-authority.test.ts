// tests/capabilities/bootstrap-authority.test.ts — WORK-005 §22 authority
// proofs (architect reviews of PR #4).
//
// Review #1 — the capability-admin grant is a CP-level platform-admin
// authority; no tenant self-bootstrap. Proven end-to-end against REAL
// PostgreSQL and a REAL HTTP socket:
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
// Review #2 — the first-admin bootstrap must be ATOMIC at the database
// level (the prior check-then-insert allowed two concurrent instances
// with different users to both observe an empty table and both insert):
//
//   (d) two simultaneous bootstrap calls (different users)
//         → exactly ONE admin (10 interleavings; service level)
//   (e) two simultaneous bootstrap calls (same user)
//         → exactly one admin row; both resolve without error
//   (f) two concurrent serve() instances with different bootstrap users
//         → exactly one bootstrap admin (the instance A/B scenario)
//   (g) pre-fix installation (admin exists, no claim row)
//         → changing the bootstrap user adds NO new admin
//
// Additional invariants proven here:
//   - the deployment bootstrap is a ONE-TIME initial-admin mechanism: once
//     any admin exists (or the singleton claim is taken), restarting with
//     a different CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID adds no admin
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
import { serve, createApi } from "@cp/api";

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
        // Re-running the SAME bootstrap (same user) is a safe no-op: the
        // singleton claim is already taken by u1 and u1 is already the
        // admin — nothing changes.
        const r2 = await capabilities.bootstrapCapabilityAdmin({ userId: u1.id });
        expect(r2.granted).toBe(false);
        expect(r2.reason).toBe("already_present");
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

  // ---------------------------------------------------------------------
  // Architect review #2 of PR #4 — the first-admin bootstrap must be
  // ATOMIC at the database level. The prior check-then-insert race:
  //
  //     Instance A: SELECT → empty    Instance B: SELECT → empty
  //     A: INSERT admin(A)            B: INSERT admin(B)
  //     → TWO bootstrap admins (different PKs; ON CONFLICT cannot help)
  //
  // The fix is a singleton claim table (constant-TRUE primary key) whose
  // claim and grant are ONE atomic SQL statement. These tests prove the
  // invariant end-to-end: two simultaneous bootstrap calls → exactly ONE
  // admin — at the service level (same pool), across two pools, and
  // across two full serve() instances.
  // ---------------------------------------------------------------------
  it("concurrency: two simultaneous bootstrap calls (different users) → exactly ONE admin (10 interleavings)", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-test-bootstrap-race-diff",
      });
      await migrateAuthSchema(db);
      await migrateCapabilitiesSchema(db);
      const u1 = await makeUser(db, `race-d1-${Date.now()}@e.com`);
      const u2 = await makeUser(db, `race-d2-${Date.now()}@e.com`);
      const capabilities = new CapabilitiesService({ db });
      try {
        for (let i = 0; i < 10; i++) {
          // Reset both the admin table AND the singleton claim so each
          // iteration re-races the check-then-insert window.
          await db.exec({
            text: `TRUNCATE cp_capability_admins, cp_capability_admin_bootstrap`,
            params: [],
          });
          // Warm the pool with several idle connections. The sequential
          // setup above leaves exactly ONE idle client; without warming,
          // the second bootstrap's first query would block on
          // new-connection setup while the first completes, serializing
          // the two calls and hiding the race. With ≥2 warm clients both
          // bootstraps dispatch their first statement immediately and
          // genuinely overlap at the database.
          await Promise.all([
            db.query({ text: "SELECT 1", params: [] }),
            db.query({ text: "SELECT 1", params: [] }),
            db.query({ text: "SELECT 1", params: [] }),
            db.query({ text: "SELECT 1", params: [] }),
          ]);
          const [r1, r2] = await Promise.all([
            capabilities.bootstrapCapabilityAdmin({ userId: u1.id }),
            capabilities.bootstrapCapabilityAdmin({ userId: u2.id }),
          ]);
          // Exactly one call reports a grant; neither throws.
          const grantedCount = [r1, r2].filter((r) => r.granted).length;
          expect(grantedCount).toBe(1);
          const loser = [r1, r2].find((r) => !r.granted)!;
          expect(["already_present", "table_not_empty"]).toContain(loser.reason);
          // Exactly ONE admin row exists.
          const admins = await db.query({
            text: `SELECT user_id FROM cp_capability_admins`,
            params: [],
          });
          expect(admins.length).toBe(1);
          const winnerId = (admins[0] as { user_id: string }).user_id;
          expect([u1.id, u2.id]).toContain(winnerId);
          // The winner is an admin; the loser is not.
          expect(await capabilities.isCapabilityAdmin(winnerId)).toBe(true);
          const loserUserId = winnerId === u1.id ? u2.id : u1.id;
          expect(await capabilities.isCapabilityAdmin(loserUserId)).toBe(false);
          // Exactly ONE singleton claim row exists, naming the winner.
          const claims = await db.query({
            text: `SELECT user_id FROM cp_capability_admin_bootstrap WHERE singleton = TRUE`,
            params: [],
          });
          expect(claims.length).toBe(1);
          expect((claims[0] as { user_id: string }).user_id).toBe(winnerId);
        }
      } finally {
        await db.close();
      }
    });
  }, 180_000);

  it("concurrency: two simultaneous bootstrap calls (SAME user) → exactly one admin row; both resolve without error", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-test-bootstrap-race-same",
      });
      await migrateAuthSchema(db);
      await migrateCapabilitiesSchema(db);
      const u = await makeUser(db, `race-same-${Date.now()}@e.com`);
      const capabilities = new CapabilitiesService({ db });
      try {
        // Warm the pool (see the different-users test above) so the two
        // calls genuinely overlap at the database.
        await Promise.all([
          db.query({ text: "SELECT 1", params: [] }),
          db.query({ text: "SELECT 1", params: [] }),
          db.query({ text: "SELECT 1", params: [] }),
          db.query({ text: "SELECT 1", params: [] }),
        ]);
        const [r1, r2] = await Promise.all([
          capabilities.bootstrapCapabilityAdmin({ userId: u.id }),
          capabilities.bootstrapCapabilityAdmin({ userId: u.id }),
        ]);
        // One grants; the other is an idempotent no-op (already_present).
        expect([r1, r2].filter((r) => r.granted).length).toBe(1);
        expect([r1, r2].find((r) => !r.granted)!.reason).toBe("already_present");
        // Exactly ONE admin row (the same user), ONE claim row.
        const admins = await db.query({
          text: `SELECT user_id FROM cp_capability_admins`,
          params: [],
        });
        expect(admins.length).toBe(1);
        expect((admins[0] as { user_id: string }).user_id).toBe(u.id);
        const claims = await db.query({
          text: `SELECT user_id FROM cp_capability_admin_bootstrap`,
          params: [],
        });
        expect(claims.length).toBe(1);
      } finally {
        await db.close();
      }
    });
  }, 120_000);

  it("concurrency: two serve() instances racing with DIFFERENT bootstrap users → exactly one bootstrap admin (both healthy)", async () => {
    await withInfra(async (handle) => {
      // Pre-create the FULL schema set (auth + organizations + projects +
      // capabilities + idempotency) via one connection first. Without this,
      // the two instances' concurrent autoMigrate would race to CREATE the
      // missing tables — PostgreSQL's well-known concurrent-DDL catalog
      // race (pg_type_typname_nsp_index), which is NOT the behavior under
      // test. With every object pre-created, both instances' autoMigrate
      // re-runs are idempotent no-ops, and the bootstrap claims themselves
      // race for real.
      const setupDb = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-test-bootstrap-race-setup",
      });
      const setupApi = createApi({ db: setupDb });
      await setupApi.migrate();
      await setupApi.runtime.queue.stop();
      const userA = await makeUser(setupDb, `race-inst-a-${Date.now()}@e.com`);
      const userB = await makeUser(setupDb, `race-inst-b-${Date.now()}@e.com`);
      await setupDb.close();

      // Two independent instances: separate pools, separate listeners,
      // DIFFERENT CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID values — the
      // architect's exact instance-A / instance-B scenario.
      const dbA = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-test-bootstrap-race-A",
      });
      const dbB = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-test-bootstrap-race-B",
      });
      const portA = randomPort();
      const portB = randomPort();
      let apiA: Awaited<ReturnType<typeof serve>> | undefined;
      let apiB: Awaited<ReturnType<typeof serve>> | undefined;
      try {
        [apiA, apiB] = await Promise.all([
          serve({
            port: portA,
            hostname: "127.0.0.1",
            db: dbA,
            autoMigrate: true,
            config: { mode: "test", bootstrapCapabilityAdminUserId: userA.id },
          }),
          serve({
            port: portB,
            hostname: "127.0.0.1",
            db: dbB,
            autoMigrate: true,
            config: { mode: "test", bootstrapCapabilityAdminUserId: userB.id },
          }),
        ]);

        // Both instances came up healthy.
        const hA = await fetch(`http://127.0.0.1:${portA}/v1/platform/health`);
        expect(hA.status).toBe(200);
        const hB = await fetch(`http://127.0.0.1:${portB}/v1/platform/health`);
        expect(hB.status).toBe(200);

        // Exactly ONE bootstrap admin exists — not one per instance.
        const admins = await dbA.query({
          text: `SELECT user_id FROM cp_capability_admins`,
          params: [],
        });
        expect(admins.length).toBe(1);
        const winnerId = (admins[0] as { user_id: string }).user_id;
        expect([userA.id, userB.id]).toContain(winnerId);
        const loserId = winnerId === userA.id ? userB.id : userA.id;

        const capabilities = new CapabilitiesService({ db: dbA });
        expect(await capabilities.isCapabilityAdmin(winnerId)).toBe(true);
        expect(await capabilities.isCapabilityAdmin(loserId)).toBe(false);

        // The singleton claim is recorded exactly once, naming the winner.
        const claims = await dbA.query({
          text: `SELECT user_id FROM cp_capability_admin_bootstrap WHERE singleton = TRUE`,
          params: [],
        });
        expect(claims.length).toBe(1);
        expect((claims[0] as { user_id: string }).user_id).toBe(winnerId);
      } finally {
        if (apiA) await apiA.stop();
        if (apiB) await apiB.stop();
        await dbA.close();
        await dbB.close();
      }
    });
  }, 180_000);

  it("pre-fix installation (admin exists, no bootstrap claim row) → changing the bootstrap user adds NO new admin", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-test-bootstrap-prefixup",
      });
      await migrateAuthSchema(db);
      await migrateCapabilitiesSchema(db);
      const legacyAdmin = await makeUser(db, `legacy-${Date.now()}@e.com`);
      const newUser = await makeUser(db, `newboot-${Date.now()}@e.com`);
      const thirdUser = await makeUser(db, `thirdboot-${Date.now()}@e.com`);
      // Simulate a pre-fix installation: the original (racy) bootstrap
      // code granted an admin WITHOUT recording a singleton claim row.
      // Upgrading must not let a new env-var value add a second admin.
      await db.exec({
        text: `INSERT INTO cp_capability_admins (user_id, permission, granted_by_user_id)
               VALUES ($1, 'capability.manage', NULL)`,
        params: [legacyAdmin.id],
      });
      const capabilities = new CapabilitiesService({ db });
      try {
        // First attempt with a NEW user: the claim may be won (no claim
        // row exists) but the admin table is populated — NO grant.
        const r1 = await capabilities.bootstrapCapabilityAdmin({ userId: newUser.id });
        expect(r1.granted).toBe(false);
        expect(r1.reason).toBe("table_not_empty");
        // A second attempt (yet another user) is also refused — the
        // claim is now recorded, so it loses outright.
        const r2 = await capabilities.bootstrapCapabilityAdmin({ userId: thirdUser.id });
        expect(r2.granted).toBe(false);
        // Still exactly ONE admin: the legacy one.
        const admins = await db.query({
          text: `SELECT user_id FROM cp_capability_admins`,
          params: [],
        });
        expect(admins.length).toBe(1);
        expect((admins[0] as { user_id: string }).user_id).toBe(legacyAdmin.id);
        expect(await capabilities.isCapabilityAdmin(newUser.id)).toBe(false);
        expect(await capabilities.isCapabilityAdmin(thirdUser.id)).toBe(false);
      } finally {
        await db.close();
      }
    });
  }, 120_000);
});
