// tests/arch/providers-isolation.test.ts — WORK-006 architecture tests
// (architecture §2.10, §35, §36, lock §7, §8, WORK-006 §20, §24). Proves:
//   - /capabilities CANNOT import /providers (any form): the capability
//     layer is UPSTREAM of providers. The bare `@cp/providers` alias is
//     rejected by the NEW one-way rule `capabilities-forbidden-import`;
//     deep/internal/relative forms are rejected by the generic rules.
//   - /providers CANNOT import /routing, /optimization, /experiments
//     (bare alias rejected by `providers-forbidden-import`): no routing /
//     ranking / optimization / experimentation in WORK-006.
//   - provider SDK imports are confined to provider ADAPTER internals
//     (src/providers/internal/adapters/*): rejected in domain modules and
//     in /providers registry/contract code (`provider-sdk-isolation`),
//     allowed inside adapter files.
//   - /api uses only the public interface of @cp/providers.
//   - /providers real source tree imports only @cp/platform,
//     @cp/capabilities, @cp/credentials, @cp/auth (bare) + node builtins
//     + relative files — and never routing/optimization/experiments.
//   - the demo.echo adapter file (adapter internals) contains no provider
//     SDK import (the fixture is self-contained by design).
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

describe("providers boundary (synthetic detection)", () => {
  it("rejects /capabilities importing bare @cp/providers (one-way: capabilities are upstream)", () => {
    const v = analyzeImports([
      {
        path: f("capabilities/internal/x.ts"),
        content: `import { ProvidersService } from "@cp/providers";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("capabilities-forbidden-import");
    expect(v[0]!.message).toContain("must not import module \"providers\"");
  });

  it("still rejects /capabilities importing @cp/providers/internal/* with the generic rule (priority preserved)", () => {
    const v = analyzeImports([
      {
        path: f("capabilities/internal/x.ts"),
        content: `import { AdapterRegistry } from "@cp/providers/internal/adapter.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("no-cross-module-internal");
  });

  it("rejects /providers importing bare @cp/routing, @cp/optimization, @cp/experiments", () => {
    for (const mod of ["routing", "optimization", "experiments"]) {
      const v = analyzeImports([
        {
          path: f("providers/internal/x.ts"),
          content: `import { Router } from "@cp/${mod}";`,
        },
      ]);
      expect(v.length, `@cp/${mod} from /providers must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe("providers-forbidden-import");
      expect(v[0]!.message).toContain(`must not import module "${mod}"`);
    }
  });

  it("rejects a provider SDK imported from a domain module (lock §7: only inside provider adapters)", () => {
    const v = analyzeImports([
      {
        path: f("capabilities/internal/x.ts"),
        content: `import Stripe from "stripe";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("provider-sdk-isolation");
    expect(v[0]!.message).toContain("provider SDK \"stripe\"");
  });

  it("rejects a provider SDK imported from /providers REGISTRY code (not adapter internals)", () => {
    const v = analyzeImports([
      {
        path: f("providers/internal/service.ts"),
        content: `import Stripe from "stripe";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("provider-sdk-isolation");
    expect(v[0]!.message).toContain("may only be imported inside src/providers/internal/adapters/*");
  });

  it("rejects a provider SDK imported from /api (transport layer)", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/handlers-providers.ts"),
        content: `import OpenAI from "openai";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("provider-sdk-isolation");
  });

  it("ALLOWS a provider SDK inside provider adapter internals (src/providers/internal/adapters/*)", () => {
    const v = analyzeImports([
      {
        path: f("providers/internal/adapters/stripe-adapter.ts"),
        content: `import Stripe from "stripe";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("rejects /api importing @cp/providers/internal/*", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/handlers-providers.ts"),
        content: `import { something } from "@cp/providers/internal/service.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("api-no-module-internals");
  });

  it("allows /providers importing its legal upstream modules (capabilities, credentials, platform, auth)", () => {
    const v = analyzeImports([
      {
        path: f("providers/internal/service.ts"),
        content: `import { CapabilitiesService } from "@cp/capabilities";\nimport { CredentialRequirement } from "@cp/credentials";\nimport { AppError } from "@cp/platform";\nimport type { Principal } from "@cp/auth";`,
      },
    ]);
    expect(v).toEqual([]);
  });
});

describe("providers boundary (real source tree)", () => {
  it("the real /capabilities tree imports nothing from /providers", async () => {
    const files = await listFiles(f("capabilities"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const specifiers = [...content.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const s of specifiers) {
        expect(
          s === "@cp/providers" || s.startsWith("@cp/providers/"),
          `${file} must not import @cp/providers (capabilities are upstream of providers)`,
        ).toBe(false);
      }
    }
  });

  it("the real /providers tree imports only legal modules (platform, auth, capabilities, credentials; never routing/optimization/experiments; no provider SDKs outside adapters)", async () => {
    const files = await listFiles(f("providers"));
    expect(files.length).toBeGreaterThan(0);
    const ALLOWED_ALIASES = new Set(["platform", "auth", "capabilities", "credentials"]);
    const FORBIDDEN = new Set(["routing", "optimization", "experiments"]);
    // Only specifiers that look like real package names / aliases —
    // template-literal false positives (e.g. `from "${x}"` inside a
    // message string) contain ${...} and are excluded.
    const PKG_RE = /^[a-zA-Z@][a-zA-Z0-9@/._-]*$/;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const specifiers = [...content.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1]!)
        .filter((s) => PKG_RE.test(s));
      const isAdapterInternal = file.replace(/\\/g, "/").includes("/providers/internal/adapters/");
      for (const s of specifiers) {
        if (s.startsWith("@cp/")) {
          const mod = s.slice("@cp/".length).split("/")[0]!;
          expect(
            s === `@cp/${mod}`,
            `${file} must use the bare public alias @cp/${mod}`,
          ).toBe(true);
          expect(
            FORBIDDEN.has(mod),
            `${file} must not import @cp/${mod} (routing/execution/optimization are out of WORK-006 scope)`,
          ).toBe(false);
          if (!isAdapterInternal) {
            expect(
              ALLOWED_ALIASES.has(mod),
              `${file} imports @cp/${mod} which is not in the WORK-006 provider dependency set {platform, auth, capabilities, credentials}`,
            ).toBe(true);
          }
        } else if (!s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("bun")) {
          // External package: only allowed inside adapter internals
          // (currently none — the fixture is self-contained).
          expect(
            isAdapterInternal,
            `${file} imports external package "${s}" outside adapter internals`,
          ).toBe(true);
        }
      }
    }
  });

  it("the demo.echo adapter (adapter internals) contains NO provider SDK import (self-contained fixture)", async () => {
    const content = await readFile(f("providers/internal/adapters/demo-echo-adapter.ts"), "utf8");
    const specifiers = [...content.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const s of specifiers) {
      expect(s.startsWith(".") || s.startsWith("@cp/") || s.startsWith("node:")).toBe(true);
    }
  });

  it("moduleOf classifies provider paths correctly", () => {
    expect(moduleOf(f("providers/index.ts"))).toBe("providers");
    expect(moduleOf(f("providers/internal/service.ts"))).toBe("providers");
    expect(moduleOf(f("providers/internal/adapters/demo-echo-adapter.ts"))).toBe("providers");
    expect(moduleOf(f("api/internal/handlers-providers.ts"))).toBe("api");
    expect(moduleOf(f("credentials/index.ts"))).toBe("credentials");
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
