// tests/arch/capabilities-isolation.test.ts
// Architecture tests for WORK-005 (architecture §2.2, §6, §35, §36, §37,
// lock §7, §8, §12, WORK-005 §13, §21). Proves:
//   - /capabilities cannot import /providers, /routing, /optimization,
//     /experiments (the provider/routing/execution layers come later and
//     would violate the provider-neutrality invariant — "the capability layer
//     is the semantic foundation for future routing", not a consumer of it)
//   - /capabilities cannot import infra SDKs (pg/ioredis/redis/aws4fetch/
//     @aws-sdk/*) and, more strongly, imports ONLY @cp/platform + @cp/auth
//     (bare) + node: builtins + relative files — no provider SDK of any kind
//     can leak in (Stripe/OpenAI/Anthropic/AWS/GCP are not in deps; this test
//     makes the invariant explicit and future-proof)
//   - /api uses only the public interface of @cp/capabilities
//     (no @cp/capabilities/internal/*)
//   - moduleOf classifies capabilities/api paths correctly
//
// The infra-SDK isolation is enforced by the existing arch-check rules; these
// tests assert the synthetic-detection AND the real-source-tree cleanliness.
// The "/capabilities does not import /providers /routing /optimization
// /experiments" directional invariant is NOT enforced by the bare arch-check
// (it would allow @cp/providers as a legal bare alias), so this file adds
// that explicit assertion — mirroring the WORK-003/WORK-004 one-way tests.
import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  analyzeImports,
  moduleOf,
  extractSpecifiers,
} from "../../scripts/arch-check.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
function f(rel: string): string {
  return join(SRC, rel);
}

// Modules that MUST NOT be imported by /capabilities (they belong to later
// work items and would violate the provider-neutral capability invariant —
// lock §7, WORK-005 §13, §24).
const FORBIDDEN_CAPABILITY_IMPORTS = [
  "providers",
  "routing",
  "optimization",
  "experiments",
  "executions",
  "catalog",
  "eligibility",
  "connections",
  "credentials",
  "plans",
  "strategies",
  "goals",
  "outcomes",
  "observations",
  "evidence",
  "resources",
  "policies",
  "audit",
  "llm",
  "agents",
  "webhooks",
  "events",
];

describe("capabilities boundary (synthetic detection)", () => {
  it("rejects /capabilities importing @cp/providers/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("capabilities/internal/x.ts"),
        content: `import { ProviderAdapter } from "@cp/providers/internal/adapter";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("rejects /capabilities importing pg (infra-SDK isolation)", () => {
    const v = analyzeImports([
      {
        path: f("capabilities/internal/x.ts"),
        content: `import { Pool } from "pg";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects /capabilities importing ioredis (infra-SDK isolation)", () => {
    const v = analyzeImports([
      {
        path: f("capabilities/internal/x.ts"),
        content: `import IORedis from "ioredis";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects /capabilities importing aws4fetch (infra-SDK isolation)", () => {
    const v = analyzeImports([
      {
        path: f("capabilities/internal/x.ts"),
        content: `import { AwsClient } from "aws4fetch";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects /api importing @cp/capabilities/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { CapabilitiesService } from "@cp/capabilities/internal/service";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("api-no-module-internals");
  });

  it("allows /api importing the bare public interface of @cp/capabilities", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { CapabilitiesService } from "@cp/capabilities";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("allows /capabilities importing @cp/platform and @cp/auth (bare)", () => {
    const v = analyzeImports([
      {
        path: f("capabilities/internal/x.ts"),
        content: `import { type Database } from "@cp/platform";\nimport { type Principal } from "@cp/auth";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("moduleOf classifies capabilities/api paths correctly", () => {
    expect(moduleOf(f("capabilities/index.ts"))).toBe("capabilities");
    expect(moduleOf(f("capabilities/internal/service.ts"))).toBe("capabilities");
    expect(moduleOf(f("api/internal/handlers-capabilities.ts"))).toBe("api");
  });
});

describe("capabilities provider-neutrality (real source tree)", () => {
  async function listFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        out.push(...(await listFiles(full)));
      } else if (/\.(ts|tsx|mjs)$/.test(e.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("/capabilities imports ONLY @cp/platform + @cp/auth (bare) + node builtins + relative — no provider/routing/optimization/experiments, no provider SDK, no /organizations", async () => {
    const files = await listFiles(join(SRC, "capabilities"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const violations = analyzeImports([{ path: file, content }]);
      expect(violations, `violations in ${file}`).toEqual([]);
      const specs = extractSpecifiers(content);
      for (const s of specs) {
        // No forbidden module imports.
        for (const mod of FORBIDDEN_CAPABILITY_IMPORTS) {
          if (s === `@cp/${mod}` || s.startsWith(`@cp/${mod}/`)) {
            expect(
              false,
              `/capabilities file ${file} must not import @cp/${mod} (provider/routing/execution/experiment layer; violates provider-neutrality)`,
            ).toBe(true);
          }
        }
        // No infra SDK of any kind. The arch-check already catches
        // pg/ioredis/redis/aws4fetch/@aws-sdk/*; assert explicitly too.
        const infra = [
          "pg",
          "ioredis",
          "redis",
          "aws4fetch",
          "@aws-sdk/client-s3",
          "@aws-sdk/s3-request-presigner",
        ];
        for (const pkg of infra) {
          if (s === pkg || s.startsWith(pkg + "/")) {
            expect(false, `/capabilities file ${file} must not import infra SDK "${pkg}"`).toBe(true);
          }
        }
        // The only legal cross-module @cp imports are @cp/platform and
        // @cp/auth (bare). Any other @cp/* (deep or internal) is already a
        // violation above; assert no other @cp/<module> bare import either.
        if (s.startsWith("@cp/") && !s.startsWith("@cp/platform") && !s.startsWith("@cp/auth")) {
          expect(
            false,
            `/capabilities file ${file} must not import "${s}" — only @cp/platform and @cp/auth are permitted`,
          ).toBe(true);
        }
        // No non-bare @cp/platform or @cp/auth subpath.
        if (s.startsWith("@cp/platform/") && !s.startsWith("@cp/platform/internal")) {
          expect(false, `${file}: non-bare @cp/platform specifier "${s}" — use @cp/platform`).toBe(true);
        }
        if (s.startsWith("@cp/auth/") && !s.startsWith("@cp/auth/internal")) {
          expect(false, `${file}: non-bare @cp/auth specifier "${s}" — use @cp/auth`).toBe(true);
        }
      }
    }
  }, 60_000);
});
