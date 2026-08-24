// tests/smoke/serve-startup-gate.test.ts
// WORK-003 architect CHANGES_REQUESTED fix — real-evidence verification of
// the startup/readiness gate in serve({ autoMigrate: true }).
//
// The architect's required order is:
//
//   config -> infrastructure -> migrations -> migration success?
//                                              |- no  -> startup failure / no readiness
//                                              |- yes -> bind HTTP listener
//
// This file proves, against REAL infrastructure (no mocks), that:
//   (1) migration failure REJECTS serve() and the HTTP listener is NEVER
//       bound — the serve port stays closed (no readiness).
//   (2) migration success RESOLVES serve() and the bound listener serves.
//
// The failure case uses a real `pg` client pointed at a real closed TCP
// port (ECONNREFUSED). The success case uses the real PostgreSQL spawned
// by the withInfra harness.
import { describe, expect, it } from "bun:test";
import { withInfra } from "../infra/harness.ts";
import { PostgresDatabase } from "@cp/platform";
import { serve } from "@cp/api";

// Pick a high local port that is (empirically) closed so a real pg client
// gets ECONNREFUSED immediately. We pre-probe to be deterministic.
async function pickClosedPort(): Promise<number> {
  for (let i = 0; i < 16; i++) {
    const p = 52000 + Math.floor(Math.random() * 4000);
    try {
      // If this resolves, something is listening — try another.
      await fetch(`http://127.0.0.1:${p}/`);
      continue;
    } catch {
      return p; // closed — exactly what we want.
    }
  }
  throw new Error("could not find a closed port for the migration-failure test");
}

// Attempt a real fetch to `base`; return true iff a listener accepted the
// connection. Used to prove the serve port is (or is not) bound.
async function isListening(base: string): Promise<boolean> {
  try {
    await fetch(`${base}/v1/platform/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
}

describe("WORK-003 serve() startup/readiness gate", () => {
  it("migration failure rejects serve() and the HTTP listener is NOT bound (no readiness)", async () => {
    const closedDbPort = await pickClosedPort();
    const servePort = 56000 + Math.floor(Math.random() * 3000);
    const serveBase = `http://127.0.0.1:${servePort}`;

    // Sanity: the DB port is genuinely closed before we start.
    expect(await isListening(`http://127.0.0.1:${closedDbPort}`)).toBe(false);

    const db = new PostgresDatabase({
      connectionString: `postgres://postgres@127.0.0.1:${closedDbPort}/postgres`,
      connectionTimeoutMs: 1500,
      applicationName: "cp-startup-fail",
    });

    try {
      // serve({ autoMigrate: true }) MUST reject: migrations hit a closed
      // DB (NETWORK_FAILURE), and the readiness gate refuses to bind.
      await expect(
        serve({
          port: servePort,
          hostname: "127.0.0.1",
          db,
          autoMigrate: true,
        }),
      ).rejects.toThrow();

      // Real-evidence proof of "no readiness": the serve port is closed —
      // no listener was ever bound because the gate failed first.
      expect(await isListening(serveBase)).toBe(false);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("migration success resolves serve() and the listener serves health", async () => {
    await withInfra(async (handle) => {
      const db = new PostgresDatabase({
        connectionString: handle.pg.connectionString,
        applicationName: "cp-startup-ok",
      });
      const servePort = 56800 + Math.floor(Math.random() * 3000);
      const serveBase = `http://127.0.0.1:${servePort}`;

      // serve({ autoMigrate: true }) runs the real /auth + /organizations
      // migrations against real PostgreSQL, then binds the listener.
      const api = await serve({
        port: servePort,
        hostname: "127.0.0.1",
        db,
        autoMigrate: true,
      });

      try {
        // Real-evidence proof of readiness: the listener accepts a
        // connection and the platform health route returns 200. This is
        // only reachable because the gate passed and Bun.serve ran.
        const r = await fetch(`${serveBase}/v1/platform/health`);
        expect(r.status).toBe(200);
      } finally {
        await api.stop();
        await db.close();
      }
    });
  }, 120_000);
});
