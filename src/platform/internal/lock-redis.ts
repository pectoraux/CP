// /platform/internal/lock-redis.ts
// Provider-neutral distributed-lock interface and a concrete Redis
// implementation (architecture §26, lock §12, WORK-002 DATA-002). The lock
// is a transient coordination primitive — Redis is not authoritative state.
// `ioredis` is isolated to /platform internals.
//
// Implementation: SET key token NX PX ttl for acquire (atomic), and a Lua
// release script that deletes the key only if its value matches the token
// (safe release — a holder never releases a lock it no longer owns). refresh
// extends the TTL under the same token guard.

import IORedis from "ioredis";
import type { Redis as RedisClient } from "ioredis";
import { AppError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { defaultLogger } from "./logger.ts";

export interface Lock {
  readonly key: string;
  readonly token: string;
  /** Refresh the lock's TTL. Returns false if the lock is no longer held. */
  refresh(ttlMs?: number): Promise<boolean>;
  /** Release the lock. No-ops if the lock is no longer held by this holder. */
  release(): Promise<void>;
}

export interface LockProvider {
  /**
   * Try to acquire a distributed lock for `key` with the given TTL.
   * Resolves to a Lock when acquired, or `undefined` when the lock is held
   * by someone else.
   */
  acquire(key: string, ttlMs: number): Promise<Lock | undefined>;
  /** Prove the backing store is reachable. */
  ping(): Promise<void>;
  /** Release underlying resources. */
  close(): Promise<void>;
}

const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
const REFRESH_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;

function newToken(): string {
  return "lock_" + crypto.randomUUID();
}

function normalizeRedisError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError({
    category: "NETWORK_FAILURE",
    code: "redis.lock",
    message: `redis lock failure during ${context}: ${message}`,
    retryable: true,
    transient: true,
    cause: err,
  });
}

export interface RedisLockProviderOptions {
  url: string;
  keyPrefix?: string;
  logger?: Logger;
  connectTimeoutMs?: number;
  maxRetriesPerRequest?: number;
}

export class RedisLockProvider implements LockProvider {
  private readonly redis: RedisClient;
  private readonly logger: Logger;
  private readonly prefix: string;

  constructor(opts: RedisLockProviderOptions) {
    this.logger = opts.logger ?? defaultLogger;
    this.prefix = opts.keyPrefix ?? "cp:lock:";
    // lazyConnect: the constructor does not touch the network. The first
    // command (acquire) auto-connects.
    this.redis = new IORedis(opts.url, {
      lazyConnect: true,
      connectTimeout: opts.connectTimeoutMs ?? 5000,
      maxRetriesPerRequest: opts.maxRetriesPerRequest ?? 3,
      retryStrategy: (times) => Math.min(times, 12) * 200,
    });
    this.redis.on("error", (err) => {
      this.logger.error("redis-lock: client error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private key(name: string): string {
    return this.prefix + name;
  }

  async acquire(name: string, ttlMs: number): Promise<Lock | undefined> {
    const key = this.key(name);
    const token = newToken();
    try {
      const res = await this.redis.set(key, token, "PX", ttlMs, "NX");
      if (res === "OK") {
        return new RedisLock(this, key, token, ttlMs);
      }
      return undefined;
    } catch (err) {
      throw normalizeRedisError(err, "acquire");
    }
  }

  async close(): Promise<void> {
    try {
      this.redis.disconnect(false);
    } catch {
      // ignore
    }
  }

  async release(key: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch (err) {
      // Safe-release is best-effort; a failed release means the TTL will
      // expire the lock. Log but do not throw (release must not deadlock
      // callers).
      this.logger.warn("redis-lock: release failed", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async refresh(key: string, token: string, ttlMs: number): Promise<boolean> {
    try {
      const res = await this.redis.eval(
        REFRESH_SCRIPT,
        1,
        key,
        token,
        String(ttlMs),
      );
      return res === 1 || res === 1;
    } catch (err) {
      throw normalizeRedisError(err, "refresh");
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
}

class RedisLock implements Lock {
  readonly key: string;
  readonly token: string;
  readonly ttlMs: number;
  private released = false;

  constructor(
    private readonly provider: RedisLockProvider,
    key: string,
    token: string,
    ttlMs: number,
  ) {
    this.key = key;
    this.token = token;
    this.ttlMs = ttlMs;
  }

  async refresh(ttlMs: number = this.ttlMs): Promise<boolean> {
    if (this.released) return false;
    return this.provider.refresh(this.key, this.token, ttlMs);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.provider.release(this.key, this.token);
  }
}
