// /platform — public interface.
//
// Runtime foundation: IDs, execution context, structured logging, metrics,
// error tracking, asynchronous job queue, database & object-storage
// interfaces (architecture §35, §36, lock §12).
//
// OTHER MODULES MAY IMPORT ONLY FROM THIS FILE. Importing any path under
// `@cp/platform/internal/*` is a forbidden cross-module internal import
// and will be rejected by the static architecture check.

// ---- Identifiers ---------------------------------------------------------
export {
  ulid,
  isUlid,
  newRequestId,
  newExecutionId,
  newJobId,
  newOperationId,
  newCorrelationId,
} from "./internal/ids.ts";

// ---- Execution context ---------------------------------------------------
export {
  getCurrentContext,
  runInContext,
  runInContextAsync,
  withContext,
  extendContext,
  getCorrelationId,
} from "./internal/context.ts";
export type { ExecutionContext } from "./internal/context.ts";

// ---- Logging ------------------------------------------------------------
export { createLogger, defaultLogger, Logger } from "./internal/logger.ts";
export type {
  LogLevel,
  LogFields,
  LogRecord,
  LogSink,
} from "./internal/logger.ts";

// ---- Metrics ------------------------------------------------------------
export { noopMeter } from "./internal/metrics.ts";
export type {
  Counter,
  Histogram,
  Gauge,
  Meter,
} from "./internal/metrics.ts";

// ---- Errors / failure model ---------------------------------------------
export {
  AppError,
  FAILURE_CATEGORIES,
  noopErrorTrackerFactory,
} from "./internal/errors.ts";
export type {
  FailureCategory,
  ErrorTracker,
  AppErrorOptions,
} from "./internal/errors.ts";

// ---- Asynchronous job queue ---------------------------------------------
export { InProcessJobQueue } from "./internal/queue.ts";
export type {
  JobQueue,
  JobEnvelope,
  JobState,
  JobStatus,
  JobType,
  JobHandler,
  JobHandlerResult,
} from "./internal/queue.ts";

// ---- Database & object-storage boundaries --------------------------------
export { UnconfiguredDatabase } from "./internal/db.ts";
export type {
  Database,
  DbQueryOptions,
  DbQueryResultRow,
  DbTransaction,
} from "./internal/db.ts";
export { PostgresDatabase } from "./internal/db-postgres.ts";
export type { PostgresDatabaseOptions } from "./internal/db-postgres.ts";
export { UnconfiguredObjectStorage } from "./internal/storage.ts";
export type {
  ObjectStorage,
  StorageObject,
  PutObjectInput,
} from "./internal/storage.ts";
export { S3CompatibleObjectStorage } from "./internal/storage-s3.ts";
export type { S3CompatibleObjectStorageOptions } from "./internal/storage-s3.ts";

// ---- Redis-backed queue / lock / cache (DATA-002) -----------------------
export { RedisJobQueue } from "./internal/queue-redis.ts";
export type { RedisJobQueueOptions } from "./internal/queue-redis.ts";
export { RedisCache } from "./internal/cache-redis.ts";
export type { Cache, RedisCacheOptions } from "./internal/cache-redis.ts";
export { RedisLockProvider } from "./internal/lock-redis.ts";
export type {
  Lock,
  LockProvider,
  RedisLockProviderOptions,
} from "./internal/lock-redis.ts";

// ---- Infrastructure configuration (DATA-001..003, §8 config boundary) ----
export { loadPlatformConfig, resolveMode } from "./internal/config.ts";
export type {
  PlatformConfig,
  PlatformMode,
  PostgresConfig,
  RedisConfig,
  StorageConfig,
} from "./internal/config.ts";

// ---- Infrastructure composition & health --------------------------------
export { createInfrastructure } from "./internal/infra.ts";
export type { Infrastructure, CreateInfrastructureOptions } from "./internal/infra.ts";
export { createHealthProbe } from "./internal/health.ts";
export type {
  HealthProbe,
  HealthReport,
  HealthProbeInputs,
  ComponentHealth,
} from "./internal/health.ts";

// ---- Runtime composition -------------------------------------------------
export { createRuntime } from "./internal/runtime.ts";
export type { Runtime, RuntimeOptions } from "./internal/runtime.ts";
