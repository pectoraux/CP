// tests/infra/storage-s3.test.ts — real Minio (S3-compatible) object-storage
// integration proving the provider-neutral ObjectStorage contract
// (WORK-002 DATA-AC-03). Tests exercise put/get/delete/stat against a real
// S3-compatible server; no S3/Minio-specific concepts leak to the test.
import { describe, expect, it } from "bun:test";
import { S3CompatibleObjectStorage, AppError } from "@cp/platform";
import { withInfra } from "./harness.ts";

describe("S3CompatibleObjectStorage (real Minio)", () => {
  it("put/get round-trips bytes and reports size/content-type", async () => {
    await withInfra(async (h) => {
      const s = new S3CompatibleObjectStorage({
        endpoint: h.storage.endpoint,
        region: h.storage.region,
        bucket: h.storage.bucket,
        accessKeyId: h.storage.accessKeyId,
        secretAccessKey: h.storage.secretAccessKey,
        forcePathStyle: true,
      });
      const key = "artifacts/alpha.bin";
      const body = new TextEncoder().encode("hello world");
      const obj = await s.put({ key, body, contentType: "text/plain" });
      expect(obj.key).toBe(key);
      expect(obj.size).toBe(body.byteLength);
      expect(obj.contentType).toBe("text/plain");
      expect(obj.etag).toBeDefined();

      const got = await s.get(key);
      expect(new TextDecoder().decode(got)).toBe("hello world");
    });
  });

  it("stat returns metadata for an existing object and undefined when missing", async () => {
    await withInfra(async (h) => {
      const s = new S3CompatibleObjectStorage({
        endpoint: h.storage.endpoint,
        region: h.storage.region,
        bucket: h.storage.bucket,
        accessKeyId: h.storage.accessKeyId,
        secretAccessKey: h.storage.secretAccessKey,
        forcePathStyle: true,
      });
      const key = "artifacts/beta.json";
      await s.put({
        key,
        body: JSON.stringify({ ok: true }),
        contentType: "application/json",
        metadata: { origin: "work002-test" },
      });
      const stat = await s.stat(key);
      expect(stat).toBeDefined();
      expect(stat!.size).toBe(JSON.stringify({ ok: true }).length);
      expect(stat!.contentType).toBe("application/json");
      expect(stat!.metadata?.["origin"]).toBe("work002-test");

      const missing = await s.stat("artifacts/never-existed");
      expect(missing).toBeUndefined();
    });
  });

  it("get on a missing object throws a normalized AppError (not_found)", async () => {
    await withInfra(async (h) => {
      const s = new S3CompatibleObjectStorage({
        endpoint: h.storage.endpoint,
        region: h.storage.region,
        bucket: h.storage.bucket,
        accessKeyId: h.storage.accessKeyId,
        secretAccessKey: h.storage.secretAccessKey,
        forcePathStyle: true,
      });
      try {
        await s.get("does/not/exist");
        throw new Error("expected get to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        const e = err as AppError;
        expect(e.code).toBe("storage.not_found");
      }
    });
  });

  it("delete removes an object; re-delete is idempotent", async () => {
    await withInfra(async (h) => {
      const s = new S3CompatibleObjectStorage({
        endpoint: h.storage.endpoint,
        region: h.storage.region,
        bucket: h.storage.bucket,
        accessKeyId: h.storage.accessKeyId,
        secretAccessKey: h.storage.secretAccessKey,
        forcePathStyle: true,
      });
      const key = "artifacts/gamma.txt";
      await s.put({ key, body: "x", contentType: "text/plain" });
      await s.delete(key);
      expect(await s.stat(key)).toBeUndefined();
      // Deleting again is a no-op (S3 DELETE is idempotent).
      await expect(s.delete(key)).resolves.toBeUndefined();
    });
  });

  it("overwrite: putting the same key replaces the content", async () => {
    await withInfra(async (h) => {
      const s = new S3CompatibleObjectStorage({
        endpoint: h.storage.endpoint,
        region: h.storage.region,
        bucket: h.storage.bucket,
        accessKeyId: h.storage.accessKeyId,
        secretAccessKey: h.storage.secretAccessKey,
        forcePathStyle: true,
      });
      const key = "artifacts/delta.bin";
      await s.put({ key, body: "first" });
      await s.put({ key, body: "second" });
      const got = await s.get(key);
      expect(new TextDecoder().decode(got)).toBe("second");
    });
  });

  it("accepts a ReadableStream body", async () => {
    await withInfra(async (h) => {
      const s = new S3CompatibleObjectStorage({
        endpoint: h.storage.endpoint,
        region: h.storage.region,
        bucket: h.storage.bucket,
        accessKeyId: h.storage.accessKeyId,
        secretAccessKey: h.storage.secretAccessKey,
        forcePathStyle: true,
      });
      const chunks = [new TextEncoder().encode("stream "), new TextEncoder().encode("body")];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          controller.close();
        },
      });
      await s.put({ key: "artifacts/epsilon.stream", body: stream, contentType: "application/octet-stream" });
      const got = await s.get("artifacts/epsilon.stream");
      expect(new TextDecoder().decode(got)).toBe("stream body");
    });
  });

  it("normalizes a bad-credentials configuration failure (CREDENTIAL_FAILURE)", async () => {
    await withInfra(async (h) => {
      const s = new S3CompatibleObjectStorage({
        endpoint: h.storage.endpoint,
        region: h.storage.region,
        bucket: h.storage.bucket,
        accessKeyId: "wrong",
        secretAccessKey: "wrongwrongwrong",
        forcePathStyle: true,
      });
      try {
        await s.put({ key: "artifacts/forbidden.bin", body: "x" });
        throw new Error("expected put to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        const e = err as AppError;
        expect(e.category).toBe("CREDENTIAL_FAILURE");
      }
    });
  });

  it("clean configuration failure: unreachable endpoint -> NETWORK_FAILURE", async () => {
    const s = new S3CompatibleObjectStorage({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      bucket: "x",
      accessKeyId: "k",
      secretAccessKey: "s",
      forcePathStyle: true,
    });
    try {
      await s.put({ key: "nope", body: "x" });
      throw new Error("expected put to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.category).toBe("NETWORK_FAILURE");
    }
  });
});
