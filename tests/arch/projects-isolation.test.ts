// tests/arch/projects-isolation.test.ts
// Architecture tests for WORK-004 (architecture §35, §36, §8, lock §8, §12,
// WORK-004 §architecture conformance). Proves:
//   - /projects cannot import /organizations internals (and does not import
//     /organizations at all — the one-way dependency /projects → @cp/auth +
//     @cp/platform only; the org context is resolved upstream in /api)
//   - /projects cannot import infra SDKs (pg/ioredis/aws4fetch)
//   - /api uses only the public interface of /projects (no @cp/projects/internal/*)
//   - moduleOf classifies projects/api paths correctly
//
// The first three are enforced by the existing arch-check rules; these
// tests assert the synthetic-detection and the real-source-tree cleanliness.
// The one-way "/projects does not import /organizations" invariant is NOT
// enforced by the bare arch-check (it would allow it), so this file adds
// that directional assertion explicitly — mirroring the WORK-003
// auth/org one-way test.
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

describe("projects boundary (synthetic detection)", () => {
  it("rejects /projects importing @cp/organizations/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("projects/internal/x.ts"),
        content: `import { OrganizationsService } from "@cp/organizations/internal/service";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("rejects /projects importing pg (infra-SDK isolation)", () => {
    const v = analyzeImports([
      {
        path: f("projects/internal/x.ts"),
        content: `import { Pool } from "pg";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects /projects importing ioredis (infra-SDK isolation)", () => {
    const v = analyzeImports([
      {
        path: f("projects/internal/x.ts"),
        content: `import IORedis from "ioredis";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects /projects importing aws4fetch (infra-SDK isolation)", () => {
    const v = analyzeImports([
      {
        path: f("projects/internal/x.ts"),
        content: `import { AwsClient } from "aws4fetch";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("infra-sdk-in-non-platform");
  });

  it("rejects /api importing @cp/projects/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { ProjectsService } from "@cp/projects/internal/service";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("api-no-module-internals");
  });

  it("allows /api importing the bare public interface of @cp/projects", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { ProjectsService } from "@cp/projects";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("allows /projects importing @cp/platform and @cp/auth (bare)", () => {
    const v = analyzeImports([
      {
        path: f("projects/internal/x.ts"),
        content: `import { type Database } from "@cp/platform";\nimport { type Principal } from "@cp/auth";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("moduleOf classifies projects/api paths correctly", () => {
    expect(moduleOf(f("projects/index.ts"))).toBe("projects");
    expect(moduleOf(f("projects/internal/service.ts"))).toBe("projects");
    expect(moduleOf(f("api/internal/handlers-projects.ts"))).toBe("api");
  });
});

describe("projects one-way dependency (real source tree)", () => {
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

  it("/projects source files contain NO @cp/organizations specifier (one-way dep)", async () => {
    const files = await listFiles(join(SRC, "projects"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const violations = analyzeImports([{ path: file, content }]);
      expect(violations, `violations in ${file}`).toEqual([]);
      const specs = extractSpecifiers(content);
      const orgSpec = [...specs].find(
        (s) => s === "@cp/organizations" || s.startsWith("@cp/organizations/"),
      );
      const rel = file.replace(SRC + "/", "");
      expect(
        orgSpec,
        `/projects file ${rel} must not import @cp/organizations (the org context is resolved upstream in /api; /projects → @cp/auth + @cp/platform only)`,
      ).toBeUndefined();
    }
  }, 60_000);

  it("/projects source files import @cp/platform + @cp/auth only via the bare alias", async () => {
    const files = await listFiles(join(SRC, "projects"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const violations = analyzeImports([{ path: file, content }]);
      expect(violations, `violations in ${file}`).toEqual([]);
      const specs = extractSpecifiers(content);
      for (const s of specs) {
        // @cp/auth/internal/* or @cp/platform/internal/* would already be a
        // violation; assert no non-bare @cp/auth or @cp/platform subpath.
        if (s.startsWith("@cp/auth/") && !s.startsWith("@cp/auth/internal")) {
          expect(false, `${file}: non-bare @cp/auth specifier "${s}" — use @cp/auth`).toBe(true);
        }
        if (s.startsWith("@cp/platform/") && !s.startsWith("@cp/platform/internal")) {
          expect(false, `${file}: non-bare @cp/platform specifier "${s}" — use @cp/platform`).toBe(true);
        }
      }
    }
  });

  it("/projects source files contain NO infra-SDK imports", async () => {
    const infra = ["pg", "ioredis", "redis", "aws4fetch", "@aws-sdk/client-s3"];
    const files = await listFiles(join(SRC, "projects"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const v = analyzeImports([{ path: file, content }]);
      expect(v, `violations in ${file}`).toEqual([]);
      for (const pkg of infra) {
        const specs = extractSpecifiers(content);
        const hit = [...specs].find((s) => s === pkg || s.startsWith(pkg + "/"));
        expect(hit, `/projects file ${file} must not import infra SDK "${pkg}"`).toBeUndefined();
      }
    }
  });
});
