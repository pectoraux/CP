// /platform/internal/health.ts
// Provider-neutral platform health probe (architecture §28, lock §12,
// WORK-002 §9). Determines reachability of the three infrastructure pieces
// — database, redis, object storage — through platform interfaces only.
// Never makes low-level SDK calls from the API transport; health flows
// through this probe.

import type { Database } from "./db.ts";
import type { ObjectStorage } from "./storage.ts";
import type { Cache } from "./cache-redis.ts";
import type { LockProvider } from "./lock-redis.ts";

export type ComponentHealth = "ok" | "unreachable" | "unconfigured";

export interface HealthReport {
  database: ComponentHealth;
  redis: ComponentHealth;
  storage: ComponentHealth;
}

export interface HealthProbe {
  check(): Promise<HealthReport>;
}

export interface HealthProbeInputs {
  db?: Database;
  /** Any redis-backed component proves redis reachability (cache preferred). */
  cache?: Cache;
  lock?: LockProvider;
  storage?: ObjectStorage;
  /** Probe key used for the storage HEAD check (object need not exist). */
  storageProbeKey?: string;
}

async function probe(fn: () => Promise<void>): Promise<ComponentHealth> {
  try {
    await fn();
    return "ok";
  } catch {
    return "unreachable";
  }
}

export function createHealthProbe(inputs: HealthProbeInputs): HealthProbe {
  const probeKey = inputs.storageProbeKey ?? "__cp_health_probe__";
  return {
    async check(): Promise<HealthReport> {
      const database = inputs.db
        ? await probe(() => inputs.db!.ping())
        : "unconfigured";
      // Redis reachability: prefer the cache, fall back to the lock. Either
      // proves the backing Redis is reachable.
      const redis: ComponentHealth = inputs.cache
        ? await probe(() => inputs.cache!.ping())
        : inputs.lock
          ? await probe(() => inputs.lock!.ping())
          : "unconfigured";
      const storage = inputs.storage
        ? await probe(async () => {
            // stat() resolves (possibly to undefined for a missing object)
            // whenever the endpoint is reachable and authorized; it only
            // throws on connection/access failure.
            await inputs.storage!.stat(probeKey);
          })
        : "unconfigured";
      return { database, redis, storage };
    },
  };
}
