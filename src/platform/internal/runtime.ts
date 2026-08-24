// /platform/internal/runtime.ts
// Composition root for the platform runtime foundation. Wires the default
// logger, metrics, error tracker, and in-process job queue. Domain modules
// receive these via the public `/platform` interface — never by reaching
// into internals.

import { noopMeter } from "./metrics.ts";
import { noopErrorTrackerFactory } from "./errors.ts";
import {
  InProcessJobQueue,
  type JobQueue,
} from "./queue.ts";
import {
  UnconfiguredDatabase,
  type Database,
} from "./db.ts";
import {
  UnconfiguredObjectStorage,
  type ObjectStorage,
} from "./storage.ts";
import type { Logger, LogSink, LogLevel } from "./logger.ts";
import { createLogger } from "./logger.ts";

export interface Runtime {
  logger: Logger;
  metrics: typeof noopMeter;
  errorTracker: ReturnType<typeof noopErrorTrackerFactory>;
  queue: JobQueue;
  db: Database;
  storage: ObjectStorage;
}

export interface RuntimeOptions {
  loggerSink?: LogSink;
  logLevel?: LogLevel;
  defaultFields?: Record<string, unknown>;
  queue?: JobQueue;
  db?: Database;
  storage?: ObjectStorage;
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const logger = createLogger({
    sink: opts.loggerSink,
    level: opts.logLevel,
    defaultFields: opts.defaultFields,
  });
  const queue =
    opts.queue ?? new InProcessJobQueue({ logger });
  const db = opts.db ?? new UnconfiguredDatabase();
  const storage = opts.storage ?? new UnconfiguredObjectStorage();
  return {
    logger,
    metrics: noopMeter,
    errorTracker: noopErrorTrackerFactory(),
    queue,
    db,
    storage,
  };
}
