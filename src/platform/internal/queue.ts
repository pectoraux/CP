// /platform/internal/queue.ts
// Asynchronous job queue. Long-running work returns a job id without
// blocking the API (WORK-001 PLAT-AC-03). Each job envelope preserves the
// originating execution/correlation identifiers, and the worker restores
// them into the active execution context so job-scoped logs carry the
// correlation identifiers (WORK-001 OBS-AC-01, OBS-AC-02).
//
// WORK-001 ships an in-process implementation behind a provider-neutral
// interface so that WORK-002 can swap in a Redis-backed queue without
// changing call sites.

import { runInContextAsync } from "./context.ts";
import type { Logger } from "./logger.ts";
import { defaultLogger } from "./logger.ts";

export type JobType = string;

export interface JobEnvelope {
  id: string;
  type: JobType;
  payload: unknown;
  // correlation identifiers preserved across the async boundary
  requestId?: string;
  executionId?: string;
  correlationId?: string;
  organizationId?: string;
  projectId?: string;
  enqueuedAt: number; // epoch ms
  attempts: number;
}

export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface JobState {
  id: string;
  type: JobType;
  status: JobStatus;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: unknown;
  error?: { category: string; code: string; message: string };
  attempts: number;
}

export type JobHandlerResult = {
  status: "completed" | "failed";
  result?: unknown;
  error?: { category: string; code: string; message: string };
};

export type JobHandler = (
  job: JobEnvelope,
) => Promise<JobHandlerResult>;

export interface JobQueue {
  enqueue(input: {
    type: JobType;
    payload?: unknown;
    executionId?: string;
    correlationId?: string;
    requestId?: string;
    organizationId?: string;
    projectId?: string;
  }): { jobId: string };

  registerHandler(type: JobType, handler: JobHandler): void;

  start(): void;
  stop(): Promise<void>;

  getStatus(jobId: string): JobState | undefined;
  /** Resolve when the queue is drained (no pending/running jobs). */
  idle(): Promise<void>;
}

interface InternalJob extends JobEnvelope {
  handler?: JobHandler;
}

export interface InProcessJobQueueOptions {
  concurrency?: number;
  logger?: Logger;
}

export class InProcessJobQueue implements JobQueue {
  private readonly pending: InternalJob[] = [];
  private readonly running = new Map<string, InternalJob>();
  private readonly state = new Map<string, JobState>();
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly concurrency: number;
  private readonly logger: Logger;
  private started = false;
  private draining: Array<() => void> = [];
  private activeDispatch = false;

  constructor(opts: InProcessJobQueueOptions = {}) {
    this.concurrency = opts.concurrency ?? 4;
    this.logger = opts.logger ?? defaultLogger;
  }

  enqueue(input: {
    type: JobType;
    payload?: unknown;
    executionId?: string;
    correlationId?: string;
    requestId?: string;
    organizationId?: string;
    projectId?: string;
  }): { jobId: string } {
    const id = "job_" + crypto.randomUUID();
    const envelope: InternalJob = {
      id,
      type: input.type,
      payload: input.payload,
      requestId: input.requestId,
      executionId: input.executionId,
      correlationId: input.correlationId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      enqueuedAt: Date.now(),
      attempts: 0,
    };
    this.pending.push(envelope);
    this.state.set(id, {
      id,
      type: input.type,
      status: "pending",
      enqueuedAt: envelope.enqueuedAt,
      attempts: 0,
    });
    // Non-blocking: defer dispatch to a later microtask so enqueue returns
    // before any job work begins (PLAT-AC-03).
    if (this.started) {
      queueMicrotask(() => void this.dispatch());
    }
    return { jobId: id };
  }

  registerHandler(type: JobType, handler: JobHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`queue: handler already registered for type ${type}`);
    }
    this.handlers.set(type, handler);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.dispatch();
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.idle();
    // reject any remaining idle waiters (queue stopped)
    const waiters = this.draining;
    this.draining = [];
    for (const w of waiters) w();
  }

  getStatus(jobId: string): JobState | undefined {
    const s = this.state.get(jobId);
    return s ? { ...s } : undefined;
  }

  async idle(): Promise<void> {
    if (this.pending.length === 0 && this.running.size === 0) return;
    await new Promise<void>((resolve) => {
      this.draining.push(resolve);
    });
  }

  private notifyIdle(): void {
    if (this.pending.length === 0 && this.running.size === 0) {
      const waiters = this.draining;
      this.draining = [];
      for (const w of waiters) w();
    }
  }

  private async dispatch(): Promise<void> {
    if (!this.started || this.activeDispatch) return;
    this.activeDispatch = true;
    try {
      while (
        this.started &&
        this.running.size < this.concurrency &&
        this.pending.length > 0
      ) {
        const job = this.pending.shift();
        if (!job) break;
        this.running.set(job.id, job);
        void this.runJob(job);
      }
    } finally {
      this.activeDispatch = false;
    }
  }

  private async runJob(job: InternalJob): Promise<void> {
    const state = this.state.get(job.id);
    if (!state) {
      this.running.delete(job.id);
      this.notifyIdle();
      void this.dispatch();
      return;
    }

    // Restore the originating correlation identifiers into the active
    // execution context for the entire job lifecycle (including failure
    // logging) so job-scoped logs carry them (OBS-AC-01/OBS-AC-02).
    const ctx = {
      requestId: job.requestId,
      executionId: job.executionId,
      correlationId: job.correlationId ?? job.requestId,
      organizationId: job.organizationId,
      projectId: job.projectId,
    };

    await runInContextAsync(ctx, async () => {
      state.status = "running";
      state.startedAt = Date.now();
      state.attempts = (job.attempts = job.attempts + 1);
      try {
        const handler = this.handlers.get(job.type);
        if (!handler) {
          throw new Error(
            `queue: no handler registered for type ${job.type}`,
          );
        }
        const result = await handler(job);
        state.status = result.status;
        state.result = result.result;
        if (result.error) {
          state.error = result.error;
        }
        state.finishedAt = Date.now();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        state.status = "failed";
        state.error = {
          category: "PLATFORM_FAILURE",
          code: "queue.handler.threw",
          message,
        };
        state.finishedAt = Date.now();
        this.logger.error("queue: job failed", {
          job_id: job.id,
          job_type: job.type,
          error: message,
        });
      } finally {
        this.running.delete(job.id);
        this.notifyIdle();
        // keep draining
        void this.dispatch();
      }
    });
  }
}
