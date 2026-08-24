// tests/platform/context.test.ts — execution context propagation.
import { describe, expect, it } from "bun:test";
import {
  getCurrentContext,
  runInContext,
  runInContextAsync,
  withContext,
  extendContext,
  getCorrelationId,
} from "@cp/platform";

describe("execution context", () => {
  it("is empty outside a run", () => {
    const ctx = getCurrentContext();
    expect(ctx.requestId).toBeUndefined();
    expect(ctx.executionId).toBeUndefined();
  });

  it("carries identifiers across awaited async boundaries", async () => {
    await runInContextAsync(
      { requestId: "req-1", executionId: "exec-1" },
      async () => {
        expect(getCurrentContext().requestId).toBe("req-1");
        expect(getCurrentContext().executionId).toBe("exec-1");
        await new Promise((r) => setTimeout(r, 5));
        // still present after a macrotask tick
        expect(getCurrentContext().executionId).toBe("exec-1");
      },
    );
  });

  it("withContext merges onto the current context without running", () => {
    runInContext({ requestId: "req-1" }, () => {
      const merged = withContext({ executionId: "exec-2" });
      expect(merged.requestId).toBe("req-1");
      expect(merged.executionId).toBe("exec-2");
    });
  });

  it("extendContext runs a function with a merged child context", () => {
    runInContext({ requestId: "req-1" }, () => {
      extendContext({ executionId: "exec-3" }, () => {
        expect(getCurrentContext().executionId).toBe("exec-3");
        expect(getCurrentContext().requestId).toBe("req-1");
      });
    });
  });

  it("does not leak context out of runInContext", () => {
    runInContext({ requestId: "req-x" }, () => {
      expect(getCurrentContext().requestId).toBe("req-x");
    });
    expect(getCurrentContext().requestId).toBeUndefined();
  });

  it("getCorrelationId falls back to requestId when unset", () => {
    runInContext({ requestId: "req-1" }, () => {
      expect(getCorrelationId()).toBe("req-1");
    });
    runInContext(
      { requestId: "req-1", correlationId: "corr-9" },
      () => {
        expect(getCorrelationId()).toBe("corr-9");
      },
    );
  });
});
