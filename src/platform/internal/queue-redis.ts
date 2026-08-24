// /platform/internal/queue-redis.ts
// Concrete Redis implementation of the provider-neutral JobQueue interface
// (architecture §26, §27, lock §11, §12, WORK-002 DATA-002). Redis is NOT
// authoritative state; it is the transient job-queue/lock/cache substrate.
// `ioredis` is an implementation detail isolated to /platform internals.
//
// Delivery semantics: at-least-once. A job is atomically moved from the
// pending list to a processing list (BLMOVE) before being handled. On
// graceful stop, in-flight jobs are awaited to completion; pending jobs
// remain durably in Redis and are processed on the next start (no silent
// loss). On worker crash after the atomic move, the job remains in the
// processing list and is re-enqueued by the recovery pass on next start
// (at-least-once redelivery). We do NOT claim exactly-once; idempotency is
// the handler's responsibility.
//
// Execution/correlation identifiers are carried in the JSON envelope and
// restored into the active execution context inside the worker, so job-scoped
// logs carry them across the Redis boundary (architecture §27, §28).

import IORedis from "ioredis";
import type { Redis as RedisClient } from "ioredis";
import { runInContextAsync } from "./context.ts";
import { AppError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { defaultLogger } from "./logger.ts";
import type {
  JobEnvelope,
  JobHandler,
  JobHandlerResult,
  JobQueue,
  JobState,
  JobType,
} from "./queue.ts";

interface RedisJobEnvelope extends JobEnvelope {
  payload: unknown;
}

export interface RedisJobQueueOptions {
  url: string;
  keyPrefix?: string;
  concurrency?: number;
  /** BLMOVE poll timeout in seconds (fractional allowed). */
  pollTimeoutSeconds?: number;
  /** Max staleness (ms) for an in-flight job before recovery re-enqueues it. */
  inFlightTimeoutMs?: number;
  logger?: Logger;
  /** Max reconnect retries per request (ioredis). */
  maxRetriesPerRequest?: number;
  connectTimeoutMs?: number;
}

function normalizeRedisError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | undefined)?.code;
  const isConnection =
    typeof code === "string" &&
    (code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "NR_CLOSED" ||
      code === "REDIS_CONNECTION");
  if (isConnection) {
    return new AppError({
      category: "NETWORK_FAILURE",
      code: "redis.connection",
      message: `redis connection failure during ${context}: ${message}`,
      retryable: true,
      transient: true,
      cause: err,
      details: { driverCode: code },
    });
  }
  return new AppError({
    category: "PLATFORM_FAILURE",
    code: "redis.queue",
    message: `redis error during ${context}: ${message}`,
    retryable: false,
    cause: err,
    details: { driverCode: code },
  });
}

export class RedisJobQueue implements JobQueue {
  private readonly redis: RedisClient;
  private readonly logger: Logger;
  private readonly concurrency: number;
  private readonly pollTimeout: number;
  private readonly inFlightTimeoutMs: number;
  private readonly pendingKey: string;
  private readonly processingKey: string;
  private readonly statusPrefix: string;
  private readonly handlers = new Map<JobType, JobHandler>();
  // Synchronous status mirror (the JobQueue contract is sync). Backed by the
  // Redis hash for durability/observability; the mirror reflects this
  // process's worker progress.
  private readonly status = new Map<string, JobState>();
  private readonly inFlight = new Map<string, RedisJobEnvelope>();
  private started = false;
  private stopping = false;
  private workers: Promise<void>[] = [];
  // Per-worker connections for the blocking BLMOVE; the main `redis`
  // connection serves non-blocking control commands (enqueue/isDrained/ack).
  private workerConns: RedisClient[] = [];
  private readonly url: string;
  private readonly connectTimeoutMs: number;
  private readonly maxRetries: number;
  private draining: Array<() => void> = [];

  constructor(opts: RedisJobQueueOptions) {
    this.logger = opts.logger ?? defaultLogger;
    this.concurrency = opts.concurrency ?? 4;
    this.pollTimeout = opts.pollTimeoutSeconds ?? 0.5;
    this.inFlightTimeoutMs = opts.inFlightTimeoutMs ?? 30_000;
    this.url = opts.url;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.maxRetries = opts.maxRetriesPerRequest ?? 3;
    const prefix = opts.keyPrefix ?? "cp:";
    this.pendingKey = `${prefix}jobs`;
    this.processingKey = `${prefix}jobs:processing`;
    this.statusPrefix = `${prefix}status:`;
    this.redis = new IORedis(opts.url, {
      // Disable the auto-buffering of commands until we explicitly connect on
      // start(); lazyConnect keeps the constructor side-effect-free.
      lazyConnect: true,
      connectTimeout: opts.connectTimeoutMs ?? 5000,
      maxRetriesPerRequest: opts.maxRetriesPerRequest ?? 3,
      enableReadyCheck: true,
      // Keep reconnects bounded so configuration failures surface fast.
      retryStrategy: (times) => Math.min(times, 12) * 200,
    });
    this.redis.on("error", (err) => {
      if (this.started && !this.stopping) {
        this.logger.error("redis: client error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  enqueue(input: {
    type: JobType;
    payload?: unknown;
    executionId?: string;
    correlationId?: string;
    requestId?: string;
    organizationId?: string;
    projectId?: string;
  }): { jobId: string } {
    const id = "job_" + crypto.randomUUID();
    const now = Date.now();
    const envelope: RedisJobEnvelope = {
      id,
      type: input.type,
      payload: input.payload,
      requestId: input.requestId,
      executionId: input.executionId,
      correlationId: input.correlationId ?? input.requestId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      enqueuedAt: now,
      attempts: 0,
    };
    const state: JobState = {
      id,
      type: input.type,
      status: "pending",
      enqueuedAt: now,
      attempts: 0,
    };
    // Mirror synchronously so callers can poll status immediately, and
    // durably persist to Redis so the queue survives process restarts.
    this.status.set(id, state);
    void this.persist(id, state, envelope);
    return { jobId: id };
  }

  private async persist(
    id: string,
    state: JobState,
    envelope: RedisJobEnvelope,
  ): Promise<void> {
    try {
      const multi = this.redis.multi();
      multi.hset(this.statusPrefix + id, {
        id,
        type: state.type,
        status: state.status,
        enqueuedAt: String(state.enqueuedAt),
        attempts: String(state.attempts),
      });
      multi.rpush(this.pendingKey, JSON.stringify(envelope));
      await multi.exec();
    } catch (err) {
      // If Redis is unavailable, the job is not enqueued. Surface the error
      // via the status mirror so callers can see it; do not silently drop.
      this.status.set(id, {
        ...state,
        status: "failed",
        error: {
          category: "NETWORK_FAILURE",
          code: "redis.enqueue",
          message: `enqueue failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
        finishedAt: Date.now(),
      });
      this.logger.error("redis: enqueue failed", {
        job_id: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  registerHandler(type: JobType, handler: JobHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`queue: handler already registered for type ${type}`);
    }
    this.handlers.set(type, handler);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.startWorkers();
  }

  private async startWorkers(): Promise<void> {
    try {
      await this.redis.connect();
    } catch (err) {
      // start() is synchronous and non-awaiting; a connect failure is made
      // visible via the logger and the status mirror (enqueue will record
      // NETWORK_FAILURE on each job). We do not rethrow (would be an
      // unhandled rejection via `void startWorkers()`).
      this.logger.error("redis: connect failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.started = false;
      this.resolveDrainWaiters();
      return;
    }
    // Recovery: re-enqueue any jobs left in the processing list from a prior
    // crashed worker (at-least-once redelivery).
    await this.recoverInFlight();
    // Each worker gets its OWN ioredis connection. A blocking BLMOVE would
    // monopolize a shared connection (Redis processes commands on a single
    // connection serially), so non-blocking control commands (isDrained,
    // lrem, persistFinal) would queue behind the block — effectively
    // deadlocking the queue. Dedicated worker connections isolate the block.
    for (let i = 0; i < this.concurrency; i++) {
      const conn = new IORedis(this.url, {
        lazyConnect: false,
        connectTimeout: this.connectTimeoutMs,
        maxRetriesPerRequest: this.maxRetries,
        enableReadyCheck: true,
        retryStrategy: (times) => Math.min(times, 12) * 200,
      });
      conn.on("error", (err) => {
        this.logger.error("redis: worker connection error", {
          worker: i,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.workerConns.push(conn);
      this.workers.push(this.workerLoop(i, conn));
    }
  }

  private async recoverInFlight(): Promise<void> {
    try {
      const stale = await this.redis.lrange(this.processingKey, 0, -1);
      if (stale.length === 0) return;
      // Move all processing items back to pending so they are re-delivered.
      const multi = this.redis.multi();
      for (const item of stale) {
        multi.lrem(this.processingKey, 1, item);
        multi.rpush(this.pendingKey, item);
      }
      await multi.exec();
      this.logger.warn("redis: recovered in-flight jobs after restart", {
        count: stale.length,
      });
    } catch (err) {
      this.logger.error("redis: recovery scan failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async workerLoop(
    index: number,
    conn: RedisClient,
  ): Promise<void> {
    while (this.started || this.stopping) {
      if (!this.started && !this.stopping) break;
      let item: string | null = null;
      try {
        // Atomically move a job from pending to processing on this worker's
        // OWN connection (the blocking call only blocks this connection).
        item = await conn.blmove(
          this.pendingKey,
          this.processingKey,
          "LEFT",
          "LEFT",
          this.pollTimeout,
        );
      } catch (err) {
        if (!this.started && !this.stopping) break;
        this.logger.error("redis: blmove failed", {
          worker: index,
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      if (!item) continue; // timed out, loop and re-check running
      await this.process(item);
      this.resolveDrainWaiters();
    }
  }

  private async process(item: string): Promise<void> {
    let envelope: RedisJobEnvelope;
    try {
      envelope = JSON.parse(item) as RedisJobEnvelope;
    } catch (err) {
      // Malformed payload: remove from processing and record a failure.
      await this.lremProcessing(item);
      this.logger.error("redis: malformed job payload dropped", {
        raw: item.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.inFlight.set(envelope.id, envelope);
    const state =
      this.status.get(envelope.id) ??
      ({
        id: envelope.id,
        type: envelope.type,
        status: "pending",
        enqueuedAt: envelope.enqueuedAt,
        attempts: envelope.attempts,
      } as JobState);
    state.status = "running";
    state.startedAt = Date.now();
    state.attempts = envelope.attempts = envelope.attempts + 1;
    this.status.set(envelope.id, state);

    const ctx = {
      requestId: envelope.requestId,
      executionId: envelope.executionId,
      correlationId: envelope.correlationId ?? envelope.requestId,
      organizationId: envelope.organizationId,
      projectId: envelope.projectId,
    };

    let result: JobHandlerResult;
    try {
      const handler = this.handlers.get(envelope.type);
      if (!handler) {
        throw new AppError({
          category: "PLATFORM_FAILURE",
          code: "queue.no_handler",
          message: `queue: no handler registered for type ${envelope.type}`,
        });
      }
      result = await runInContextAsync(ctx, () => handler(envelope));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        status: "failed",
        error: {
          category: err instanceof AppError ? err.category : "PLATFORM_FAILURE",
          code: err instanceof AppError ? err.code : "queue.handler.threw",
          message,
        },
      };
      this.logger.error("redis: job failed", {
        job_id: envelope.id,
        job_type: envelope.type,
        error: message,
      });
    } finally {
      this.inFlight.delete(envelope.id);
    }

    state.status = result.status;
    state.result = result.result;
    if (result.error) state.error = result.error;
    state.finishedAt = Date.now();
    this.status.set(envelope.id, state);

    // Acknowledge: remove from processing and persist final status. These
    // run on the (non-blocking) main connection.
    await this.lremProcessing(item);
    await this.persistFinal(envelope.id, state);
  }

  private async lremProcessing(item: string): Promise<void> {
    try {
      await this.redis.lrem(this.processingKey, 1, item);
    } catch (err) {
      this.logger.error("redis: ack (lrem) failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async persistFinal(id: string, state: JobState): Promise<void> {
    try {
      await this.redis.hset(this.statusPrefix + id, {
        id,
        type: state.type,
        status: state.status,
        enqueuedAt: String(state.enqueuedAt),
        startedAt: state.startedAt ? String(state.startedAt) : "",
        finishedAt: state.finishedAt ? String(state.finishedAt) : "",
        attempts: String(state.attempts),
        result: state.result === undefined ? "" : JSON.stringify(state.result),
        error: state.error ? JSON.stringify(state.error) : "",
      });
    } catch (err) {
      this.logger.error("redis: persist final status failed", {
        job_id: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getStatus(jobId: string): JobState | undefined {
    const s = this.status.get(jobId);
    return s ? { ...s } : undefined;
  }

  async idle(): Promise<void> {
    if (await this.isDrained()) return;
    await new Promise<void>((resolve) => {
      const waiter = (): void => resolve();
      this.draining.push(waiter);
      // Close the TOCTOU race: if the queue drained between the initial
      // isDrained() check and pushing the waiter, resolve immediately.
      void this.isDrained().then((drained) => {
        if (drained) {
          const i = this.draining.indexOf(waiter);
          if (i >= 0) this.draining.splice(i, 1);
          resolve();
        }
      });
    });
  }

  private async isDrained(): Promise<boolean> {
    try {
      const res = await this.redis
        .multi()
        .llen(this.pendingKey)
        .llen(this.processingKey)
        .exec();
      if (!res) {
        return this.inFlight.size === 0;
      }
      // res is [error, result][] ; each result is the LLEN count.
      const p = Number(res[0]?.[1] ?? 0);
      const pr = Number(res[1]?.[1] ?? 0);
      return p === 0 && pr === 0 && this.inFlight.size === 0;
    } catch {
      // If Redis is unreachable, fall back to the local mirror.
      return this.inFlight.size === 0;
    }
  }

  private resolveDrainWaiters(): void {
    void (async () => {
      if (await this.isDrained()) {
        const waiters = this.draining;
        this.draining = [];
        for (const w of waiters) w();
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    // Wake any blocked workers (they will exit their loop on the next poll).
    // Workers handle the running->stopped transition by exiting after their
    // current BLMOVE times out; in-flight handlers are awaited via idle().
    try {
      await this.idle();
    } finally {
      this.stopping = false;
      const waiters = this.draining;
      this.draining = [];
      for (const w of waiters) w();
      await Promise.allSettled(this.workers);
      this.workers = [];
      for (const conn of this.workerConns) {
        try {
          conn.disconnect(false);
        } catch {
          // ignore
        }
      }
      this.workerConns = [];
      try {
        this.redis.disconnect(false);
      } catch {
        // ignore
      }
    }
  }
}
