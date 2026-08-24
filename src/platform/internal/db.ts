// /platform/internal/db.ts
// Provider-neutral database interface. PostgreSQL is the authoritative
// control-plane store (architecture §2.3, lock §1). WORK-001 provides the
// boundary only; WORK-002 (DATA-001) wires a concrete implementation.

export interface DbQueryResultRow {
  [key: string]: unknown;
}

export interface DbQueryOptions {
  /** The SQL text with positional $1, $2, ... parameters. */
  text: string;
  /** Positional parameter values. */
  params?: readonly unknown[];
}

export interface DbTransaction {
  query(opts: DbQueryOptions): Promise<readonly DbQueryResultRow[]>;
  exec(opts: DbQueryOptions): Promise<{ affectedRows: number }>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface Database {
  query(opts: DbQueryOptions): Promise<readonly DbQueryResultRow[]>;
  exec(opts: DbQueryOptions): Promise<{ affectedRows: number }>;
  /**
   * Run `fn` inside a transaction. If `fn` throws, the transaction is
   * rolled back and the error re-thrown. If it resolves, committed.
   */
  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>;
  /**
   * Health check used by readiness probes.
   */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Sentinel implementation that throws when used. WORK-001 does not wire a
 * concrete database; callers must provide one (WORK-002).
 */
export class UnconfiguredDatabase implements Database {
  async query(): Promise<readonly DbQueryResultRow[]> {
    throw new Error("database: not configured (see WORK-002 / DATA-001)");
  }
  async exec(): Promise<{ affectedRows: number }> {
    throw new Error("database: not configured (see WORK-002 / DATA-001)");
  }
  async transaction<T>(
    _fn: (tx: DbTransaction) => Promise<T>,
  ): Promise<T> {
    throw new Error("database: not configured (see WORK-002 / DATA-001)");
  }
  async ping(): Promise<void> {
    throw new Error("database: not configured (see WORK-002 / DATA-001)");
  }
  async close(): Promise<void> {}
}
