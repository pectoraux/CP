// /platform/internal/logger.ts
// Structured logger. Every log line automatically carries the traceable
// identifiers from the active execution context (architecture §28), so that
// job-scoped logs preserve execution/correlation identifiers across
// asynchronous boundaries (WORK-001 OBS-AC-02).

import { getCurrentContext } from "./context.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface LogRecord {
  ts: string; // ISO 8601 UTC
  level: LogLevel;
  msg: string;
  fields: LogFields;
  request_id?: string;
  execution_id?: string;
  correlation_id?: string;
  organization_id?: string;
  project_id?: string;
  strategy_id?: string;
  strategy_version?: number;
  provider_id?: string;
  experiment_id?: string;
}

export interface LogSink {
  emit(record: LogRecord): void;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Default sink: emits one JSON object per line to stdout (stderr for
 * error level). Replaceable for production telemetry backends.
 */
class ConsoleLogSink implements LogSink {
  emit(record: LogRecord): void {
    const line = JSON.stringify(record);
    if (record.level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}

export class Logger {
  private minLevel: number;
  private readonly sink: LogSink;
  readonly defaultFields: LogFields;

  constructor(opts: {
    sink?: LogSink;
    level?: LogLevel;
    defaultFields?: LogFields;
  } = {}) {
    this.sink = opts.sink ?? new ConsoleLogSink();
    this.minLevel = LEVELS[opts.level ?? "info"];
    this.defaultFields = opts.defaultFields ?? {};
  }

  setLevel(level: LogLevel): void {
    this.minLevel = LEVELS[level];
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields: LogFields = {}): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields: LogFields = {}): void {
    this.emit("error", msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields: LogFields): void {
    if (LEVELS[level] < this.minLevel) return;
    const ctx = getCurrentContext();
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg,
      fields: { ...this.defaultFields, ...fields },
    };
    // Carry correlation identifiers from the active context.
    if (ctx.requestId) record.request_id = ctx.requestId;
    if (ctx.executionId) record.execution_id = ctx.executionId;
    if (ctx.correlationId) record.correlation_id = ctx.correlationId;
    if (ctx.organizationId) record.organization_id = ctx.organizationId;
    if (ctx.projectId) record.project_id = ctx.projectId;
    if (ctx.strategyId) record.strategy_id = ctx.strategyId;
    if (ctx.strategyVersion !== undefined) {
      record.strategy_version = ctx.strategyVersion;
    }
    if (ctx.providerId) record.provider_id = ctx.providerId;
    if (ctx.experimentId) record.experiment_id = ctx.experimentId;
    this.sink.emit(record);
  }
}

export function createLogger(opts?: {
  sink?: LogSink;
  level?: LogLevel;
  defaultFields?: LogFields;
}): Logger {
  return new Logger(opts);
}

// Module-level default logger. The runtime composes the real singleton.
export const defaultLogger = createLogger();
