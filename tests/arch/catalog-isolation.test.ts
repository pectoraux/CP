// tests/arch/catalog-isolation.test.ts — WORK-007 architecture tests
// (architecture §9, §35, §36, lock §7, §8, WORK-007 §22, §24). Proves:
//   - /capabilities CANNOT import /catalog (bare alias rejected by the
//     new one-way rule) — the capability layer is upstream of the catalog
//   - /providers CANNOT import /catalog — provider identity is upstream
//     of the marketplace projection; no circular dependency
//   - /catalog CANNOT import the downstream decision layers
//     (routing/optimization/experiments/eligibility/policies/plans/
//     strategies/executions) nor the future observation/evidence/
//     connection/resource modules
//   - /catalog CAN import its legal upstream modules (platform, auth,
//     capabilities, providers)
//   - /api uses only the public interface of @cp/catalog
//   - the real /catalog tree imports only legal modules
//   - the whole source tree passes the extended checker programmatically
import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  analyzeImports,
  moduleOf,
} from "../../scripts/arch-check.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
function f(rel: string): string {
  return join(SRC, rel);
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".mjs"))) {
      out.push(p);
    }
  }
  return out;
}

describe("catalog boundary (synthetic detection)", () => {
  it("rejects /capabilities importing bare @cp/catalog (capabilities are upstream of the catalog)", () => {
    const v = analyzeImports([
      {
        path: f("capabilities/internal/x.ts"),
        content: `import { CatalogService } from "@cp/catalog";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("capabilities-forbidden-import");
    expect(v[0]!.message).toContain('must not import module "catalog"');
  });

  it("rejects /providers importing bare @cp/catalog (no circular provider→catalog dependency)", () => {
    const v = analyzeImports([
      {
        path: f("providers/internal/service.ts"),
        content: `import { CatalogService } from "@cp/catalog";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("providers-forbidden-import");
    expect(v[0]!.message).toContain('must not import module "catalog"');
  });

  it("rejects /catalog importing the downstream decision layers", () => {
    for (const mod of [
      "routing",
      "optimization",
      "experiments",
      "eligibility",
      "policies",
      "plans",
      "strategies",
      "executions",
      "observations",
      "evidence",
      "connections",
      "resources",
    ]) {
      const v = analyzeImports([
        {
          path: f("catalog/internal/service.ts"),
          content: `import { X } from "@cp/${mod}";`,
        },
      ]);
      expect(v.length, `@cp/${mod} from /catalog must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe("catalog-forbidden-import");
      expect(v[0]!.message).toContain(`must not import module "${mod}"`);
    }
  });

  it("allows /catalog importing its legal upstream modules (platform, auth, capabilities, providers)", () => {
    const v = analyzeImports([
      {
        path: f("catalog/internal/service.ts"),
        content: `import { AppError } from "@cp/platform";\nimport type { Principal } from "@cp/auth";\nimport type { CapabilitiesService } from "@cp/capabilities";\nimport type { ProvidersService } from "@cp/providers";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("rejects /api importing @cp/catalog/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/handlers-catalog.ts"),
        content: `import { x } from "@cp/catalog/internal/service.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("api-no-module-internals");
  });

  it("still rejects /catalog deep/internal imports with the generic rules (priority preserved)", () => {
    const v = analyzeImports([
      {
        path: f("catalog/internal/x.ts"),
        content: `import { X } from "@cp/providers/internal/service.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });
});

describe("catalog boundary (real source tree)", () => {
  it("the real /catalog tree imports only legal modules (platform, auth, capabilities, providers; bare aliases only)", async () => {
    const files = await listFiles(f("catalog"));
    expect(files.length).toBeGreaterThan(0);
    const ALLOWED = new Set(["platform", "auth", "capabilities", "providers"]);
    const PKG_RE = /^[a-zA-Z@][a-zA-Z0-9@/._-]*$/;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const specifiers = [...content.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1]!)
        .filter((s) => PKG_RE.test(s));
      for (const s of specifiers) {
        if (s.startsWith("@cp/")) {
          const mod = s.slice("@cp/".length).split("/")[0]!;
          expect(s === `@cp/${mod}`, `${file} must use the bare public alias @cp/${mod}`).toBe(true);
          expect(
            ALLOWED.has(mod),
            `${file} imports @cp/${mod} which is not in the WORK-007 catalog dependency set {platform, auth, capabilities, providers}`,
          ).toBe(true);
        } else if (!s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("bun")) {
          expect(
            false,
            `${file} imports external package "${s}" (the catalog has no external dependencies)`,
          ).toBe(true);
        }
      }
    }
  });

  it("the real /capabilities and /providers trees import nothing from @cp/catalog", async () => {
    for (const mod of ["capabilities", "providers"]) {
      const files = await listFiles(f(mod));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        const specifiers = [...content.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
        for (const s of specifiers) {
          expect(
            s === "@cp/catalog" || s.startsWith("@cp/catalog/"),
            `${file} must not import @cp/catalog (${mod} is upstream of the catalog)`,
          ).toBe(false);
        }
      }
    }
  });

  it("moduleOf classifies catalog paths correctly", () => {
    expect(moduleOf(f("catalog/index.ts"))).toBe("catalog");
    expect(moduleOf(f("catalog/internal/service.ts"))).toBe("catalog");
    expect(moduleOf(f("api/internal/handlers-catalog.ts"))).toBe("api");
  });

  it("the whole tree passes arch:check with the new rules (invoked programmatically)", async () => {
    const files = await listFiles(SRC);
    const inputs = await Promise.all(
      files.map(async (p) => ({ path: p, content: await readFile(p, "utf8") })),
    );
    const v = analyzeImports(inputs);
    expect(v).toEqual([]);
  });
});
