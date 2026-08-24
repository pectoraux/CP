// /platform/internal/infra.ts
// Infrastructure composition root (WORK-002 DATA-001..003, architecture §26,
// lock §12). Builds the concrete PostgreSQL/Redis/S3 implementations from a
// validated PlatformConfig behind the provider-neutral interfaces, and wires
// the platform health probe. Domain modules and the API transport never see
// the concrete classes; they receive `Database`/`JobQueue`/`ObjectStorage`/
// `Cache`/`LockProvider` via runtime injection.

import type { PlatformConfig } from "./config.ts";
import { UnconfiguredDatabase } from "./db.ts";
import type { Database } from "./db.ts";
import { PostgresDatabase } from "./db-postgres.ts";
import { UnconfiguredObjectStorage } from "./storage.ts";
import type { ObjectStorage } from "./storage.ts";
import { S3CompatibleObjectStorage } from "./storage-s3.ts";
import { InProcessJobQueue } from "./queue.ts";
import type { JobQueue } from "./queue.ts";
import { RedisJobQueue } from "./queue-redis.ts";
import { RedisCache } from "./cache-redis.ts";
import type { Cache } from "./cache-redis.ts";
import { RedisLockProvider } from "./lock-redis.ts";
import type { LockProvider } from "./lock-redis.ts";
import { createHealthProbe } from "./health.ts";
import type { HealthProbe } from "./health.ts";
import type { Logger } from "./logger.ts";
import { defaultLogger } from "./logger.ts";

export interface Infrastructure {
  db: Database;
  queue: JobQueue;
  storage: ObjectStorage;
  cache: Cache | undefined;
  lock: LockProvider | undefined;
  health: HealthProbe;
  /** Shut down every infrastructure component gracefully. */
  shutdown(): Promise<void>;
}

export interface CreateInfrastructureOptions {
  config: PlatformConfig;
  logger?: Logger;
  /** Override the queue (e.g. keep the in-process queue in dev). */
  queue?: JobQueue;
}

/**
 * Build concrete infrastructure from a validated PlatformConfig. Unconfigured
 * sections yield sentinel implementations so the runtime always has a
 * well-typed surface. Redis, when configured, is shared across the queue,
 * cache, and lock via a single ioredis client (one connection, one health
 * surface).
 */
export function createInfrastructure(
  opts: CreateInfrastructureOptions,
): Infrastructure {
  const logger = opts.logger ?? defaultLogger;
  const { config } = opts;

  // ---- Database (DATA-001) ------------------------------------------------
  const db: Database = config.database
    ? new PostgresDatabase({
        connectionString: config.database.connectionString,
        maxConnections: config.database.maxConnections,
        connectionTimeoutMs: config.database.connectionTimeoutMs,
        applicationName: config.database.applicationName,
        logger,
      })
    : new UnconfiguredDatabase();

  // ---- Redis-backed queue / cache / lock (DATA-002) ----------------------
  // A single shared ioredis client serves the cache + lock; the queue keeps
  // its own client because it uses blocking commands that must not share a
  // connection with non-blocking cache/lock traffic.
  let cache: Cache | undefined;
  let lock: LockProvider | undefined;
  if (config.redis) {
    cache = new RedisCache({
      url: config.redis.url,
      keyPrefix: config.redis.keyPrefix + "cache:",
      logger,
      connectTimeoutMs: config.redis.connectTimeoutMs,
      maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
    });
    lock = new RedisLockProvider({
      url: config.redis.url,
      keyPrefix: config.redis.keyPrefix + "lock:",
      logger,
      connectTimeoutMs: config.redis.connectTimeoutMs,
      maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
    });
  }

  const queue: JobQueue =
    opts.queue ??
    (config.redis
      ? new RedisJobQueue({
          url: config.redis.url,
          keyPrefix: config.redis.keyPrefix,
          logger,
          connectTimeoutMs: config.redis.connectTimeoutMs,
          maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
        })
      : new InProcessJobQueue({ logger }));

  // ---- Object storage (DATA-003) ------------------------------------------
  const storage: ObjectStorage = config.storage
    ? new S3CompatibleObjectStorage({
        endpoint: config.storage.endpoint,
        region: config.storage.region,
        bucket: config.storage.bucket,
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
        forcePathStyle: config.storage.forcePathStyle,
        logger,
      })
    : new UnconfiguredObjectStorage();

  // ---- Health (§9, §28) ---------------------------------------------------
  const health = createHealthProbe({ db: config.database ? db : undefined, cache, lock, storage: config.storage ? storage : undefined });

  return {
    db,
    queue,
    storage,
    cache,
    lock,
    health,
    async shutdown() {
      // Queue first (stop workers), then close stores. Orderly and best-effort.
      try {
        await queue.stop();
      } catch (err) {
        logger.warn("infra: queue stop failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (cache) {
        try {
          await cache.close();
        } catch (err) {
          logger.warn("infra: cache close failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (lock) {
        try {
          await lock.close();
        } catch (err) {
          logger.warn("infra: lock close failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        await db.close();
      } catch (err) {
        logger.warn("infra: db close failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
