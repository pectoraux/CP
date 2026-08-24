// tests/infra/health.test.ts — real platform health probe (WORK-002 §9).
// Proves that database / redis / object-storage reachability flows through
// the provider-neutral HealthProbe, not low-level SDK calls.
import { describe, expect, it } from "bun:test";
import {
  createInfrastructure,
  createHealthProbe,
  loadPlatformConfig,
  PostgresDatabase,
  RedisCache,
  RedisLockProvider,
  S3CompatibleObjectStorage,
} from "@cp/platform";
import { withInfra } from "./harness.ts";

describe("HealthProbe (real infrastructure)", () => {
  it("reports ok for all three pieces when they are up", async () => {
    await withInfra(async (h) => {
      const cfg = loadPlatformConfig({
        CP_ENV: "test",
        CP_DATABASE_URL: h.pg.connectionString,
        CP_REDIS_URL: h.redis.url,
        CP_STORAGE_ENDPOINT: h.storage.endpoint,
        CP_STORAGE_BUCKET: h.storage.bucket,
        CP_STORAGE_ACCESS_KEY_ID: h.storage.accessKeyId,
        CP_STORAGE_SECRET_ACCESS_KEY: h.storage.secretAccessKey,
        CP_STORAGE_REGION: h.storage.region,
      });
      const infra = createInfrastructure({ config: cfg });
      try {
        infra.queue.start();
        const report = await infra.health.check();
        expect(report.database).toBe("ok");
        expect(report.redis).toBe("ok");
        expect(report.storage).toBe("ok");
      } finally {
        await infra.shutdown();
      }
    });
  });

  it("reports unconfigured for absent pieces", async () => {
    const probe = createHealthProbe({});
    const report = await probe.check();
    expect(report.database).toBe("unconfigured");
    expect(report.redis).toBe("unconfigured");
    expect(report.storage).toBe("unconfigured");
  });

  it("reports unreachable when the database is down", async () => {
    await withInfra(async () => {
      const db = new PostgresDatabase({
        connectionString: "postgres://postgres@127.0.0.1:1/postgres",
        connectionTimeoutMs: 800,
      });
      const probe = createHealthProbe({ db });
      const report = await probe.check();
      expect(report.database).toBe("unreachable");
      await db.close();
    });
  });

  it("reports unreachable when redis is down", async () => {
    const cache = new RedisCache({
      url: "redis://127.0.0.1:1",
      connectTimeoutMs: 800,
      maxRetriesPerRequest: 1,
    });
    const probe = createHealthProbe({ cache });
    const report = await probe.check();
    expect(report.redis).toBe("unreachable");
    await cache.close();
  });

  it("reports unreachable when storage is down", async () => {
    const storage = new S3CompatibleObjectStorage({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      bucket: "x",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    const probe = createHealthProbe({ storage });
    const report = await probe.check();
    expect(report.storage).toBe("unreachable");
  });

  it("redis reachability is also proven via the lock provider", async () => {
    await withInfra(async (h) => {
      const lock = new RedisLockProvider({ url: h.redis.url });
      try {
        const probe = createHealthProbe({ lock });
        const report = await probe.check();
        expect(report.redis).toBe("ok");
      } finally {
        await lock.close();
      }
    });
  });
});
