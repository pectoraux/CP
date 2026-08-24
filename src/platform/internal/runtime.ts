// /platform/internal/runtime.ts
// Composition root for the platform runtime foundation. Wires the default
// logger, metrics, error tracker, in-process job queue, and (when provided)
// the concrete infrastructure (Postgres/Redis/S3) behind the provider-neutral
// interfaces. Domain modules receive these via the public `/platform`
// interface — never by reaching into internals.
//
// Explicit dependency injection is preferred: callers pass a pre-built
// Infrastructure bundle or a validated PlatformConfig. There are no hidden
// global singletons initialized by import side-effects.

import { noopMeter } from "./metrics.ts";
import { noopErrorTrackerFactory } from "./errors.ts";
import {
  InProcessJobQueue,
  type JobQueue,
} from "./queue.ts";
import {
  UnconfiguredDatabase,
  type Database,
} from "./db.ts";
import {
  UnconfiguredObjectStorage,
  type ObjectStorage,
} from "./storage.ts";
import type { Cache } from "./cache-redis.ts";
import type { LockProvider } from "./lock-redis.ts";
import { createInfrastructure } from "./infra.ts";
import type { Infrastructure } from "./infra.ts";
import type { HealthProbe } from "./health.ts";
import type { PlatformConfig } from "./config.ts";
import type { Logger, LogSink, LogLevel } from "./logger.ts";
import { createLogger } from "./logger.ts";

export interface Runtime {
  logger: Logger;
  metrics: typeof noopMeter;
  errorTracker: ReturnType<typeof noopErrorTrackerFactory>;
  queue: JobQueue;
  db: Database;
  storage: ObjectStorage;
  cache: Cache | undefined;
  lock: LockProvider | undefined;
  health: HealthProbe | undefined;
}

export interface RuntimeOptions {
  loggerSink?: LogSink;
  logLevel?: LogLevel;
  defaultFields?: Record<string, unknown>;
  /** Inject a concrete JobQueue (defaults to InProcessJobQueue). */
  queue?: JobQueue;
  /** Inject a concrete Database (defaults to the unconfigured sentinel). */
  db?: Database;
  /** Inject a concrete ObjectStorage (defaults to the sentinel). */
  storage?: ObjectStorage;
  /** Inject a concrete Cache (e.g. RedisCache). */
  cache?: Cache;
  /** Inject a concrete LockProvider (e.g. RedisLockProvider). */
  lock?: LockProvider;
  /** Inject a concrete HealthProbe. */
  health?: HealthProbe;
  /** Build infrastructure from a validated config (explicit, not hidden). */
  config?: PlatformConfig;
  /**
   * Inject a fully-built Infrastructure bundle. When provided, its
   * db/queue/storage/cache/lock/health are used and the per-field opts are
   * ignored for those pieces.
   */
  infra?: Infrastructure;
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const logger = createLogger({
    sink: opts.loggerSink,
    level: opts.logLevel,
    defaultFields: opts.defaultFields,
  });

  if (opts.infra) {
    return {
      logger,
      metrics: noopMeter,
      errorTracker: noopErrorTrackerFactory(),
      queue: opts.infra.queue,
      db: opts.infra.db,
      storage: opts.infra.storage,
      cache: opts.infra.cache,
      lock: opts.infra.lock,
      health: opts.infra.health,
    };
  }

  if (opts.config) {
    const infra = createInfrastructure({ config: opts.config, logger });
    return {
      logger,
      metrics: noopMeter,
      errorTracker: noopErrorTrackerFactory(),
      queue: opts.queue ?? infra.queue,
      db: opts.db ?? infra.db,
      storage: opts.storage ?? infra.storage,
      cache: opts.cache ?? infra.cache,
      lock: opts.lock ?? infra.lock,
      health: opts.health ?? infra.health,
    };
  }

  const queue = opts.queue ?? new InProcessJobQueue({ logger });
  const db = opts.db ?? new UnconfiguredDatabase();
  const storage = opts.storage ?? new UnconfiguredObjectStorage();
  return {
    logger,
    metrics: noopMeter,
    errorTracker: noopErrorTrackerFactory(),
    queue,
    db,
    storage,
    cache: opts.cache,
    lock: opts.lock,
    health: opts.health,
  };
}
