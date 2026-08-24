// tests/arch/auth-org-isolation.test.ts
// Architecture tests for WORK-003 (architecture §35, §36, §8, lock §8, §12,
// WORK-003 §19). Proves:
//   - /auth and /organizations cannot import each other's internals
//   - /auth and /organizations cannot import infra SDKs (pg/ioredis/aws4fetch)
//   - /api uses only the public interfaces of /auth and /organizations
//   - the one-way dependency /organizations → /auth holds: /auth never
//     imports @cp/organizations (bare or otherwise)
// The first three are enforced by the existing arch-check rules; these
// tests assert the synthetic-detection and the real-source-tree cleanliness.
// The one-way dependency is a WORK-003 invariant NOT enforced by the bare
// arch-check (it allows bare cross-module imports in both directions), so
// this test file adds that directional assertion explicitly.
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

describe("auth/org boundary (synthetic detection)", () => {
  it("rejects /auth importing @cp/organizations/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("auth/internal/x.ts"),
        content: `import { thing } from "@cp/organizations/internal/service";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("rejects /organizations importing @cp/auth/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("organizations/internal/x.ts"),
        content: `import { hashPassword } from "@cp/auth/internal/password";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("rejects /auth importing pg (infra-SDK isolation)", () => {
    const v = analyzeImports([
      {
        path: f("auth/internal/x.ts"),
        content: `import { Pool } from "pg";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects /organizations importing ioredis (infra-SDK isolation)", () => {
    const v = analyzeImports([
      {
        path: f("organizations/internal/x.ts"),
        content: `import IORedis from "ioredis";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects /organizations importing aws4fetch", () => {
    const v = analyzeImports([
      {
        path: f("organizations/internal/x.ts"),
        content: `import { AwsClient } from "aws4fetch";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects /api importing @cp/auth/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { AuthService } from "@cp/auth/internal/service";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("api-no-module-internals");
  });

  it("rejects /api importing @cp/organizations/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { OrganizationsService } from "@cp/organizations/internal/service";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("api-no-module-internals");
  });

  it("allows /api importing the bare public interfaces", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { AuthService } from "@cp/auth";\nimport { OrganizationsService } from "@cp/organizations";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("allows /organizations importing @cp/auth (bare, the one-way dependency)", () => {
    const v = analyzeImports([
      {
        path: f("organizations/internal/x.ts"),
        content: `import { type Principal } from "@cp/auth";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("moduleOf classifies auth/org/api paths correctly", () => {
    expect(moduleOf(f("auth/index.ts"))).toBe("auth");
    expect(moduleOf(f("auth/internal/service.ts"))).toBe("auth");
    expect(moduleOf(f("organizations/index.ts"))).toBe("organizations");
    expect(moduleOf(f("organizations/internal/service.ts"))).toBe("organizations");
  });
});

describe("auth/org one-way dependency (real source tree)", () => {
  // Collect every source file under src/auth and src/organizations.
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

  it("/auth source files contain NO @cp/organizations specifier (one-way dep)", async () => {
    const files = await listFiles(join(SRC, "auth"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const violations = analyzeImports([{ path: file, content }]);
      expect(violations, `violations in ${file}`).toEqual([]);
      // Use extractSpecifiers (only real import/export/require specifiers,
      // not comments) to assert no @cp/organizations specifier exists.
      const specs = extractSpecifiers(content);
      const orgSpec = [...specs].find(
        (s) => s === "@cp/organizations" || s.startsWith("@cp/organizations/"),
      );
      const rel = file.replace(SRC + "/", "");
      expect(
        orgSpec,
        `/auth file ${rel} must not import @cp/organizations (one-way dep /organizations → /auth)`,
      ).toBeUndefined();
    }
  }, 60_000);

  it("/organizations source files import @cp/auth only via the bare alias", async () => {
    const files = await listFiles(join(SRC, "organizations"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const violations = analyzeImports([{ path: file, content }]);
      expect(violations, `violations in ${file}`).toEqual([]);
      // Any @cp/auth specifier must be the bare form (no /internal/...).
      const specs = extractSpecifiers(content);
      for (const s of specs) {
        if (s.startsWith("@cp/auth/") && !s.startsWith("@cp/auth/internal")) {
          // bare @cp/auth is fine; @cp/auth/internal/* would already be
          // a violation; any other @cp/auth/ subpath is a deep import.
          expect(
            false,
            `${file}: non-bare @cp/auth specifier "${s}" — use @cp/auth`,
          ).toBe(true);
        }
      }
    }
  });

  it("/auth + /organizations source files contain NO infra-SDK imports", async () => {
    const infra = ["pg", "ioredis", "redis", "aws4fetch", "@aws-sdk/client-s3"];
    const dirs = [join(SRC, "auth"), join(SRC, "organizations")];
    for (const dir of dirs) {
      const files = await listFiles(dir);
      for (const file of files) {
        const content = await readFile(file, "utf8");
        const v = analyzeImports([{ path: file, content }]);
        const infraV = v.filter((x) => x.rule === "infra-sdk-in-non-platform");
        expect(
          infraV,
          `infra-SDK leak in ${file}`,
        ).toEqual([]);
        // Belt and suspenders: string-level assertion for the SDK names.
        for (const sdk of infra) {
          const re = new RegExp(`['"]${sdk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`);
          expect(
            re.test(content),
            `${file} must not import infra SDK "${sdk}"`,
          ).toBe(false);
        }
      }
    }
  });
});
