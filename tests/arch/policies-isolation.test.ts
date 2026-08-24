// tests/arch/policies-isolation.test.ts — WORK-008 architecture tests
// (architecture §10, §35, §36, lock §8, WORK-008 §25). Proves:
//   - /policies CANNOT import the downstream decision layers
//     (eligibility/routing/optimization/experiments/executions/plans/
//     strategies) nor premature modules (observations/outcomes/evidence/
//     connections/resources/providers/...)
//   - /policies CAN import its legal upstream modules (platform, auth,
//     capabilities, catalog — per WORK-008 §25)
//   - /capabilities, /providers, /catalog CANNOT import /policies (no
//     cycles: those layers are upstream of tenant policy configuration)
//   - /api uses only the public interface of @cp/policies
//   - the real /policies tree imports only legal modules
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

const DOWNSTREAM = [
  "eligibility",
  "routing",
  "optimization",
  "experiments",
  "executions",
  "plans",
  "strategies",
  "observations",
  "outcomes",
  "evidence",
  "connections",
  "resources",
  "providers",
  "webhooks",
  "events",
  "audit",
  "llm",
  "agents",
  "goals",
];

describe("policies boundary (synthetic detection)", () => {
  it("rejects /policies importing every downstream/premature module", () => {
    for (const mod of DOWNSTREAM) {
      const v = analyzeImports([
        {
          path: f("policies/internal/service.ts"),
          content: `import { X } from "@cp/${mod}";`,
        },
      ]);
      expect(v.length, `@cp/${mod} from /policies must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe("policies-forbidden-import");
      expect(v[0]!.message).toContain(`must not import module "${mod}"`);
    }
  });

  it("allows /policies importing its legal upstream modules (platform, auth, capabilities, catalog)", () => {
    const v = analyzeImports([
      {
        path: f("policies/internal/service.ts"),
        content: `import { AppError } from "@cp/platform";\nimport type { Principal } from "@cp/auth";\nimport type { CapabilitiesService } from "@cp/capabilities";\nimport type { CatalogService } from "@cp/catalog";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("rejects /capabilities, /providers, /catalog importing @cp/policies (no cycles)", () => {
    for (const mod of ["capabilities", "providers", "catalog"]) {
      const v = analyzeImports([
        {
          path: f(`${mod}/internal/x.ts`),
          content: `import { PoliciesService } from "@cp/policies";`,
        },
      ]);
      expect(v.length, `@cp/policies from /${mod} must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe(`${mod}-forbidden-import`);
      expect(v[0]!.message).toContain('must not import module "policies"');
    }
  });

  it("rejects /api importing @cp/policies/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/handlers-policies.ts"),
        content: `import { x } from "@cp/policies/internal/service.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("api-no-module-internals");
  });

  it("still rejects /policies deep/internal imports with the generic rules (priority preserved)", () => {
    const v = analyzeImports([
      {
        path: f("policies/internal/x.ts"),
        content: `import { X } from "@cp/capabilities/internal/service.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("moduleOf classifies policy paths correctly", () => {
    expect(moduleOf(f("policies/index.ts"))).toBe("policies");
    expect(moduleOf(f("policies/internal/service.ts"))).toBe("policies");
    expect(moduleOf(f("policies/internal/rules.ts"))).toBe("policies");
    expect(moduleOf(f("api/internal/handlers-policies.ts"))).toBe("api");
  });
});

describe("policies boundary (real source tree)", () => {
  it("the real /policies tree imports only legal modules (platform, auth; bare aliases only; no external packages)", async () => {
    const files = await listFiles(f("policies"));
    expect(files.length).toBeGreaterThan(0);
    const ALLOWED = new Set(["platform", "auth", "capabilities", "catalog"]);
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
            `${file} imports @cp/${mod} which is not in the WORK-008 policy dependency set {platform, auth, capabilities, catalog}`,
          ).toBe(true);
        } else if (!s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("bun")) {
          expect(
            false,
            `${file} imports external package "${s}" (the policy engine has no external dependencies)`,
          ).toBe(true);
        }
      }
    }
  });

  it("the real /capabilities, /providers, /catalog trees import nothing from @cp/policies", async () => {
    for (const mod of ["capabilities", "providers", "catalog"]) {
      const files = await listFiles(f(mod));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        const specifiers = [...content.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
        for (const s of specifiers) {
          expect(
            s === "@cp/policies" || s.startsWith("@cp/policies/"),
            `${file} must not import @cp/policies (${mod} is upstream of policy configuration)`,
          ).toBe(false);
        }
      }
    }
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
