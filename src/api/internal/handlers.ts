// /api/internal/handlers.ts
// Demo async-operation route. Proves the foundation property required by
// WORK-001 PLAT-AC-03 (long-running jobs return without blocking the API)
// and OBS-AC-01 (execution IDs propagate into background jobs).
//
// These routes live under /v1/platform/* because WORK-001 owns /platform.
// The full /v1 resource families are added in WORK-004.

import { Hono } from "hono";
import {
  newExecutionId,
  type Runtime,
} from "@cp/platform";

interface Vars {
  requestId: string;
}

interface OperationInput {
  async_ms?: number;
  payload?: unknown;
}

// Holds the small in-memory mapping of operation_id -> execution_id so the
// GET endpoint can surface the propagated execution_id back to the caller
// for verification. (Production execution records live in /executions; this
// is a foundation-only affordance.)
const operationExecutions = new Map<string, string>();

export function createPlatformRoutes(
  runtime: Runtime,
  app: Hono<{ Variables: Vars }>,
): void {
  // Register the demo job handler on the queue. The handler runs inside the
  // restored execution context, so any log it emits carries the originating
  // execution_id / correlation_id.
  runtime.queue.registerHandler(
    "platform.operation",
    async (job) => {
      const input = (job.payload ?? {}) as OperationInput;
      const sleepMs = Math.max(
        0,
        Math.min(5_000, input.async_ms ?? 0),
      );
      if (sleepMs > 0) {
        await new Promise((r) => setTimeout(r, sleepMs));
      }
      runtime.logger.info("platform.operation: completed", {
        operation_id: job.id,
        slept_ms: sleepMs,
      });
      return {
        status: "completed" as const,
        result: { operation_id: job.id, slept_ms: sleepMs },
      };
    },
  );

  app.post("/v1/platform/operations", async (c) => {
    let input: OperationInput = {};
    try {
      const body = await c.req.json();
      if (body && typeof body === "object") {
        input = body as OperationInput;
      }
    } catch {
      // empty body is allowed; defaults apply
    }

    const requestId = c.get("requestId");
    const executionId = newExecutionId();

    // Enqueue the long-running job. enqueue() returns synchronously with a
    // job id; the job executes later on the worker. We surface the queue's
    // job_id as the operation_id returned to the caller.
    const { jobId } = runtime.queue.enqueue({
      type: "platform.operation",
      payload: input,
      executionId,
      correlationId: requestId,
      requestId,
    });
    operationExecutions.set(jobId, executionId);

    return c.json(
      {
        operation_id: jobId,
        execution_id: executionId,
        status: "pending",
      },
      202,
    );
  });

  app.get("/v1/platform/operations/:id", (c) => {
    const id = c.req.param("id");
    const state = runtime.queue.getStatus(id);
    if (!state) {
      return c.json(
        {
          error: {
            category: "PLATFORM_FAILURE",
            code: "operation.not_found",
            message: `operation ${id} not found`,
            retryable: false,
          },
        },
        404,
      );
    }
    const executionId = operationExecutions.get(id);
    return c.json({
      operation_id: id,
      execution_id: executionId,
      status: state.status,
      enqueued_at: state.enqueuedAt,
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      result: state.result,
      error: state.error,
    });
  });

  // Minimal health/readiness for the transport boundary.
  app.get("/v1/platform/health", (c) =>
    c.json({ status: "ok" }),
  );
}
