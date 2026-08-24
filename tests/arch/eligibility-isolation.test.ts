// tests/arch/eligibility-isolation.test.ts — WORK-009 architecture tests
// (architecture §10, §35, §36, lock §8, WORK-009 §25). Proves:
//   - /eligibility CANNOT import the downstream decision layers
//     (routing/optimization/experiments/executions/plans/strategies)
//     nor premature modules (observations/outcomes/evidence/connections/
//     resources/webhooks/events/audit/llm/agents/goals)
//   - /eligibility CAN import its legal upstream modules (platform,
//     auth, capabilities, catalog, policies — and providers public
//     interfaces where necessary, though the real tree needs none)
//   - /capabilities, /providers, /catalog, /policies CANNOT import
//     @cp/eligibility (no cycles — upstream modules never depend on the
//     evaluation layer)
//   - /api uses only the public interface of @cp/eligibility
//   - NO-EXECUTION proof (§28): the real /eligibility tree imports NO
//     provider-adapter surface at all — it cannot reach AdapterRegistry,
//     ProviderAdapter, or any adapter file, so evaluation provably
//     never invokes a provider adapter
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
  "webhooks",
  "events",
  "audit",
  "llm",
  "agents",
  "goals",
];

describe("eligibility boundary (synthetic detection)", () => {
  it("rejects /eligibility importing every downstream/premature module", () => {
    for (const mod of DOWNSTREAM) {
      const v = analyzeImports([
        {
          path: f("eligibility/internal/service.ts"),
          content: `import { X } from "@cp/${mod}";`,
        },
      ]);
      expect(v.length, `@cp/${mod} from /eligibility must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe("eligibility-forbidden-import");
      expect(v[0]!.message).toContain(`must not import module "${mod}"`);
    }
  });

  it("allows /eligibility importing its legal upstream modules (platform, auth, capabilities, catalog, policies, projects, providers)", () => {
    const v = analyzeImports([
      {
        path: f("eligibility/internal/service.ts"),
        content: `import { AppError } from "@cp/platform";\nimport type { Principal } from "@cp/auth";\nimport type { CapabilitiesService } from "@cp/capabilities";\nimport type { CatalogService } from "@cp/catalog";\nimport type { PoliciesService } from "@cp/policies";\nimport type { ProjectsService } from "@cp/projects";\nimport type { ProvidersService } from "@cp/providers";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("rejects upstream modules importing @cp/eligibility (no cycles)", () => {
    for (const mod of ["capabilities", "providers", "catalog", "policies"]) {
      const v = analyzeImports([
        {
          path: f(`${mod}/internal/x.ts`),
          content: `import { EligibilityService } from "@cp/eligibility";`,
        },
      ]);
      expect(v.length, `@cp/eligibility from /${mod} must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe(`${mod}-forbidden-import`);
      expect(v[0]!.message).toContain('must not import module "eligibility"');
    }
  });

  it("rejects /api importing @cp/eligibility/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/handlers-eligibility.ts"),
        content: `import { x } from "@cp/eligibility/internal/service.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("api-no-module-internals");
  });

  it("still rejects /eligibility deep/internal imports with the generic rules (priority preserved)", () => {
    const v = analyzeImports([
      {
        path: f("eligibility/internal/x.ts"),
        content: `import { X } from "@cp/catalog/internal/service.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("moduleOf classifies eligibility paths correctly", () => {
    expect(moduleOf(f("eligibility/index.ts"))).toBe("eligibility");
    expect(moduleOf(f("eligibility/internal/service.ts"))).toBe("eligibility");
    expect(moduleOf(f("eligibility/internal/evaluator.ts"))).toBe("eligibility");
    expect(moduleOf(f("api/internal/handlers-eligibility.ts"))).toBe("api");
  });
});

describe("eligibility boundary (real source tree)", () => {
  it("the real /eligibility tree imports only legal modules (platform, auth, capabilities, catalog, policies; bare aliases only; no external packages)", async () => {
    const files = await listFiles(f("eligibility"));
    expect(files.length).toBeGreaterThan(0);
    const ALLOWED = new Set(["platform", "auth", "capabilities", "catalog", "policies", "projects"]);
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
            `${file} imports @cp/${mod} which is not in the WORK-009 eligibility dependency set {platform, auth, capabilities, catalog, policies}`,
          ).toBe(true);
        } else if (!s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("bun")) {
          expect(
            false,
            `${file} imports external package "${s}" (the eligibility engine has no external dependencies)`,
          ).toBe(true);
        }
      }
    }
  });

  it("NO-EXECUTION proof: the real /eligibility tree has NO adapter surface — it cannot reach AdapterRegistry, ProviderAdapter, or any provider SDK", async () => {
    const files = await listFiles(f("eligibility"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content.includes("AdapterRegistry"), `${file} must not reference AdapterRegistry`).toBe(false);
      expect(content.includes("ProviderAdapter"), `${file} must not reference ProviderAdapter`).toBe(false);
      expect(content.includes("invoke("), `${file} must not invoke adapters`).toBe(false);
      for (const sdk of ["stripe", "openai", "twilio", "@anthropic-ai"]) {
        expect(content.includes(sdk), `${file} must not reference provider SDK "${sdk}"`).toBe(false);
      }
    }
    // And no import of @cp/providers at all in the real tree.
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const specifiers = [...content.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const s of specifiers) {
        expect(s === "@cp/providers" || s.startsWith("@cp/providers/"), `${file} must not import @cp/providers`).toBe(false);
      }
    }
  });

  it("NO RAW TABLE SQL: /eligibility contains no SQL against any table (projects public interface only — architect review of PR #8)", async () => {
    const files = await listFiles(f("eligibility"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      // Strip comments, then assert no table SQL remains: /eligibility is
      // a pure evaluation layer — it holds NO Database dependency at all
      // (the projects scope check goes through the public interface).
      const codeOnly = content
        .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
        .replace(/^\s*\/\/.*$/gm, ""); // line comments
      expect(codeOnly.includes("cp_projects"), `${file} must not reference the cp_projects table in code`).toBe(false);
      expect(/FROM\s+cp_/i.test(codeOnly), `${file} must not contain raw table SQL in code`).toBe(false);
      expect(/db\.query|db\.exec|this\.db/i.test(codeOnly), `${file} must not hold or use a Database handle`).toBe(false);
    }
  });

  it("the real upstream trees import nothing from @cp/eligibility", async () => {
    for (const mod of ["capabilities", "providers", "catalog", "policies"]) {
      const files = await listFiles(f(mod));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        const specifiers = [...content.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
        for (const s of specifiers) {
          expect(
            s === "@cp/eligibility" || s.startsWith("@cp/eligibility/"),
            `${file} must not import @cp/eligibility (${mod} is upstream of the evaluation layer)`,
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
