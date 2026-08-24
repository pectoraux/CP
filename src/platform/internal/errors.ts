// /platform/internal/errors.ts
// Structured application error model + failure classification (architecture
// §31) + error-tracking interface. Distinguishes provider failure, policy
// block, timeout, etc., so that a provider failure is never represented as a
// policy failure.

export type FailureCategory =
  | "PROVIDER_FAILURE"
  | "NETWORK_FAILURE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "POLICY_BLOCKED"
  | "INELIGIBLE"
  | "CREDENTIAL_FAILURE"
  | "EXECUTION_FAILURE"
  | "OUTCOME_FAILURE"
  | "PLATFORM_FAILURE"
  | "EXPERIMENT_FAILURE";

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "PROVIDER_FAILURE",
  "NETWORK_FAILURE",
  "RATE_LIMITED",
  "TIMEOUT",
  "POLICY_BLOCKED",
  "INELIGIBLE",
  "CREDENTIAL_FAILURE",
  "EXECUTION_FAILURE",
  "OUTCOME_FAILURE",
  "PLATFORM_FAILURE",
  "EXPERIMENT_FAILURE",
] as const;

export interface ErrorTracker {
  capture(error: unknown, context?: Record<string, unknown>): void;
}

const noopErrorTracker: ErrorTracker = {
  capture: () => {},
};

export function noopErrorTrackerFactory(): ErrorTracker {
  return noopErrorTracker;
}

export interface AppErrorOptions {
  category: FailureCategory;
  code: string;
  message: string;
  retryable?: boolean;
  transient?: boolean;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly category: FailureCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly transient: boolean;
  readonly causeValue: unknown;
  readonly details: Record<string, unknown>;

  constructor(opts: AppErrorOptions) {
    super(opts.message);
    this.name = "AppError";
    this.category = opts.category;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.transient = opts.transient ?? false;
    this.causeValue = opts.cause;
    this.details = opts.details ?? {};
    // preserve stack where available
    if (opts.cause instanceof Error && !this.cause) {
      // node 16.9+ Error cause
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      transient: this.transient,
      details: this.details,
    };
  }
}
