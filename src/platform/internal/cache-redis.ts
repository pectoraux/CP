// /platform/internal/cache-redis.ts
// Provider-neutral transient-cache interface and a concrete Redis
// implementation (architecture §26, lock §12, WORK-002 DATA-002). Redis is
// not authoritative state — the cache is a short-lived, best-effort layer.
// `ioredis` is isolated to /platform internals.

import IORedis from "ioredis";
import type { Redis as RedisClient } from "ioredis";
import { AppError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { defaultLogger } from "./logger.ts";

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Increment a counter; creates it if absent. Returns the new value. */
  incr(key: string, delta?: number, ttlSeconds?: number): Promise<number>;
  /** Prove the backing store is reachable. */
  ping(): Promise<void>;
  /** Release underlying resources. */
  close(): Promise<void>;
}

function normalizeRedisError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError({
    category: "NETWORK_FAILURE",
    code: "redis.cache",
    message: `redis cache failure during ${context}: ${message}`,
    retryable: true,
    transient: true,
    cause: err,
  });
}

export interface RedisCacheOptions {
  url: string;
  keyPrefix?: string;
  logger?: Logger;
  connectTimeoutMs?: number;
  maxRetriesPerRequest?: number;
}

export class RedisCache implements Cache {
  private readonly redis: RedisClient;
  private readonly logger: Logger;
  private readonly prefix: string;

  constructor(opts: RedisCacheOptions) {
    this.logger = opts.logger ?? defaultLogger;
    this.prefix = opts.keyPrefix ?? "cp:cache:";
    this.redis = new IORedis(opts.url, {
      lazyConnect: true,
      connectTimeout: opts.connectTimeoutMs ?? 5000,
      maxRetriesPerRequest: opts.maxRetriesPerRequest ?? 3,
      retryStrategy: (times) => Math.min(times, 12) * 200,
    });
    this.redis.on("error", (err) => {
      this.logger.error("redis-cache: client error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(this.k(key));
      if (raw === null || raw === undefined) return undefined;
      return JSON.parse(raw) as T;
    } catch (err) {
      if (err instanceof SyntaxError) {
        // Corrupt cache entry — treat as a miss and drop it.
        await this.delete(key).catch(() => {});
        return undefined;
      }
      throw normalizeRedisError(err, "get");
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) {
        await this.redis.set(this.k(key), serialized, "EX", ttlSeconds);
      } else {
        await this.redis.set(this.k(key), serialized);
      }
    } catch (err) {
      throw normalizeRedisError(err, "set");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(this.k(key));
    } catch (err) {
      throw normalizeRedisError(err, "delete");
    }
  }

  async incr(key: string, delta: number = 1, ttlSeconds?: number): Promise<number> {
    try {
      const k = this.k(key);
      const v = await this.redis.incrby(k, delta);
      if (ttlSeconds && ttlSeconds > 0) {
        await this.redis.expire(k, ttlSeconds);
      }
      return v;
    } catch (err) {
      throw normalizeRedisError(err, "incr");
    }
  }

  async ping(): Promise<void> {
    try {
      const res = await this.redis.ping();
      if (res !== "PONG") {
        throw new Error(`unexpected PING response: ${res}`);
      }
    } catch (err) {
      throw normalizeRedisError(err, "ping");
    }
  }

  async close(): Promise<void> {
    try {
      this.redis.disconnect(false);
    } catch {
      // ignore
    }
  }
}
