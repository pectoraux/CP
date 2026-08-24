// /platform/internal/context.ts
// Execution context propagation across asynchronous boundaries.
// Carries the traceable identifiers required by architecture §28:
//   request_id, execution_id, correlation_id, organization_id, project_id,
//   strategy_id, strategy_version, provider_id, experiment_id.
// Uses AsyncLocalStorage so that background workers and async handlers
// automatically carry the identifiers of the originating request/job.

import { AsyncLocalStorage } from "node:async_hooks";

export interface ExecutionContext {
  requestId?: string;
  executionId?: string;
  correlationId?: string;
  organizationId?: string;
  projectId?: string;
  strategyId?: string;
  strategyVersion?: number;
  providerId?: string;
  experimentId?: string;
  // free-form structured fields for additional correlation
  [key: string]: string | number | undefined;
}

const storage = new AsyncLocalStorage<ExecutionContext>();

const EMPTY: ExecutionContext = Object.freeze({}) as ExecutionContext;

/**
 * Read the currently active execution context. Returns an empty (frozen)
 * context if none is active. Never throws.
 */
export function getCurrentContext(): Readonly<ExecutionContext> {
  return storage.getStore() ?? EMPTY;
}

/**
 * Run `fn` with `ctx` as the active execution context. Identifiers set here
 * are visible to logs/metrics/traces emitted within `fn` and any async work
 * it awaits. Returns whatever `fn` returns.
 */
export function runInContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Run an async `fn` with `ctx` active. Awaits the result.
 */
export async function runInContextAsync<T>(
  ctx: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, () => fn());
}

/**
 * Merge a partial context into the currently active one (creating a child
 * context). Useful for refining context as a request progresses
 * (e.g. attaching an execution_id once it is known).
 */
export function withContext(partial: ExecutionContext): ExecutionContext {
  const parent = storage.getStore() ?? EMPTY;
  const merged: ExecutionContext = { ...parent, ...partial };
  return merged;
}

/**
 * Replace the active context with `partial` merged on top of the current
 * context, for the duration of `fn`.
 */
export function extendContext<T>(
  partial: ExecutionContext,
  fn: () => T,
): T {
  return storage.run(withContext(partial), fn);
}

/**
 * Read the correlation identifier from the active context.
 * Falls back to request_id when no explicit correlation_id is set.
 */
export function getCorrelationId(): string | undefined {
  const ctx = getCurrentContext();
  return ctx.correlationId ?? ctx.requestId;
}
