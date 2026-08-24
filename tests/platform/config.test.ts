// tests/platform/config.test.ts — PlatformConfig resolution & validation
// (WORK-002 §8: explicit configuration boundary, no silent fallback). Pure
// unit tests; no real infrastructure required.
import { describe, expect, it } from "bun:test";
import { loadPlatformConfig, resolveMode, AppError } from "@cp/platform";

describe("PlatformConfig / resolveMode", () => {
  it("resolves production from CP_ENV=production", () => {
    expect(resolveMode({ CP_ENV: "production" })).toBe("production");
  });
  it("resolves test from NODE_ENV=test", () => {
    expect(resolveMode({ NODE_ENV: "test" })).toBe("test");
  });
  it("defaults to development", () => {
    expect(resolveMode({})).toBe("development");
  });
});

describe("PlatformConfig / loadPlatformConfig", () => {
  it("accepts discrete postgres components", () => {
    const cfg = loadPlatformConfig({
      CP_ENV: "development",
      CP_PG_HOST: "127.0.0.1",
      CP_PG_PORT: "5432",
      CP_PG_USER: "app",
      CP_PG_PASSWORD: "secret",
      CP_PG_DB: "cp",
    });
    expect(cfg.database?.connectionString).toBe(
      "postgres://app:secret@127.0.0.1:5432/cp",
    );
    expect(cfg.database?.maxConnections).toBe(10);
  });

  it("accepts CP_DATABASE_URL verbatim", () => {
    const cfg = loadPlatformConfig({
      CP_ENV: "development",
      CP_DATABASE_URL: "postgres://u:p@db:5432/cp",
    });
    expect(cfg.database?.connectionString).toBe("postgres://u:p@db:5432/cp");
  });

  it("omits unconfigured sections in development (sentinel-friendly)", () => {
    const cfg = loadPlatformConfig({ CP_ENV: "development" });
    expect(cfg.database).toBeUndefined();
    expect(cfg.redis).toBeUndefined();
    expect(cfg.storage).toBeUndefined();
  });

  it("requires the database in production", () => {
    expect(() => loadPlatformConfig({ CP_ENV: "production" })).toThrow(AppError);
    try {
      loadPlatformConfig({ CP_ENV: "production" });
    } catch (err) {
      const e = err as AppError;
      expect(e.code).toBe("config.database.required_in_production");
      expect(e.category).toBe("PLATFORM_FAILURE");
    }
  });

  it("requires redis in production when other infra is configured", () => {
    expect(() =>
      loadPlatformConfig({
        CP_ENV: "production",
        CP_DATABASE_URL: "postgres://u:p@db:5432/cp",
      }),
    ).toThrow(AppError);
  });

  it("requires storage in production", () => {
    expect(() =>
      loadPlatformConfig({
        CP_ENV: "production",
        CP_DATABASE_URL: "postgres://u:p@db:5432/cp",
        CP_REDIS_URL: "redis://r:6379",
      }),
    ).toThrow(AppError);
  });

  it("rejects partial storage configuration explicitly", () => {
    expect(() =>
      loadPlatformConfig({
        CP_ENV: "development",
        CP_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        CP_STORAGE_BUCKET: "b",
        // access/secret missing
      }),
    ).toThrow(AppError);
    try {
      loadPlatformConfig({
        CP_ENV: "development",
        CP_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      });
    } catch (err) {
      expect((err as AppError).code).toBe("config.storage.incomplete");
    }
  });

  it("rejects non-integer config integers", () => {
    expect(() =>
      loadPlatformConfig({
        CP_ENV: "development",
        CP_DATABASE_URL: "postgres://u:p@db:5432/cp",
        CP_PG_MAX_CONNECTIONS: "lots",
      }),
    ).toThrow(AppError);
  });

  it("does not silently fall back from production postgres to an unrelated backend", () => {
    // Production with no database config throws; it never silently selects
    // SQLite or in-process sentinels as the authoritative store.
    let threw = false;
    try {
      loadPlatformConfig({ CP_ENV: "production" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
