// /platform/internal/config.ts
// Centralized infrastructure configuration boundary (architecture §2.3, §26,
// lock §12, WORK-002 §8). All PostgreSQL / Redis / object-storage
// configuration is resolved and validated here. Domain modules and the API
// transport never read process.env directly for infrastructure concerns.
//
// Failures are explicit: production configuration must be complete, and the
// platform never silently falls back from an intended PostgreSQL/Redis/storage
// configuration to an unrelated local backend (e.g. SQLite or in-process
// queues). Explicit development/test defaults are allowed where clearly
// defined (mode = "development" | "test").

import { AppError } from "./errors.ts";

export type PlatformMode = "production" | "development" | "test";

export interface PostgresConfig {
  /** Full connection string, e.g. postgres://user:pass@host:5432/db. */
  connectionString: string;
  /** Max pool size. */
  maxConnections: number;
  /** Connection acquire timeout in ms (statement_timeout handled by pg). */
  connectionTimeoutMs: number;
  /** Optional application name for observability. */
  applicationName: string;
}

export interface RedisConfig {
  /** Redis URL, e.g. redis://host:port or rediss://... */
  url: string;
  /** Opt-in namespace prefix for all keys (multi-tenant/test isolation). */
  keyPrefix: string;
  /** Connect timeout in ms. */
  connectTimeoutMs: number;
  /** Max retry strategy factor (ioredis). */
  maxRetriesPerRequest: number;
}

export interface StorageConfig {
  /** S3-compatible endpoint, e.g. http://127.0.0.1:9000. */
  endpoint: string;
  /** Region (may be arbitrary for self-hosted Minio). */
  region: string;
  /** Bucket name. */
  bucket: string;
  /** Access key. */
  accessKeyId: string;
  /** Secret key. */
  secretAccessKey: string;
  /** Use path-style addressing (required by Minio and most self-hosted). */
  forcePathStyle: boolean;
}

export interface PlatformConfig {
  mode: PlatformMode;
  database?: PostgresConfig;
  redis?: RedisConfig;
  storage?: StorageConfig;
  /**
   * Optional deployment/operator authority that bootstraps the FIRST
   * capability admin on a fresh installation (WORK-005 §22 authority
   * correction). Sourced from CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID.
   *
   * This is the ONLY mechanism by which the initial capability-admin grant
   * is created. The normal tenant API (POST /v1/capabilities/admins) does
   * NOT self-bootstrap on an empty table — it requires an EXISTING
   * capability admin to grant another. The bootstrap grant runs once at
   * serve() startup, AFTER migrations succeed, and only when the admin
   * table is empty (idempotent no-op on re-deploys). A null/empty value
   * means no startup bootstrap is performed.
   *
   * This is a deployment-authority surface, NOT a tenant API. It is never
   * exposed over HTTP. The user_id must already exist in cp_users (the
   * operator creates the user first, then points the deployment at them).
   */
  bootstrapCapabilityAdminUserId?: string;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (v === undefined || v === "") {
    throw new AppError({
      category: "PLATFORM_FAILURE",
      code: "config.required.missing",
      message: `required configuration value ${key} is not set`,
      retryable: false,
      details: { key },
    });
  }
  return v;
}

function optional(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const v = env[key];
  return v === undefined || v === "" ? fallback : v;
}

function int(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new AppError({
      category: "PLATFORM_FAILURE",
      code: "config.invalid_int",
      message: `configuration value ${key} must be an integer (got "${v}")`,
      retryable: false,
      details: { key, value: v },
    });
  }
  return n;
}

function bool(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new AppError({
    category: "PLATFORM_FAILURE",
    code: "config.invalid_bool",
    message: `configuration value ${key} must be a boolean (got "${v}")`,
    retryable: false,
    details: { key, value: v },
  });
}

/**
 * Resolve the platform mode from CP_ENV (preferred) or NODE_ENV. Production
 * mode requires every intended infrastructure piece to be configured; missing
 * production configuration fails loudly. Development/test mode permits
 * unconfigured pieces (sentinel implementations are used instead).
 */
export function resolveMode(env: Record<string, string | undefined>): PlatformMode {
  const raw = (env.CP_ENV ?? env.NODE_ENV ?? "development").toLowerCase();
  if (raw === "production") return "production";
  if (raw === "test") return "test";
  return "development";
}

/**
 * Load and validate platform infrastructure configuration from the given
 * environment (defaults to process.env). Throws AppError(PLATFORM_FAILURE)
 * on any required-missing or invalid value; never silently substitutes an
 * unrelated backend for an intended production configuration.
 *
 * A configuration section is only present when its inputs are complete. In
 * production, a section that is partially configured (e.g. DATABASE_URL set
 * but malformed) fails; a section that is entirely absent in production also
 * fails. In development/test, absent sections are simply omitted and the
 * runtime uses sentinel (unconfigured) implementations.
 */
export function loadPlatformConfig(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): PlatformConfig {
  const mode = resolveMode(env);

  // ---- Database (DATA-001) ------------------------------------------------
  // Accepts a full connection string (preferred) or discrete host/port/...
  // components. Production requires the database to be configured.
  let database: PostgresConfig | undefined;
  const databaseUrl =
    env.CP_DATABASE_URL ??
    env.DATABASE_URL ??
    (env.CP_PG_HOST || env.PGHOST
      ? buildPostgresConnectionString(env)
      : undefined);
  if (databaseUrl) {
    database = {
      connectionString: databaseUrl,
      maxConnections: int(env, "CP_PG_MAX_CONNECTIONS", 10),
      connectionTimeoutMs: int(env, "CP_PG_CONNECTION_TIMEOUT_MS", 5000),
      applicationName: optional(env, "CP_PG_APPLICATION_NAME", "control-plane"),
    };
  } else if (mode === "production") {
    throw new AppError({
      category: "PLATFORM_FAILURE",
      code: "config.database.required_in_production",
      message:
        "production mode requires CP_DATABASE_URL (or CP_PG_HOST/CP_PG_USER/CP_PG_PASSWORD/CP_PG_DB) to be set",
      retryable: false,
    });
  }

  // ---- Redis (DATA-002) ---------------------------------------------------
  let redis: RedisConfig | undefined;
  const redisUrl = env.CP_REDIS_URL ?? env.REDIS_URL;
  if (redisUrl) {
    redis = {
      url: redisUrl,
      keyPrefix: optional(env, "CP_REDIS_KEY_PREFIX", "cp:"),
      connectTimeoutMs: int(env, "CP_REDIS_CONNECT_TIMEOUT_MS", 5000),
      maxRetriesPerRequest: int(env, "CP_REDIS_MAX_RETRIES", 3),
    };
  } else if (mode === "production") {
    throw new AppError({
      category: "PLATFORM_FAILURE",
      code: "config.redis.required_in_production",
      message: "production mode requires CP_REDIS_URL to be set",
      retryable: false,
    });
  }

  // ---- Object storage (DATA-003) ------------------------------------------
  let storage: StorageConfig | undefined;
  const storageEndpoint = env.CP_STORAGE_ENDPOINT;
  if (storageEndpoint) {
    // All four identity fields are required together; partial configuration
    // is rejected rather than silently defaulted.
    const bucket = env.CP_STORAGE_BUCKET;
    const accessKeyId = env.CP_STORAGE_ACCESS_KEY_ID ?? env.CP_STORAGE_ACCESS_KEY;
    const secretAccessKey =
      env.CP_STORAGE_SECRET_ACCESS_KEY ?? env.CP_STORAGE_SECRET_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new AppError({
        category: "PLATFORM_FAILURE",
        code: "config.storage.incomplete",
        message:
          "CP_STORAGE_ENDPOINT set but CP_STORAGE_BUCKET/CP_STORAGE_ACCESS_KEY_ID/CP_STORAGE_SECRET_ACCESS_KEY are incomplete",
        retryable: false,
        details: {
          hasBucket: Boolean(bucket),
          hasAccessKey: Boolean(accessKeyId),
          hasSecretKey: Boolean(secretAccessKey),
        },
      });
    }
    storage = {
      endpoint: storageEndpoint,
      region: optional(env, "CP_STORAGE_REGION", "us-east-1"),
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: bool(env, "CP_STORAGE_FORCE_PATH_STYLE", true),
    };
  } else if (mode === "production") {
    throw new AppError({
      category: "PLATFORM_FAILURE",
      code: "config.storage.required_in_production",
      message:
        "production mode requires CP_STORAGE_ENDPOINT/CP_STORAGE_BUCKET/CP_STORAGE_ACCESS_KEY_ID/CP_STORAGE_SECRET_ACCESS_KEY",
      retryable: false,
    });
  }

  // ---- Capability-admin bootstrap (WORK-005 §22 authority correction) ---
  // Optional deployment/operator authority. When set, serve() grants the
  // named user the capability.manage permission at startup (idempotent,
  // only when the admin table is empty). This is the ONLY path by which
  // the first capability admin is created; the normal tenant API never
  // self-bootstraps. Empty/whitespace is treated as unset.
  const bootstrapRaw = env.CP_BOOTSTRAP_CAPABILITY_ADMIN_USER_ID;
  const bootstrapCapabilityAdminUserId =
    bootstrapRaw !== undefined && bootstrapRaw.trim() !== ""
      ? bootstrapRaw.trim()
      : undefined;

  return { mode, database, redis, storage, bootstrapCapabilityAdminUserId };
}

function buildPostgresConnectionString(
  env: Record<string, string | undefined>,
): string {
  const host = env.CP_PG_HOST ?? env.PGHOST;
  const port = env.CP_PG_PORT ?? env.PGPORT ?? "5432";
  const user = env.CP_PG_USER ?? env.PGUSER;
  const password = env.CP_PG_PASSWORD ?? env.PGPASSWORD;
  const db = env.CP_PG_DB ?? env.PGDATABASE;
  if (!host || !user || !db) {
    // Signal to caller that discrete components are incomplete.
    return "";
  }
  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : `${encodeURIComponent(user)}@`;
  return `postgres://${auth}${host}:${port}/${encodeURIComponent(db)}`;
}
