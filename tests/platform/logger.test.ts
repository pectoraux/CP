// tests/platform/logger.test.ts — structured logger carries correlation ids.
import { describe, expect, it } from "bun:test";
import { createLogger, runInContext } from "@cp/platform";
import { CapturingLogSink } from "../helpers.ts";

describe("logger", () => {
  it("carries traceable ids from the active context (OBS-AC-02)", () => {
    const sink = new CapturingLogSink();
    const log = createLogger({ sink });
    runInContext(
      {
        requestId: "req-1",
        executionId: "exec-1",
        correlationId: "corr-1",
        organizationId: "org-1",
        projectId: "proj-1",
      },
      () => {
        log.info("hello", { foo: "bar" });
      },
    );
    expect(sink.records.length).toBe(1);
    const r = sink.records[0]!;
    expect(r.msg).toBe("hello");
    expect(r.request_id).toBe("req-1");
    expect(r.execution_id).toBe("exec-1");
    expect(r.correlation_id).toBe("corr-1");
    expect(r.organization_id).toBe("org-1");
    expect(r.project_id).toBe("proj-1");
    expect(r.fields.foo).toBe("bar");
    expect(r.level).toBe("info");
    expect(typeof r.ts).toBe("string");
  });

  it("emits no correlation ids when no context is active", () => {
    const sink = new CapturingLogSink();
    const log = createLogger({ sink });
    log.info("ctxless");
    expect(sink.records[0]!.request_id).toBeUndefined();
    expect(sink.records[0]!.execution_id).toBeUndefined();
  });

  it("respects minimum level filtering", () => {
    const sink = new CapturingLogSink();
    const log = createLogger({ sink, level: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(sink.records.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  it("default fields are merged into every record", () => {
    const sink = new CapturingLogSink();
    const log = createLogger({ sink, defaultFields: { service: "cp" } });
    log.info("x");
    expect(sink.records[0]!.fields.service).toBe("cp");
  });
});
