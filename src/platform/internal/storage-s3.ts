// /platform/internal/storage-s3.ts
// Concrete S3-compatible implementation of the provider-neutral
// ObjectStorage interface (architecture §26, §2.3, lock §12, WORK-002
// DATA-003). The public interface never exposes S3/Minio/R2/GCS/Azure
// concepts to domain modules; `aws4fetch` (SigV4 over fetch) is an
// implementation detail isolated to /platform internals.
//
// Failure model (architecture §31): network/connection errors ->
// NETWORK_FAILURE; access-denied (403) -> CREDENTIAL_FAILURE; other 4xx ->
// PLATFORM_FAILURE; 5xx -> NETWORK_FAILURE. Infrastructure failures are
// never misclassified as PROVIDER_FAILURE or POLICY_BLOCKED.

import { AwsClient } from "aws4fetch";
import { AppError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { defaultLogger } from "./logger.ts";
import type { ObjectStorage, PutObjectInput, StorageObject } from "./storage.ts";

export interface S3CompatibleObjectStorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  logger?: Logger;
}

function normalizeStorageError(
  err: unknown,
  context: string,
  status?: number,
): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // Connection / fetch-level errors carry a TypeError or no status.
  if (status === undefined) {
    return new AppError({
      category: "NETWORK_FAILURE",
      code: "storage.connection",
      message: `storage connection failure during ${context}: ${message}`,
      retryable: true,
      transient: true,
      cause: err,
    });
  }
  if (status === 403 || status === 401) {
    return new AppError({
      category: "CREDENTIAL_FAILURE",
      code: "storage.access_denied",
      message: `storage access denied during ${context} (HTTP ${status})`,
      retryable: false,
      cause: err,
      details: { status },
    });
  }
  if (status === 404) {
    return new AppError({
      category: "PLATFORM_FAILURE",
      code: "storage.not_found",
      message: `storage object not found during ${context} (HTTP 404)`,
      retryable: false,
      cause: err,
      details: { status },
    });
  }
  if (status >= 500) {
    return new AppError({
      category: "NETWORK_FAILURE",
      code: "storage.server_error",
      message: `storage server error during ${context} (HTTP ${status})`,
      retryable: true,
      transient: true,
      cause: err,
      details: { status },
    });
  }
  return new AppError({
    category: "PLATFORM_FAILURE",
    code: "storage.http",
    message: `storage error during ${context} (HTTP ${status})`,
    retryable: false,
    cause: err,
    details: { status },
  });
}

async function readBody(body: PutObjectInput["body"]): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  // ReadableStream<Uint8Array>: buffer into a Uint8Array. (WORK-002 scope
  // proves the boundary; large-artifact streaming is a later optimization.)
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }
  throw new AppError({
    category: "PLATFORM_FAILURE",
    code: "storage.invalid_body",
    message: "storage put body must be Uint8Array, string, or ReadableStream",
    retryable: false,
  });
}

export class S3CompatibleObjectStorage implements ObjectStorage {
  private readonly aws: AwsClient;
  private readonly logger: Logger;
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly region: string;
  private readonly forcePathStyle: boolean;

  constructor(opts: S3CompatibleObjectStorageOptions) {
    this.logger = opts.logger ?? defaultLogger;
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.bucket = opts.bucket;
    this.region = opts.region;
    this.forcePathStyle = opts.forcePathStyle ?? true;
    this.aws = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
      service: "s3",
    });
  }

  private objectUrl(key: string): string {
    const encoded = encodeURIComponent(key);
    if (this.forcePathStyle) {
      return `${this.endpoint}/${this.bucket}/${encoded}`;
    }
    // Virtual-host style (not used by default; supported for completeness).
    const host = new URL(this.endpoint).host;
    return `${this.endpoint.includes("://") ? this.endpoint.split("://")[0] : "https"}://${this.bucket}.${host}/${encoded}`;
  }

  async put(input: PutObjectInput): Promise<StorageObject> {
    const body = await readBody(input.body);
    const headers: Record<string, string> = {
      "content-length": String(body.byteLength),
      "content-type": input.contentType ?? "application/octet-stream",
    };
    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) {
        headers[`x-amz-meta-${k.toLowerCase()}`] = v;
      }
    }
    const url = this.objectUrl(input.key);
    let res: Response;
    try {
      res = await this.aws.fetch(url, {
        method: "PUT",
        body,
        headers,
      });
    } catch (err) {
      throw normalizeStorageError(err, "put");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw normalizeStorageError(
        new Error(text || `PUT ${input.key} failed`),
        "put",
        res.status,
      );
    }
    const etag = res.headers.get("etag") ?? undefined;
    return {
      key: input.key,
      size: body.byteLength,
      contentType: input.contentType ?? "application/octet-stream",
      etag: etag ? etag.replace(/^"|"$/g, "") : undefined,
      metadata: input.metadata,
    };
  }

  async get(key: string): Promise<Uint8Array> {
    const url = this.objectUrl(key);
    let res: Response;
    try {
      res = await this.aws.fetch(url, { method: "GET" });
    } catch (err) {
      throw normalizeStorageError(err, "get");
    }
    if (res.status === 404) {
      throw normalizeStorageError(
        new Error(`object ${key} not found`),
        "get",
        404,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw normalizeStorageError(
        new Error(text || `GET ${key} failed`),
        "get",
        res.status,
      );
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  async delete(key: string): Promise<void> {
    const url = this.objectUrl(key);
    let res: Response;
    try {
      res = await this.aws.fetch(url, { method: "DELETE" });
    } catch (err) {
      throw normalizeStorageError(err, "delete");
    }
    // S3 DELETE is idempotent: 204 (deleted) and 404 (already gone) are
    // both success.
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw normalizeStorageError(
        new Error(text || `DELETE ${key} failed`),
        "delete",
        res.status,
      );
    }
  }

  async stat(key: string): Promise<StorageObject | undefined> {
    const url = this.objectUrl(key);
    let res: Response;
    try {
      res = await this.aws.fetch(url, { method: "HEAD" });
    } catch (err) {
      throw normalizeStorageError(err, "stat");
    }
    if (res.status === 404) return undefined;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw normalizeStorageError(
        new Error(text || `HEAD ${key} failed`),
        "stat",
        res.status,
      );
    }
    const len = res.headers.get("content-length");
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified");
    const metadata: Record<string, string> = {};
    for (const [hk, hv] of res.headers.entries()) {
      if (hk.startsWith("x-amz-meta-")) {
        metadata[hk.slice("x-amz-meta-".length)] = hv;
      }
    }
    return {
      key,
      size: len ? Number(len) : 0,
      contentType:
        res.headers.get("content-type") ?? "application/octet-stream",
      etag: etag ? etag.replace(/^"|"$/g, "") : undefined,
      lastModified: lastModified ? new Date(lastModified) : undefined,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    };
  }

  /** Create the configured bucket if it does not exist. Convenience for
   * tests/operators; not part of the ObjectStorage public contract but
   * isolated to /platform. */
  async ensureBucket(): Promise<void> {
    const url = this.forcePathStyle
      ? `${this.endpoint}/${this.bucket}`
      : `${this.endpoint}`;
    let res: Response;
    try {
      res = await this.aws.fetch(url, { method: "PUT" });
    } catch (err) {
      throw normalizeStorageError(err, "ensureBucket");
    }
    // 200 = created; 409 (BucketAlreadyOwnedByYou) = already exists.
    if (!res.ok && res.status !== 409) {
      const text = await res.text().catch(() => "");
      throw normalizeStorageError(
        new Error(text || "ensureBucket failed"),
        "ensureBucket",
        res.status,
      );
    }
  }
}
