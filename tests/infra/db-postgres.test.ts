// tests/infra/db-postgres.test.ts — real PostgreSQL 17 integration proving
// the provider-neutral Database interface (WORK-002 DATA-AC-01). Tests use
// the public Database contract (query/exec/transaction/ping/close), not
// pg internals. Runs against a real postmaster spawned by the infra harness.
import { describe, expect, it } from "bun:test";
import { PostgresDatabase, AppError } from "@cp/platform";
import { withInfra } from "./harness.ts";

describe("PostgresDatabase (real PostgreSQL 17)", () => {
  it("connects, pings, and runs a basic query", async () => {
    await withInfra(async (h) => {
      const db = new PostgresDatabase({
        connectionString: h.pg.connectionString,
        maxConnections: 5,
      });
      try {
        await db.ping();
        const rows = await db.query({
          text: "SELECT $1::int AS n, $2::text AS s",
          params: [42, "hello"],
        });
        expect(rows.length).toBe(1);
        expect(rows[0]!["n"]).toBe(42);
        expect(rows[0]!["s"]).toBe("hello");
      } finally {
        await db.close();
      }
    });
  });

  it("commits a transaction with side effects", async () => {
    await withInfra(async (h) => {
      const db = new PostgresDatabase({ connectionString: h.pg.connectionString });
      try {
        await db.exec({ text: "DROP TABLE IF EXISTS work002_probe" });
        await db.exec({
          text: "CREATE TABLE work002_probe (id int PRIMARY KEY, label text NOT NULL)",
        });
        await db.transaction(async (tx) => {
          await tx.exec({ text: "INSERT INTO work002_probe (id, label) VALUES (1, 'a')" });
          await tx.exec({ text: "INSERT INTO work002_probe (id, label) VALUES (2, 'b')" });
        });
        const rows = await db.query({ text: "SELECT id, label FROM work002_probe ORDER BY id" });
        expect(rows.length).toBe(2);
        expect(rows[0]!["label"]).toBe("a");
        expect(rows[1]!["label"]).toBe("b");
      } finally {
        await db.close();
      }
    });
  });

  it("rolls back a transaction when the body throws", async () => {
    await withInfra(async (h) => {
      const db = new PostgresDatabase({ connectionString: h.pg.connectionString });
      try {
        await db.exec({ text: "DROP TABLE IF EXISTS work002_probe" });
        await db.exec({
          text: "CREATE TABLE work002_probe (id int PRIMARY KEY, label text NOT NULL)",
        });
        await expect(
          db.transaction(async (tx) => {
            await tx.exec({ text: "INSERT INTO work002_probe (id, label) VALUES (1, 'a')" });
            throw new Error("deliberate rollback");
          }),
        ).rejects.toThrow();
        // Nothing should be committed.
        const rows = await db.query({ text: "SELECT id FROM work002_probe" });
        expect(rows.length).toBe(0);
      } finally {
        await db.close();
      }
    });
  });

  it("classifies a connection failure as a NETWORK_FAILURE AppError", async () => {
    await withInfra(async () => {
      // Point at a port nothing listens on. PostgresDatabase must surface an
      // AppError (NETWORK_FAILURE, retryable), not a raw pg error.
      const db = new PostgresDatabase({
        connectionString: "postgres://postgres@127.0.0.1:1/postgres",
        connectionTimeoutMs: 1500,
      });
      try {
        await expect(db.ping()).rejects.toBeInstanceOf(AppError);
        try {
          await db.ping();
        } catch (err) {
          const e = err as AppError;
          expect(e.category).toBe("NETWORK_FAILURE");
          expect(e.retryable).toBe(true);
        }
      } finally {
        await db.close();
      }
    });
  });

  it("shuts down cleanly (close is idempotent and releases the pool)", async () => {
    await withInfra(async (h) => {
      const db = new PostgresDatabase({ connectionString: h.pg.connectionString });
      await db.ping();
      await db.close();
      // Second close is a no-op.
      await expect(db.close()).resolves.toBeUndefined();
    });
  });

  it("recovers after a transient query error (pool stays usable)", async () => {
    await withInfra(async (h) => {
      const db = new PostgresDatabase({ connectionString: h.pg.connectionString });
      try {
        // A bad query throws (PLATFORM_FAILURE), but the pool stays healthy.
        await expect(
          db.query({ text: "SELECT * FROM definitely_not_a_table" }),
        ).rejects.toBeInstanceOf(AppError);
        // Subsequent valid query still works (connection recovered).
        const rows = await db.query({ text: "SELECT 1 AS ok" });
        expect(rows[0]!["ok"]).toBe(1);
      } finally {
        await db.close();
      }
    });
  });
});
