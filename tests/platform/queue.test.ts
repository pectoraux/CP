// tests/platform/queue.test.ts — async worker: non-blocking enqueue,
// execution-id propagation, job-scoped logging, status transitions,
// failure handling. (WORK-001 PLAT-AC-03, OBS-AC-01, OBS-AC-02)
import { describe, expect, it } from "bun:test";
import {
  InProcessJobQueue,
  createLogger,
  getCurrentContext,
} from "@cp/platform";
import { CapturingLogSink } from "../helpers.ts";

describe("InProcessJobQueue", () => {
  it("enqueue returns a job id synchronously without running the job (PLAT-AC-03)", async () => {
    const sink = new CapturingLogSink();
    const logger = createLogger({ sink });
    const q = new InProcessJobQueue({ logger });
    let handlerRan = false;
    q.registerHandler("test.echo", async () => {
      handlerRan = true;
      return { status: "completed" as const, result: { ok: true } };
    });
    q.start();
    const t0 = Date.now();
    const { jobId } = q.enqueue({
      type: "test.echo",
      executionId: "exec-1",
      correlationId: "corr-1",
      requestId: "req-1",
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(20); // enqueue does not block on job execution
    expect(jobId).toMatch(/^job_/);
    // the job has not run synchronously
    expect(handlerRan).toBe(false);
    expect(q.getStatus(jobId)!.status).toBe("pending");
    await q.idle();
    expect(handlerRan).toBe(true);
    expect(q.getStatus(jobId)!.status).toBe("completed");
    await q.stop();
  });

  it("propagates execution/correlation ids into the handler and its logs (OBS-AC-01/02)", async () => {
    const sink = new CapturingLogSink();
    const logger = createLogger({ sink });
    const q = new InProcessJobQueue({ logger });
    let seenExecutionId: string | undefined;
    let seenCorrelationId: string | undefined;
    let seenRequestId: string | undefined;
    q.registerHandler("test.ctx", async (job) => {
      const ctx = getCurrentContext();
      seenExecutionId = ctx.executionId;
      seenCorrelationId = ctx.correlationId;
      seenRequestId = ctx.requestId;
      logger.info("job.ran", { job_type: job.type });
      return { status: "completed" as const };
    });
    q.start();
    const { jobId } = q.enqueue({
      type: "test.ctx",
      executionId: "exec-abc",
      correlationId: "corr-xyz",
      requestId: "req-xyz",
    });
    await q.idle();

    // OBS-AC-01: execution id propagated into the background job
    expect(seenExecutionId).toBe("exec-abc");
    expect(seenCorrelationId).toBe("corr-xyz");
    expect(seenRequestId).toBe("req-xyz");

    // OBS-AC-02: job-scoped logs carry the correlation identifiers
    const record = sink.find("job.ran");
    expect(record).toBeDefined();
    expect(record!.execution_id).toBe("exec-abc");
    expect(record!.correlation_id).toBe("corr-xyz");
    expect(record!.request_id).toBe("req-xyz");

    expect(q.getStatus(jobId)!.status).toBe("completed");
    await q.stop();
  });

  it("records failure and emits a failure log when a handler throws", async () => {
    const sink = new CapturingLogSink();
    const logger = createLogger({ sink });
    const q = new InProcessJobQueue({ logger });
    q.registerHandler("test.boom", async () => {
      throw new Error("kaboom");
    });
    q.start();
    const { jobId } = q.enqueue({
      type: "test.boom",
      executionId: "exec-fail",
      correlationId: "corr-fail",
    });
    await q.idle();
    const state = q.getStatus(jobId)!;
    expect(state.status).toBe("failed");
    expect(state.error!.message).toBe("kaboom");
    // failure log carries the job's correlation identifiers
    const failLog = sink.find("queue: job failed");
    expect(failLog).toBeDefined();
    expect(failLog!.execution_id).toBe("exec-fail");
    expect(failLog!.correlation_id).toBe("corr-fail");
    await q.stop();
  });

  it("runs multiple jobs concurrently up to the concurrency limit", async () => {
    const sink = new CapturingLogSink();
    const logger = createLogger({ sink });
    const q = new InProcessJobQueue({ logger, concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    q.registerHandler("test.parallel", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { status: "completed" as const };
    });
    q.start();
    for (let i = 0; i < 6; i++) {
      q.enqueue({
        type: "test.parallel",
        executionId: `exec-${i}`,
        correlationId: `corr-${i}`,
      });
    }
    await q.idle();
    expect(maxActive).toBeLessThanOrEqual(2);
    await q.stop();
  });

  it("fails a job whose handler type has no registration", async () => {
    const sink = new CapturingLogSink();
    const logger = createLogger({ sink });
    const q = new InProcessJobQueue({ logger });
    q.start();
    const { jobId } = q.enqueue({
      type: "test.unregistered",
      executionId: "exec-x",
    });
    await q.idle();
    expect(q.getStatus(jobId)!.status).toBe("failed");
    expect(q.getStatus(jobId)!.error!.code).toBe("queue.handler.threw");
    await q.stop();
  });
});
