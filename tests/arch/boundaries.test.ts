// tests/arch/boundaries.test.ts — static architecture check (PLAT-AC-02).
// Feeds synthetic forbidden imports to analyzeImports to prove detection,
// and asserts the real source tree is clean.
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

// helper: build a synthetic source file path under SRC (absolute) so the
// checker's SRC-relative resolution behaves identically to the real scan.
function f(rel: string): string {
  return join(SRC, rel);
}

describe("static architecture check / moduleOf", () => {
  it("derives module from absolute src path", () => {
    expect(moduleOf(f("platform/internal/ids.ts"))).toBe("platform");
    expect(moduleOf(f("api/internal/server.ts"))).toBe("api");
    expect(moduleOf(f("main.ts"))).toBe("main");
  });

  it("flags cross-module internal import via @cp alias", () => {
    const v = analyzeImports([
      {
        path: f("executions/internal/x.ts"),
        content: `import { logger } from "@cp/platform/internal/logger";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("flags cross-module deep import via @cp alias (@cp/<module>/foo)", () => {
    const v = analyzeImports([
      {
        path: f("executions/internal/x.ts"),
        content: `import { something } from "@cp/providers/foo";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-deep-import");
  });

  it("flags cross-module deep import into internal (@cp/<module>/internal/foo)", () => {
    const v = analyzeImports([
      {
        path: f("executions/internal/x.ts"),
        content: `import { INTERNAL_MODULE } from "@cp/providers/internal/foo";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("flags cross-module internal import via relative path", () => {
    const v = analyzeImports([
      {
        path: f("executions/internal/x.ts"),
        content: `import { logger } from "../../platform/internal/logger.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("flags cross-module relative import into a non-internal public file (../../<module>/foo.ts)", () => {
    const v = analyzeImports([
      {
        path: f("executions/internal/x.ts"),
        content: `import { something } from "../../providers/foo.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-relative");
  });

  it("flags cross-module relative import into internal (../../<module>/internal/foo.ts)", () => {
    const v = analyzeImports([
      {
        path: f("executions/internal/x.ts"),
        content: `import { INTERNAL_MODULE } from "../../providers/internal/foo.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("allows the canonical bare @cp/<module> cross-module form", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { createLogger } from "@cp/platform";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("flags /platform importing a domain module (foundational layering)", () => {
    const v = analyzeImports([
      {
        path: f("platform/internal/x.ts"),
        content: `import { moduleStatus } from "@cp/auth";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("platform-no-domain-imports");
  });

  it("flags /api importing a module's internal", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { INTERNAL_MODULE } from "@cp/auth/internal/placeholder";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("api-no-module-internals");
  });

  it("allows /api importing a public module interface", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { createLogger } from "@cp/platform";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("allows same-module internal relative imports", () => {
    const v = analyzeImports([
      {
        path: f("platform/internal/x.ts"),
        content: `import { logger } from "./logger.ts";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("allows external bare specifiers (hono, node:)", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/x.ts"),
        content: `import { Hono } from "hono";\nimport { AsyncLocalStorage } from "node:async_hooks";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("extractSpecifiers picks up static, dynamic, and require forms", () => {
    const s = extractSpecifiers(
      `import { a } from "hono";\n` +
        `const x = await import("node:fs");\n` +
        `const y = require("hono/utils");\n` +
        `export { z } from "./local.ts";`,
    );
    expect(s.has("hono")).toBe(true);
    expect(s.has("node:fs")).toBe(true);
    expect(s.has("hono/utils")).toBe(true);
    expect(s.has("./local.ts")).toBe(true);
  });
});

describe("static architecture check / real source tree", () => {
  it("has zero boundary violations across all frozen modules (PLAT-AC-02)", async () => {
    const files: { path: string; content: string }[] = [];
    async function walk(dir: string): Promise<void> {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (/\.(ts|tsx|mjs)$/.test(e.name)) {
          files.push({
            path: full,
            content: await readFile(full, "utf8"),
          });
        }
      }
    }
    await walk(SRC);
    expect(files.length).toBeGreaterThan(20);
    const violations = analyzeImports(files);
    if (violations.length > 0) {
      console.error(violations);
    }
    expect(violations).toEqual([]);
  });

  it("all 27 frozen modules expose a public index.ts (PLAT-AC-01)", async () => {
    const frozen = [
      "platform",
      "auth",
      "organizations",
      "projects",
      "capabilities",
      "providers",
      "catalog",
      "policies",
      "eligibility",
      "goals",
      "plans",
      "strategies",
      "executions",
      "routing",
      "optimization",
      "experiments",
      "observations",
      "outcomes",
      "evidence",
      "resources",
      "connections",
      "credentials",
      "webhooks",
      "events",
      "audit",
      "llm",
      "agents",
    ];
    for (const m of frozen) {
      const idx = await readFile(join(SRC, m, "index.ts"), "utf8").catch(
        () => null,
      );
      expect(idx, `module ${m} must expose src/${m}/index.ts`).not.toBeNull();
    }
    expect(frozen.length).toBe(27);
  });

  it("/strategies exposes an internal placeholder (private surface exists)", async () => {
    const ph = await readFile(
      join(SRC, "strategies", "internal", "placeholder.ts"),
      "utf8",
    ).catch(() => null);
    expect(ph, "src/strategies/internal/placeholder.ts must exist").not.toBeNull();
  });

  it("/strategies is part of the frozen module inventory and enforced by the checker", () => {
    // Reading the checker's FROZEN_MODULES constant indirectly: a deep
    // cross-module alias into /strategies is rejected with the same rule
    // as every other frozen module, proving /strategies is a first-class
    // frozen module.
    const v = analyzeImports([
      {
        path: f("executions/internal/x.ts"),
        content: `import { thing } from "@cp/strategies/internal/placeholder";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });
});
