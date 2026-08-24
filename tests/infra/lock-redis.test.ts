// tests/infra/lock-redis.test.ts — real Redis distributed-lock integration
// proving the provider-neutral LockProvider contract (WORK-002 DATA-AC-02).
import { describe, expect, it } from "bun:test";
import { RedisLockProvider } from "@cp/platform";
import { withInfra } from "./harness.ts";

describe("RedisLockProvider (real Redis 8)", () => {
  it("acquires a lock and releases it", async () => {
    await withInfra(async (h) => {
      const locks = new RedisLockProvider({ url: h.redis.url, keyPrefix: "cp:lock1:" });
      try {
        const lock = await locks.acquire("resource-a", 5000);
        expect(lock).toBeDefined();
        await lock!.release();
        // After release, the same holder can re-acquire immediately.
        const again = await locks.acquire("resource-a", 5000);
        expect(again).toBeDefined();
        await again!.release();
      } finally {
        await locks.close();
      }
    });
  });

  it("blocks a second acquirer until the holder releases (mutual exclusion)", async () => {
    await withInfra(async (h) => {
      const locks = new RedisLockProvider({ url: h.redis.url, keyPrefix: "cp:lock2:" });
      try {
        const first = await locks.acquire("resource-b", 3000);
        expect(first).toBeDefined();
        // TTL is short; second acquirer fails while held.
        const second = await locks.acquire("resource-b", 1000);
        expect(second).toBeUndefined();
        // After release, second acquirer succeeds.
        await first!.release();
        const third = await locks.acquire("resource-b", 1000);
        expect(third).toBeDefined();
        await third!.release();
      } finally {
        await locks.close();
      }
    });
  });

  it("expires the lock after the TTL (liveness without explicit release)", async () => {
    await withInfra(async (h) => {
      const locks = new RedisLockProvider({ url: h.redis.url, keyPrefix: "cp:lock3:" });
      try {
        const lock = await locks.acquire("resource-c", 300);
        expect(lock).toBeDefined();
        // After TTL, a new acquirer can take it.
        await new Promise((r) => setTimeout(r, 450));
        const next = await locks.acquire("resource-c", 1000);
        expect(next).toBeDefined();
        await next!.release();
      } finally {
        await locks.close();
      }
    });
  });

  it("refresh extends the TTL while still held", async () => {
    await withInfra(async (h) => {
      const locks = new RedisLockProvider({ url: h.redis.url, keyPrefix: "cp:lock4:" });
      try {
        const lock = await locks.acquire("resource-d", 300);
        expect(lock).toBeDefined();
        await new Promise((r) => setTimeout(r, 150));
        const ok = await lock!.refresh(1000);
        expect(ok).toBe(true);
        // Still held; another acquirer fails.
        const blocked = await locks.acquire("resource-d", 500);
        expect(blocked).toBeUndefined();
        await lock!.release();
      } finally {
        await locks.close();
      }
    });
  });

  it("ping proves redis reachability", async () => {
    await withInfra(async (h) => {
      const locks = new RedisLockProvider({ url: h.redis.url, keyPrefix: "cp:lock5:" });
      try {
        await expect(locks.ping()).resolves.toBeUndefined();
      } finally {
        await locks.close();
      }
    });
  });

  it("safe release: a holder never releases a lock it no longer owns", async () => {
    await withInfra(async (h) => {
      const locks = new RedisLockProvider({ url: h.redis.url, keyPrefix: "cp:lock6:" });
      try {
        const first = await locks.acquire("resource-e", 200);
        await new Promise((r) => setTimeout(r, 350)); // TTL expired
        // Release after expiry must not delete a lock a different holder now owns.
        await expect(first!.release()).resolves.toBeUndefined();
        // And a new acquirer can still take it (state is clean).
        const next = await locks.acquire("resource-e", 1000);
        expect(next).toBeDefined();
        await next!.release();
      } finally {
        await locks.close();
      }
    });
  });
});
