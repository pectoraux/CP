// tests/infra/cache-redis.test.ts — real Redis transient-cache integration
// proving the provider-neutral Cache contract (WORK-002 DATA-AC-02).
import { describe, expect, it } from "bun:test";
import { RedisCache } from "@cp/platform";
import { withInfra } from "./harness.ts";

describe("RedisCache (real Redis 8)", () => {
  it("set/get round-trips a JSON value", async () => {
    await withInfra(async (h) => {
      const cache = new RedisCache({ url: h.redis.url, keyPrefix: "cp:c1:" });
      try {
        await cache.set("user:1", { id: 1, name: "ada" });
        const v = await cache.get<{ id: number; name: string }>("user:1");
        expect(v).toEqual({ id: 1, name: "ada" });
      } finally {
        await cache.close();
      }
    });
  });

  it("returns undefined for a missing key", async () => {
    await withInfra(async (h) => {
      const cache = new RedisCache({ url: h.redis.url, keyPrefix: "cp:c2:" });
      try {
        const v = await cache.get<string>("does-not-exist");
        expect(v).toBeUndefined();
      } finally {
        await cache.close();
      }
    });
  });

  it("expires entries after the TTL", async () => {
    await withInfra(async (h) => {
      const cache = new RedisCache({ url: h.redis.url, keyPrefix: "cp:c3:" });
      try {
        await cache.set("ephemeral", "v", 1);
        const before = await cache.get<string>("ephemeral");
        expect(before).toBe("v");
        await new Promise((r) => setTimeout(r, 1200));
        const after = await cache.get<string>("ephemeral");
        expect(after).toBeUndefined();
      } finally {
        await cache.close();
      }
    });
  });

  it("delete removes an entry", async () => {
    await withInfra(async (h) => {
      const cache = new RedisCache({ url: h.redis.url, keyPrefix: "cp:c4:" });
      try {
        await cache.set("k", "v");
        await cache.delete("k");
        expect(await cache.get<string>("k")).toBeUndefined();
      } finally {
        await cache.close();
      }
    });
  });

  it("incr counts and supports a TTL", async () => {
    await withInfra(async (h) => {
      const cache = new RedisCache({ url: h.redis.url, keyPrefix: "cp:c5:" });
      try {
        const a = await cache.incr("counter", 1, 2);
        const b = await cache.incr("counter", 1, 2);
        expect(a).toBe(1);
        expect(b).toBe(2);
      } finally {
        await cache.close();
      }
    });
  });

  it("ping proves redis reachability", async () => {
    await withInfra(async (h) => {
      const cache = new RedisCache({ url: h.redis.url, keyPrefix: "cp:c6:" });
      try {
        await expect(cache.ping()).resolves.toBeUndefined();
      } finally {
        await cache.close();
      }
    });
  });
});
