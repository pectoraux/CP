// tests/arch/infra-isolation.test.ts — proves infrastructure SDKs (pg,
// ioredis, aws4fetch, @aws-sdk/*) are architecturally isolated to /platform
// internals. A domain module or the API transport importing any of them is
// rejected by the static checker (architecture §2.3, §26, lock §8, §12,
// WORK-002 §14).
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { analyzeImports } from "../../scripts/arch-check.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
function f(rel: string): string {
  return join(SRC, rel);
}

describe("infra-SDK isolation (rule infra-sdk-in-non-platform)", () => {
  it("rejects a domain module importing pg", () => {
    const v = analyzeImports([
      {
        path: f("executions/internal/x.ts"),
        content: `import { Pool } from "pg";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects a domain module importing ioredis", () => {
    const v = analyzeImports([
      {
        path: f("providers/internal/x.ts"),
        content: `import IORedis from "ioredis";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects the API transport importing aws4fetch", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { AwsClient } from "aws4fetch";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects a domain module importing @aws-sdk/client-s3", () => {
    const v = analyzeImports([
      {
        path: f("evidence/internal/x.ts"),
        content: `import { S3Client } from "@aws-sdk/client-s3";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("allows /platform to import infra SDKs (the only legal location)", () => {
    const v = analyzeImports([
      {
        path: f("platform/internal/db-postgres.ts"),
        content: `import pg from "pg";\nimport IORedis from "ioredis";\nimport { AwsClient } from "aws4fetch";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("does not reject unrelated external bare packages", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { Hono } from "hono";\nimport { AsyncLocalStorage } from "node:async_hooks";`,
      },
    ]);
    expect(v).toEqual([]);
  });
});
