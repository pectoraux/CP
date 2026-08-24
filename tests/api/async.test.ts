// tests/api/async.test.ts — transport-boundary async operation flow.
// Proves WORK-001 PLAT-AC-03 (long-running jobs return without blocking),
// OBS-AC-01 (execution ids propagate into background jobs), and the
// correlation-id middleware.
import { describe, expect, it } from "bun:test";
import { createApi } from "@cp/api";
import { CapturingLogSink } from "../helpers.ts";

describe("api /v1/platform/operations (PLAT-AC-03, OBS-AC-01, OBS-AC-02)", () => {
  it("POST returns 202 with an operation id well before the job completes", async () => {
    const sink = new CapturingLogSink();
    const { app, runtime } = createApi({ loggerSink: sink });
    try {
      const t0 = performance.now();
      const res = await app.request("/v1/platform/operations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-async-1",
        },
        body: JSON.stringify({ async_ms: 300 }),
      });
      const elapsed = performance.now() - t0;

      expect(res.status).toBe(202);
      // non-blocking: returned far before the 300ms job finishes
      expect(elapsed).toBeLessThan(100);
      // correlation id echoed on the response
      expect(res.headers.get("x-request-id")).toBe("req-async-1");

      const body = (await res.json()) as {
        operation_id: string;
        execution_id: string;
        status: string;
      };
      expect(body.operation_id).toMatch(/^job_/);
      expect(body.execution_id).toMatch(/^exec_/);
      expect(body.status).toBe("pending");

      // let the background job run to completion
      await runtime.queue.idle();

      const state = runtime.queue.getStatus(body.operation_id);
      expect(state?.status).toBe("completed");

      // GET reflects completed status + propagated execution id
      const get = await app.request(
        `/v1/platform/operations/${body.operation_id}`,
        { method: "GET" },
      );
      expect(get.status).toBe(200);
      const gb = (await get.json()) as {
        status: string;
        execution_id: string;
      };
      expect(gb.status).toBe("completed");
      expect(gb.execution_id).toBe(body.execution_id);

      // OBS-AC-01/02: job-scoped log carries the execution + correlation ids
      const record = sink.find("platform.operation: completed");
      expect(record, sink.text()).toBeDefined();
      expect(record!.execution_id).toBe(body.execution_id);
      expect(record!.correlation_id).toBe("req-async-1");
      expect(record!.request_id).toBe("req-async-1");
    } finally {
      await runtime.queue.stop();
    }
  });

  it("generates a request id when the client sends none", async () => {
    const { app, runtime } = createApi();
    try {
      const res = await app.request("/v1/platform/health", {
        method: "GET",
      });
      expect(res.status).toBe(200);
      const rid = res.headers.get("x-request-id");
      expect(rid).toMatch(/^req_/);
    } finally {
      await runtime.queue.stop();
    }
  });

  it("preserves a client-supplied request id", async () => {
    const { app, runtime } = createApi();
    try {
      const res = await app.request("/v1/platform/health", {
        method: "GET",
        headers: { "x-request-id": "client-req-42" },
      });
      expect(res.headers.get("x-request-id")).toBe("client-req-42");
    } finally {
      await runtime.queue.stop();
    }
  });

  it("GET of an unknown operation returns a structured 404 error", async () => {
    const { app, runtime } = createApi();
    try {
      const res = await app.request(
        "/v1/platform/operations/does-not-exist",
        { method: "GET" },
      );
      expect(res.status).toBe(404);
      const b = (await res.json()) as {
        error: { category: string; code: string };
      };
      expect(b.error.category).toBe("PLATFORM_FAILURE");
      expect(b.error.code).toBe("operation.not_found");
    } finally {
      await runtime.queue.stop();
    }
  });
});
