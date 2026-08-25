// tests/arch/goals-isolation.test.ts — WORK-011 architecture tests
// (architecture §35, §36, lock §8, WORK-011 §26-§27). Proves:
//   - /goals CANNOT import policies (a SEPARATE domain), providers,
//     catalog, eligibility, or any downstream module
//   - /outcomes CANNOT import goals or ANY domain module beyond
//     platform/auth/projects
//   - /goals CAN import its legal upstream modules (platform, auth,
//     projects, outcomes)
//   - /capabilities, /providers, /catalog, /policies, /eligibility
//     cannot import goals or outcomes (no cycles)
//   - /api uses only the public interfaces
//   - the real trees are clean; the whole tree passes programmatically
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

const GOALS_FORBIDDEN = [
  "policies",
  "providers",
  "catalog",
  "eligibility",
  "routing",
  "optimization",
  "experiments",
  "executions",
  "plans",
  "strategies",
  "observations",
  "evidence",
  "connections",
  "credentials",
  "resources",
  "webhooks",
  "events",
  "audit",
  "llm",
  "agents",
];

const OUTCOMES_FORBIDDEN = [
  "goals",
  "policies",
  "providers",
  "catalog",
  "eligibility",
  "routing",
  "optimization",
  "experiments",
  "executions",
  "plans",
  "strategies",
  "observations",
  "evidence",
  "connections",
  "credentials",
  "resources",
  "webhooks",
  "events",
  "audit",
  "llm",
  "agents",
];

describe("goals/outcomes boundaries (synthetic detection)", () => {
  it("rejects /goals importing every forbidden module (incl. policies — a separate domain)", () => {
    for (const mod of GOALS_FORBIDDEN) {
      const v = analyzeImports([
        { path: f("goals/internal/service.ts"), content: `import { X } from "@cp/${mod}";` },
      ]);
      expect(v.length, `@cp/${mod} from /goals must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe("goals-forbidden-import");
      expect(v[0]!.message).toContain(`must not import module "${mod}"`);
    }
  });

  it("rejects /outcomes importing goals or any forbidden module", () => {
    for (const mod of OUTCOMES_FORBIDDEN) {
      const v = analyzeImports([
        { path: f("outcomes/internal/service.ts"), content: `import { X } from "@cp/${mod}";` },
      ]);
      expect(v.length, `@cp/${mod} from /outcomes must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe("outcomes-forbidden-import");
      expect(v[0]!.message).toContain(`must not import module "${mod}"`);
    }
  });

  it("allows /goals importing its legal upstream modules (platform, auth, projects, outcomes)", () => {
    const v = analyzeImports([
      {
        path: f("goals/internal/service.ts"),
        content: `import { AppError } from "@cp/platform";\nimport type { Principal } from "@cp/auth";\nimport type { ProjectsService } from "@cp/projects";\nimport type { OutcomesService } from "@cp/outcomes";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("allows /outcomes importing its legal upstream modules (platform, auth, projects)", () => {
    const v = analyzeImports([
      {
        path: f("outcomes/internal/service.ts"),
        content: `import { AppError } from "@cp/platform";\nimport type { Principal } from "@cp/auth";\nimport type { ProjectsService } from "@cp/projects";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("rejects upstream modules importing @cp/goals and @cp/outcomes (no cycles)", () => {
    for (const mod of ["capabilities", "providers", "catalog", "policies", "eligibility"]) {
      for (const target of ["goals", "outcomes"]) {
        const v = analyzeImports([
          { path: f(`${mod}/internal/x.ts`), content: `import { X } from "@cp/${target}";` },
        ]);
        expect(v.length, `@cp/${target} from /${mod} must be rejected`).toBe(1);
        // The exact rule depends on the priority chain: some upstream
        // modules enforce goals/outcomes via their own directional rule;
        // others (catalog/policies/eligibility) via an existing
        // overlapping rule. What MUST hold: the import is REJECTED.
        expect(v[0]!.rule).toBeTruthy();
        expect(v[0]!.message).toContain(`${target}`);
      }
    }
  });

  it("rejects /api importing @cp/goals/internal/* or @cp/outcomes/internal/*", () => {
    for (const mod of ["goals", "outcomes"]) {
      const v = analyzeImports([
        { path: f("api/internal/handlers-goals.ts"), content: `import { x } from "@cp/${mod}/internal/service.ts";` },
      ]);
      expect(v.length).toBe(1);
      expect(v[0]!.rule).toBe("api-no-module-internals");
    }
  });

  it("moduleOf classifies the new module paths correctly", () => {
    expect(moduleOf(f("goals/index.ts"))).toBe("goals");
    expect(moduleOf(f("goals/internal/service.ts"))).toBe("goals");
    expect(moduleOf(f("outcomes/internal/service.ts"))).toBe("outcomes");
    expect(moduleOf(f("outcomes/internal/contract.ts"))).toBe("outcomes");
    expect(moduleOf(f("api/internal/handlers-goals.ts"))).toBe("api");
  });
});

describe("goals/outcomes boundaries (real source tree)", () => {
  it("the real /goals tree imports only legal modules (platform, auth, projects, outcomes)", async () => {
    const files = await listFiles(f("goals"));
    expect(files.length).toBeGreaterThan(0);
    const ALLOWED = new Set(["platform", "auth", "projects", "outcomes"]);
    const PKG_RE = /^[a-zA-Z@][a-zA-Z0-9@/._-]*$/;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const specifiers = [...content.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1]!)
        .filter((s) => PKG_RE.test(s));
      for (const s of specifiers) {
        if (s.startsWith("@cp/")) {
          const mod = s.slice("@cp/".length).split("/")[0]!;
          expect(s === `@cp/${mod}`, `${file} must use the bare public alias`).toBe(true);
          expect(
            ALLOWED.has(mod),
            `${file} imports @cp/${mod} which is not in the WORK-011 goals dependency set`,
          ).toBe(true);
        } else if (!s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("bun")) {
          expect(false, `${file} imports external package "${s}"`).toBe(true);
        }
      }
    }
  });

  it("the real /outcomes tree imports only legal modules (platform, auth, projects)", async () => {
    const files = await listFiles(f("outcomes"));
    expect(files.length).toBeGreaterThan(0);
    const ALLOWED = new Set(["platform", "auth", "projects"]);
    const PKG_RE = /^[a-zA-Z@][a-zA-Z0-9@/._-]*$/;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const specifiers = [...content.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1]!)
        .filter((s) => PKG_RE.test(s));
      for (const s of specifiers) {
        if (s.startsWith("@cp/")) {
          const mod = s.slice("@cp/".length).split("/")[0]!;
          expect(s === `@cp/${mod}`, `${file} must use the bare public alias`).toBe(true);
          expect(
            ALLOWED.has(mod),
            `${file} imports @cp/${mod} which is not in the WORK-011 outcomes dependency set`,
          ).toBe(true);
        } else if (!s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("bun")) {
          expect(false, `${file} imports external package "${s}"`).toBe(true);
        }
      }
    }
  });

  it("NO LIVE DEPENDENCIES (§30): the goals/outcomes trees reference no providers/adapters/executions/observations/optimization", async () => {
    for (const mod of ["goals", "outcomes"]) {
      const files = await listFiles(f(mod));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(content.includes("AdapterRegistry"), `${file} must not reference AdapterRegistry`).toBe(false);
        expect(content.includes("ProviderAdapter"), `${file} must not reference ProviderAdapter`).toBe(false);
        for (const sdk of ["stripe", "openai", "twilio"]) {
          expect(content.includes(sdk), `${file} must not reference provider SDK "${sdk}"`).toBe(false);
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
