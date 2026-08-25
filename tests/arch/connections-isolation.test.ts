// tests/arch/connections-isolation.test.ts — WORK-010 architecture tests
// (architecture §35, §36, lock §7, §8, WORK-010 §30). Proves:
//   - /connections CANNOT import the downstream decision layers
//     (routing/optimization/experiments/executions/plans/strategies/...)
//   - /connections CAN import its legal upstream modules (platform, auth,
//     projects, providers, capabilities, credentials)
//   - /credentials CANNOT import ANY domain module (only @cp/platform —
//     the secret boundary is isolated from domain concerns)
//   - /capabilities, /providers, /catalog, /policies, /eligibility cannot
//     import @cp/connections (no cycles); capabilities/catalog/policies/
//     eligibility also cannot import @cp/credentials
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

const CONNECTIONS_FORBIDDEN = [
  "routing",
  "optimization",
  "experiments",
  "executions",
  "plans",
  "strategies",
  "observations",
  "outcomes",
  "evidence",
  "resources",
  "webhooks",
  "events",
  "audit",
  "llm",
  "agents",
  "goals",
];

const CREDENTIALS_FORBIDDEN = [
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
  "executions",
  "routing",
  "optimization",
  "experiments",
  "observations",
  "outcomes",
  "evidence",
  "resources",
  "connections",
  "webhooks",
  "events",
  "audit",
  "llm",
  "agents",
];

describe("connections/credentials boundaries (synthetic detection)", () => {
  it("rejects /connections importing every downstream module", () => {
    for (const mod of CONNECTIONS_FORBIDDEN) {
      const v = analyzeImports([
        {
          path: f("connections/internal/service.ts"),
          content: `import { X } from "@cp/${mod}";`,
        },
      ]);
      expect(v.length, `@cp/${mod} from /connections must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe("connections-forbidden-import");
      expect(v[0]!.message).toContain(`must not import module "${mod}"`);
    }
  });

  it("rejects /credentials importing ANY domain module (platform-only boundary)", () => {
    for (const mod of CREDENTIALS_FORBIDDEN) {
      const v = analyzeImports([
        {
          path: f("credentials/internal/service.ts"),
          content: `import { X } from "@cp/${mod}";`,
        },
      ]);
      expect(v.length, `@cp/${mod} from /credentials must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe("credentials-forbidden-import");
      expect(v[0]!.message).toContain(`must not import module "${mod}"`);
    }
    // @cp/platform itself remains legal.
    const ok = analyzeImports([
      {
        path: f("credentials/internal/service.ts"),
        content: `import { AppError } from "@cp/platform";`,
      },
    ]);
    expect(ok).toEqual([]);
  });

  it("allows /connections importing its legal upstream modules", () => {
    const v = analyzeImports([
      {
        path: f("connections/internal/service.ts"),
        content: `import { AppError } from "@cp/platform";\nimport type { Principal } from "@cp/auth";\nimport type { ProjectsService } from "@cp/projects";\nimport type { ProvidersService } from "@cp/providers";\nimport type { CapabilitiesService } from "@cp/capabilities";\nimport type { CredentialsService } from "@cp/credentials";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("rejects upstream modules importing @cp/connections and @cp/credentials", () => {
    for (const mod of ["capabilities", "providers", "catalog", "policies", "eligibility"]) {
      const v = analyzeImports([
        {
          path: f(`${mod}/internal/x.ts`),
          content: `import { ConnectionsService } from "@cp/connections";`,
        },
      ]);
      expect(v.length, `@cp/connections from /${mod} must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe(`${mod}-forbidden-import`);
      expect(v[0]!.message).toContain('must not import module "connections"');
    }
    for (const mod of ["capabilities", "catalog", "policies", "eligibility"]) {
      const v = analyzeImports([
        {
          path: f(`${mod}/internal/x.ts`),
          content: `import { CredentialsService } from "@cp/credentials";`,
        },
      ]);
      expect(v.length, `@cp/credentials from /${mod} must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe(`${mod}-forbidden-import`);
      expect(v[0]!.message).toContain('must not import module "credentials"');
    }
  });

  it("rejects /api importing @cp/connections/internal/* or @cp/credentials/internal/*", () => {
    for (const mod of ["connections", "credentials"]) {
      const v = analyzeImports([
        {
          path: f("api/internal/handlers-connections.ts"),
          content: `import { x } from "@cp/${mod}/internal/service.ts";`,
        },
      ]);
      expect(v.length).toBe(1);
      expect(v[0]!.rule).toBe("api-no-module-internals");
    }
  });

  it("rejects EVERY module except the composition root importing the credentials composition entry (alias form)", () => {
    const factoryImport = `import { createCredentialsBoundary } from "@cp/credentials/composition";`;
    for (const path of [
      "api/internal/handlers-connections.ts",
      "api/internal/middleware.ts",
      "api/internal/handlers-eligibility.ts",
      "main.ts",
      "connections/internal/service.ts",
      "providers/internal/service.ts",
      "catalog/internal/service.ts",
      "policies/internal/service.ts",
      "eligibility/internal/service.ts",
    ]) {
      const v = analyzeImports([{ path: f(path), content: factoryImport }]);
      expect(v.length, `${path} importing the composition entry must be rejected`).toBe(1);
      expect(v[0]!.rule).toBe("credentials-composition-restricted");
      expect(v[0]!.message).toContain("composition root");
    }
    // The .ts-suffixed alias form is rejected identically.
    const v2 = analyzeImports([
      {
        path: f("connections/internal/service.ts"),
        content: `import { createCredentialsBoundary } from "@cp/credentials/composition.ts";`,
      },
    ]);
    expect(v2.length).toBe(1);
    expect(v2[0]!.rule).toBe("credentials-composition-restricted");
    // /platform is doubly forbidden: its import fires the STRONGER
    // platform-no-domain-imports rule (priority chain) — defense in depth.
    const v3 = analyzeImports([
      { path: f("platform/internal/runtime.ts"), content: factoryImport },
    ]);
    expect(v3.length).toBe(1);
    expect(v3[0]!.rule).toBe("platform-no-domain-imports");
  });

  it("rejects the RELATIVE form into the composition entry from any non-root module", () => {
    const v = analyzeImports([
      {
        path: f("connections/internal/service.ts"),
        content: `import { createCredentialsBoundary } from "../../credentials/composition.ts";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("credentials-composition-restricted");
  });

  it("ALLOWS the composition root (src/api/internal/server.ts) — exactly one trusted place", () => {
    const v = analyzeImports([
      {
        path: f("api/internal/server.ts"),
        content: `import { createCredentialsBoundary } from "@cp/credentials/composition";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  it("moduleOf classifies the new module paths correctly", () => {
    expect(moduleOf(f("connections/index.ts"))).toBe("connections");
    expect(moduleOf(f("connections/internal/service.ts"))).toBe("connections");
    expect(moduleOf(f("credentials/internal/service.ts"))).toBe("credentials");
    expect(moduleOf(f("credentials/internal/crypto.ts"))).toBe("credentials");
  });
});

describe("connections/credentials boundaries (real source tree)", () => {
  it("the real /connections tree imports only legal modules (platform, auth, projects, providers, capabilities, credentials)", async () => {
    const files = await listFiles(f("connections"));
    expect(files.length).toBeGreaterThan(0);
    const ALLOWED = new Set(["platform", "auth", "projects", "providers", "capabilities", "credentials"]);
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
            `${file} imports @cp/${mod} which is not in the WORK-010 connections dependency set`,
          ).toBe(true);
        } else if (!s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("bun")) {
          expect(false, `${file} imports external package "${s}"`).toBe(true);
        }
      }
    }
  });

  it("the real /credentials tree imports ONLY @cp/platform + node builtins (isolated secret boundary)", async () => {
    const files = await listFiles(f("credentials"));
    expect(files.length).toBeGreaterThan(0);
    const PKG_RE = /^[a-zA-Z@][a-zA-Z0-9@/._-]*$/;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const specifiers = [...content.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1]!)
        .filter((s) => PKG_RE.test(s));
      for (const s of specifiers) {
        if (s.startsWith("@cp/")) {
          expect(s === "@cp/platform", `${file} may import ONLY @cp/platform (got ${s})`).toBe(true);
        } else if (!s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("bun")) {
          expect(false, `${file} imports external package "${s}"`).toBe(true);
        }
      }
    }
  });

  it("NO-SECRET-IN-CODE: /connections source never handles secret values (only opaque references)", async () => {
    const files = await listFiles(f("connections"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content.includes("secret_value"), `${file} must not reference secret_value`).toBe(false);
      expect(content.includes("encryptSecret"), `${file} must not encrypt/decrypt secrets`).toBe(false);
      expect(content.includes("decryptSecret"), `${file} must not encrypt/decrypt secrets`).toBe(false);
    }
  });

  it("NO MINT PATH: the real /credentials CODE contains no grant-minting method (comments documenting the fix are stripped)", async () => {
    const files = await listFiles(f("credentials"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      // Strip comments: the fix is DOCUMENTED in comments (the flawed
      // design is described so it is not reintroduced) — the assertion
      // targets executable code.
      const codeOnly = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(codeOnly.includes("issueAdapterGrant"), `${file} must not contain a grant-minting method in code`).toBe(false);
      expect(codeOnly.includes("AdapterCredentialGrant"), `${file} must not contain the flawed grant type in code`).toBe(false);
    }
  });

  it("NO RESOLVER REACHABLE FROM HANDLERS: api route handlers never reference the resolver or the boundary factory (composition root only)", async () => {
    // The composition root (server.ts) is the ONLY place the boundary is
    // constructed and the ONLY holder of the adapter resolver reference.
    const handlerFiles = (await listFiles(f("api"))).filter(
      (p) => p.includes("handlers") || p.includes("middleware") || p.includes("idempotency"),
    );
    expect(handlerFiles.length).toBeGreaterThan(0);
    for (const file of handlerFiles) {
      const content = await readFile(file, "utf8");
      expect(content.includes("createCredentialsBoundary"), `${file} must not construct the credentials boundary`).toBe(false);
      expect(content.includes("adapterResolver"), `${file} must not reference the adapter resolver capability`).toBe(false);
      expect(content.includes("adapterCredentialResolver"), `${file} must not reference the adapter resolver capability`).toBe(false);
      expect(content.includes("mutationAuthority"), `${file} must not reference the mutation capability`).toBe(false);
    }
    // And server.ts — the composition root — does NOT leak the resolver
    // onto the returned Api object (grep the return statement's fields).
    const server = await readFile(f("api/internal/server.ts"), "utf8");
    expect(server.includes("adapterResolver:")).toBe(false);
    expect(server.includes("adapterCredentialResolver:")).toBe(false);
    expect(server.includes("credentialsBoundary:")).toBe(false);
  });

  it("PUBLIC INTERFACE HAS NO FACTORY: index.ts does not export the capability constructor (comments stripped)", async () => {
    const idx = await readFile(f("credentials/index.ts"), "utf8");
    const codeOnly = idx
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(codeOnly.includes("createCredentialsBoundary")).toBe(false);
    // And the module namespace-level check lives in
    // tests/credentials/service.test.ts (runtime proof).
  });

  it("ONLY THE COMPOSITION ROOT references the composition entry in the real tree (import specifiers, not comments)", async () => {
    const files = await listFiles(SRC);
    const importRe = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const specifiers = [...content.matchAll(importRe)].map((m) => m[1]!);
      for (const s of specifiers) {
        const hits =
          s === "@cp/credentials/composition" ||
          s === "@cp/credentials/composition.ts" ||
          /(^|\/\.)\.?\.?\/credentials\/composition(\.ts)?$/.test(s);
        if (!hits) continue;
        const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
        expect(
          rel,
          `only the composition root may import the credentials composition entry (found in ${rel})`,
        ).toBe("api/internal/server.ts");
      }
    }
  });

  it("the composition root ACTUALLY imports the composition entry (the trusted wiring exists)", async () => {
    const server = await readFile(f("api/internal/server.ts"), "utf8");
    expect(server.includes("@cp/credentials/composition")).toBe(true);
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
