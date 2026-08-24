// /platform/internal/db-postgres.ts
// Concrete PostgreSQL implementation of the provider-neutral Database
// interface (architecture §2.3, §26, lock §1, §12). PostgreSQL is the
// authoritative control-plane store. The `pg` (node-postgres) wire client
// is an implementation detail isolated to /platform internals; domain
// modules depend only on `Database`.
//
// Failure model (architecture §31): connection/network errors are classified
// as NETWORK_FAILURE (retryable, transient); unexpected SQL/executor errors
// as PLATFORM_FAILURE. Infrastructure failures are never misclassified as
// PROVIDER_FAILURE or POLICY_BLOCKED.

import pg from "pg";
import type { Pool, PoolClient, QueryResult } from "pg";
import { AppError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { defaultLogger } from "./logger.ts";
import type {
  Database,
  DbQueryOptions,
  DbQueryResultRow,
  DbTransaction,
} from "./db.ts";

const { Pool: PgPool } = pg;

// PostgreSQL error codes that indicate connection / availability failures
// (https://www.postgresql.org/docs/current/errcodes-appendix.html).
const PG_CONNECTION_CODES = new Set([
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001",
  "57P03", // cannot_connect_now
  "57P01", // admin_shutdown
]);
const PG_IDLE_TIMEOUT = "57P05"; // idle_timeout (server closed)

export interface PostgresDatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  applicationName?: string;
  logger?: Logger;
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const anyErr = err as { code?: string };
  const code = anyErr.code;
  if (typeof code === "string") {
    if (PG_CONNECTION_CODES.has(code) || code === PG_IDLE_TIMEOUT) return true;
    // libuv / DNS / TCP level errors
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "EPIPE" ||
      code === "EAI_AGAIN"
    ) {
      return true;
    }
  }
  return false;
}

/** Normalize a raw driver/SQL error into the platform AppError model. */
export function normalizePgError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | undefined)?.code;
  if (isConnectionError(err)) {
    return new AppError({
      category: "NETWORK_FAILURE",
      code: "database.connection",
      message: `database connection failure during ${context}: ${message}`,
      retryable: true,
      transient: true,
      cause: err,
      details: { driverCode: code },
    });
  }
  return new AppError({
    category: "PLATFORM_FAILURE",
    code: "database.query",
    message: `database error during ${context}: ${message}`,
    retryable: false,
    cause: err,
    details: { driverCode: code },
  });
}

class PgTransaction implements DbTransaction {
  constructor(
    private readonly client: PoolClient,
    private readonly logger: Logger,
  ) {}

  async query(opts: DbQueryOptions): Promise<readonly DbQueryResultRow[]> {
    try {
      const res = await this.client.query(opts.text, opts.params as unknown[]);
      return mapRows(res);
    } catch (err) {
      throw normalizePgError(err, "transaction.query");
    }
  }

  async exec(opts: DbQueryOptions): Promise<{ affectedRows: number }> {
    try {
      const res = await this.client.query(opts.text, opts.params as unknown[]);
      return { affectedRows: res.rowCount ?? 0 };
    } catch (err) {
      throw normalizePgError(err, "transaction.exec");
    }
  }

  async commit(): Promise<void> {
    try {
      await this.client.query("COMMIT");
    } catch (err) {
      throw normalizePgError(err, "transaction.commit");
    } finally {
      this.client.release();
    }
  }

  async rollback(): Promise<void> {
    try {
      await this.client.query("ROLLBACK");
    } catch (err) {
      this.logger.warn("database: rollback failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.client.release();
    }
  }
}

function mapRows(res: QueryResult): readonly DbQueryResultRow[] {
  if (!res || !Array.isArray(res.rows)) return [];
  return res.rows as DbQueryResultRow[];
}

export class PostgresDatabase implements Database {
  private readonly pool: Pool;
  private readonly logger: Logger;
  private closed = false;

  constructor(opts: PostgresDatabaseOptions) {
    this.logger = opts.logger ?? defaultLogger;
    this.pool = new PgPool({
      connectionString: opts.connectionString,
      max: opts.maxConnections ?? 10,
      connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5000,
      application_name: opts.applicationName ?? "control-plane",
      // Fail loudly on misconfiguration rather than hanging.
      allowExitOnIdle: false,
    });
    // Surface pool-level errors (idle client termination, etc.) so they are
    // observable rather than swallowed.
    this.pool.on("error", (err: Error) => {
      if (this.closed) return;
      this.logger.error("database: pool error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async query(opts: DbQueryOptions): Promise<readonly DbQueryResultRow[]> {
    try {
      const res = await this.pool.query(opts.text, opts.params as unknown[]);
      return mapRows(res);
    } catch (err) {
      throw normalizePgError(err, "query");
    }
  }

  async exec(opts: DbQueryOptions): Promise<{ affectedRows: number }> {
    try {
      const res = await this.pool.query(opts.text, opts.params as unknown[]);
      return { affectedRows: res.rowCount ?? 0 };
    } catch (err) {
      throw normalizePgError(err, "exec");
    }
  }

  async transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw normalizePgError(err, "transaction.connect");
    }
    try {
      await client.query("BEGIN");
    } catch (err) {
      client.release();
      throw normalizePgError(err, "transaction.begin");
    }
    const tx = new PgTransaction(client, this.logger);
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (err) {
      // Roll back regardless of error origin (handler throw or normalize).
      await tx.rollback();
      throw err instanceof AppError ? err : normalizePgError(err, "transaction.body");
    }
  }

  async ping(): Promise<void> {
    try {
      await this.pool.query("SELECT 1");
    } catch (err) {
      throw normalizePgError(err, "ping");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.pool.end();
    } catch (err) {
      // End failures are logged but not fatal during shutdown.
      this.logger.warn("database: close failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
