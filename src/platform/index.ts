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
export { UnconfiguredObjectStorage } from "./internal/storage.ts";
export type {
  ObjectStorage,
  StorageObject,
  PutObjectInput,
} from "./internal/storage.ts";

// ---- Runtime composition -------------------------------------------------
export { createRuntime } from "./internal/runtime.ts";
export type { Runtime, RuntimeOptions } from "./internal/runtime.ts";
