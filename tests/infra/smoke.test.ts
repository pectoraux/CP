// tests/infra/smoke.test.ts — end-to-end WORK-002 runtime smoke. Proves the
// real flow: API transport -> (Redis-backed) JobQueue -> worker ->
// ExecutionContext, plus a PostgreSQL round-trip and an object-storage
// put/get. Every piece runs against real infrastructure (no mocks).
import { describe, expect, it } from "bun:test";
import { createApi } from "@cp/api";
import {
  createInfrastructure,
  createLogger,
  loadPlatformConfig,
  type PlatformConfig,
} from "@cp/platform";
import { withInfra } from "./harness.ts";
import { CapturingLogSink } from "../helpers.ts";

describe("WORK-002 runtime smoke (real infra, end-to-end)", () => {
  it("API -> RedisJobQueue -> worker -> ExecutionContext; PostgreSQL + Object Storage + health", async () => {
    await withInfra(async (h) => {
      const cfg: PlatformConfig = loadPlatformConfig({
        CP_ENV: "test",
        CP_DATABASE_URL: h.pg.connectionString,
        CP_REDIS_URL: h.redis.url,
        CP_STORAGE_ENDPOINT: h.storage.endpoint,
        CP_STORAGE_BUCKET: h.storage.bucket,
        CP_STORAGE_ACCESS_KEY_ID: h.storage.accessKeyId,
        CP_STORAGE_SECRET_ACCESS_KEY: h.storage.secretAccessKey,
        CP_STORAGE_REGION: h.storage.region,
      });

      const sink = new CapturingLogSink();
      const logger = createLogger({ sink });
      const infra = createInfrastructure({ config: cfg, logger });

      try {
        // ---- PostgreSQL round-trip (DATA-AC-01) ----------------------------
        await infra.db.exec({ text: "DROP TABLE IF EXISTS smoke_probe" });
        await infra.db.exec({
          text: "CREATE TABLE smoke_probe (id int PRIMARY KEY, note text NOT NULL)",
        });
        await infra.db.transaction(async (tx) => {
          await tx.exec({ text: "INSERT INTO smoke_probe (id, note) VALUES (1, 'hello-from-api')" });
        });
        const rows = await infra.db.query({ text: "SELECT note FROM smoke_probe WHERE id = 1" });
        expect(rows[0]!["note"]).toBe("hello-from-api");

        // ---- Object storage put/get (DATA-AC-03) --------------------------
        await infra.storage.put({
          key: "smoke/artifact.bin",
          body: Buffer.from("control-plane-artifact"),
          contentType: "application/octet-stream",
          metadata: { produced_by: "smoke" },
        });
        const got = await infra.storage.get("smoke/artifact.bin");
        expect(new TextDecoder().decode(got)).toBe("control-plane-artifact");
        const stat = await infra.storage.stat("smoke/artifact.bin");
        expect(stat!.metadata?.["produced_by"]).toBe("smoke");

        // ---- API -> RedisJobQueue -> worker -> ExecutionContext ------------
        // createApi builds a runtime from RuntimeOptions. By injecting the
        // Redis-backed queue/db/storage, the API transport drives real
        // infrastructure: POST enqueues on the RedisJobQueue, the Redis
        // worker runs the handler inside a restored execution context, and
        // job-scoped logs carry the execution/correlation ids.
        const api = createApi({
          loggerSink: sink,
          queue: infra.queue,
          db: infra.db,
          storage: infra.storage,
        });
        try {
          const t0 = performance.now();
          const res = await api.app.request("/v1/platform/operations", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-request-id": "smoke-req-1",
            },
            body: JSON.stringify({ async_ms: 200 }),
          });
          const elapsed = performance.now() - t0;
          expect(res.status).toBe(202);
          expect(elapsed).toBeLessThan(150); // non-blocking (PLAT-AC-03)
          expect(res.headers.get("x-request-id")).toBe("smoke-req-1");
          const body = (await res.json()) as {
            operation_id: string;
            execution_id: string;
            status: string;
          };
          expect(body.operation_id).toMatch(/^job_/);
          expect(body.execution_id).toMatch(/^exec_/);
          expect(body.status).toBe("pending");

          // Let the Redis worker run the job to completion.
          await infra.queue.idle();
          const state = infra.queue.getStatus(body.operation_id);
          expect(state?.status).toBe("completed");

          // GET reflects completed status + propagated execution_id.
          const get = await api.app.request(
            `/v1/platform/operations/${body.operation_id}`,
            { method: "GET" },
          );
          expect(get.status).toBe(200);
          const gb = (await get.json()) as { status: string; execution_id: string };
          expect(gb.status).toBe("completed");
          expect(gb.execution_id).toBe(body.execution_id);

          // OBS-AC-01/02: the job-scoped log carries the execution +
          // correlation ids across the Redis boundary.
          const record = sink.find("platform.operation: completed");
          expect(record, sink.text()).toBeDefined();
          expect(record!.execution_id).toBe(body.execution_id);
          expect(record!.correlation_id).toBe("smoke-req-1");
          expect(record!.request_id).toBe("smoke-req-1");
        } finally {
          await api.runtime.queue.stop();
        }

        // ---- Health probe (§9) --------------------------------------------
        const report = await infra.health.check();
        expect(report.database).toBe("ok");
        expect(report.redis).toBe("ok");
        expect(report.storage).toBe("ok");
      } finally {
        await infra.shutdown();
      }
    });
  });
});
