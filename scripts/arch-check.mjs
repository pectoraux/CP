// scripts/arch-check.mjs
// Static architecture check (WORK-001 PLAT-AC-02).
//
// Enforces the frozen module-boundary invariants (architecture §35,
// architecture-lock §8):
//   (1) Every module exposes exactly ONE public interface entry point.
//       The only legal cross-module import form is the bare alias
//       `@cp/<module>`. Any deeper alias path is forbidden:
//         - `@cp/<module>/internal/foo`  -> no-cross-module-internal
//         - `@cp/<module>/foo`           -> no-cross-module-deep-import
//   (2) Cross-module relative imports are forbidden as an alternative
//       public surface. A relative import that resolves into another
//       module is rejected:
//         - `../../<module>/internal/foo.ts` -> no-cross-module-internal
//         - `../../<module>/foo.ts`          -> no-cross-module-relative
//   (3) `/platform` must not import any domain module (foundational layer).
//   (4) `/api` (transport layer) must not import module internals — it may
//       import only the bare public interface `@cp/<module>`.
//   (6) Infrastructure SDKs (pg, ioredis, redis, aws4fetch, @aws-sdk/*)
//       are isolated to /platform internals. Any other module importing
//       them -> infra-sdk-in-non-platform. Domain modules and the API
//       transport depend on the provider-neutral platform interfaces.
//
// At most one violation is emitted per specifier (most specific rule wins)
// so the failure surface stays legible and synthetic tests can assert exact
// counts.
//
// The same logic is exposed as `analyzeImports()` so tests can feed synthetic
// forbidden imports and assert detection without polluting the source tree.
//
// Run: `bun run arch:check`.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep, dirname, resolve, normalize } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

// Frozen modules per architecture §35 (27 modules, including /strategies),
// plus the /api transport layer and the /main process entry. The set is also
// derivable from the directory tree; listed explicitly to keep the check
// self-documenting.
const FROZEN_MODULES = [
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
const TRANSPORT_LAYERS = ["api", "main"];
// `platform` is the foundation; it may not import any other module
// (domain modules per lock §8, and the api transport by layering).
const PLATFORM = "platform";

// Infrastructure SDK packages that must NEVER leak outside /platform
// internals (architecture §2.3, §26, lock §8, §12). Domain modules and
// the API transport depend on the provider-neutral platform interfaces
// (Database / JobQueue / ObjectStorage / Cache / Lock), never on the
// concrete PostgreSQL/Redis/S3 clients. Only /platform may import these.
const INFRA_SDK_PACKAGES = [
  "pg",
  "ioredis",
  "redis",
  "aws4fetch",
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
];

// Provider SDK packages (architecture-lock §7: "Provider-specific SDKs
// are allowed only inside provider adapters. Domain modules must not
// import provider SDKs directly."). These may be imported ONLY from
// files under src/providers/internal/adapters/* — the adapter internals.
// None of these are currently dependencies (WORK-006 ships a deterministic
// fixture adapter with no external SDK); the rule is preventive so a
// future adapter SDK can never leak into domain modules or registry code.
const PROVIDER_SDK_PACKAGES = [
  "stripe",
  "openai",
  "@anthropic-ai/sdk",
  "twilio",
  "plaid",
  "@adyen/api-library",
  "paystack",
  "googleapis",
  "axios",
];

// Directional (one-way) module rules (WORK-006 §20):
//   - /capabilities must NOT import /providers: the capability layer is
//     UPSTREAM of providers (the capability graph is the semantic
//     foundation; provider-specific knowledge is downstream).
//   - /providers must NOT import /routing, /optimization, /experiments:
//     routing/execution/optimization belong to later work; the provider
//     layer stays subordinate to the capability contract and contains no
//     provider-selection logic.
// Both rules apply to the BARE alias form only — deep/internal/relative
// forms are already rejected by the generic cross-module rules, which
// take priority (at most one violation per specifier).
// WORK-010 (architect reviews #1 + #2 of PR #9): the credentials
// capability composition entry (src/credentials/composition.ts) is the
// ONLY constructor of the privileged credential capabilities
// (mutationAuthority / adapterResolver). It is NOT part of the module's
// public interface; it may be imported by EXACTLY ONE trusted file —
// the composition root — so no ordinary module can manufacture
// credential authority. This is the designated composition-root
// mechanism for the runtime object-capability secret boundary.
const CREDENTIALS_COMPOSITION_SUBPATHS = new Set([
  "composition",
  "composition.ts",
]);
const CREDENTIALS_COMPOSITION_ROOTS = new Set([
  "api/internal/server.ts",
]);

/** Is this file the trusted credentials composition root? */
function isCredentialsCompositionRoot(file) {
  const rel = relative(SRC, file).split(sep).join("/");
  return CREDENTIALS_COMPOSITION_ROOTS.has(rel);
}

/** Does this subpath under /credentials target the composition entry? */
function isCredentialsCompositionSubpath(subpath) {
  return (
    CREDENTIALS_COMPOSITION_SUBPATHS.has(subpath) ||
    subpath.startsWith("composition/")
  );
}

const DIRECTIONAL_FORBIDDEN = new Map([
  // WORK-008 §22/§25: /policies is tenant-scoped customer configuration
  // (hard constraints + preferences). It may import @cp/platform,
  // @cp/auth, @cp/capabilities, @cp/catalog public interfaces — but it
  // must NEVER import the downstream decision layers (eligibility/
  // routing/optimization/experimentation/execution/strategy) or any
  // premature module: the policy engine expresses the RULES; those
  // layers consume the evaluation results (WORK-009+).
  [
    "policies",
    new Set([
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
      "credentials",
      "resources",
      "providers",
      "webhooks",
      "events",
      "audit",
      "llm",
      "agents",
      "goals",
    ]),
  ],
  // WORK-009 §25: /eligibility is the deterministic candidate
  // evaluation layer. It consumes policies + catalog + capabilities +
  // providers PUBLIC interfaces but must NEVER import the downstream
  // decision layers (strategy/routing/execution/optimization/
  // experimentation) or any premature module — those layers CONSUME
  // eligibility results.
  [
    "eligibility",
    new Set([
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
      "credentials",
      "resources",
      "webhooks",
      "events",
      "audit",
      "llm",
      "agents",
      "goals",
    ]),
  ],
  // WORK-010 §30: /connections is the tenant-scoped connection layer —
  // downstream infrastructure for tenant access. It consumes the
  // providers/catalog/projects/auth/credentials public interfaces but
  // must NEVER import the downstream decision layers or premature
  // modules.
  [
    "connections",
    new Set([
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
    ]),
  ],
  // WORK-010 §26, §30-§31: /credentials is THE secret boundary — it may
  // import ONLY @cp/platform (+ node builtins). It must never depend on
  // any domain module: secret access policy stays isolated from domain
  // concerns, and no domain import can leak into secret handling.
  [
    "credentials",
    new Set([
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
    ]),
  ],
  // Upstream modules must not import /policies or /eligibility (no
  // cycles): capability semantics, provider identity, catalog facts,
  // and policy rules are upstream of candidate evaluation. WORK-010
  // extends this with /connections (tenant-scoped downstream
  // infrastructure) and /credentials (the secret boundary — policy,
  // catalog, eligibility, and capabilities never need secret access:
  // WORK-010 §38 final authority rule).
  [
    "capabilities",
    new Set([
      "providers",
      "catalog",
      "policies",
      "eligibility",
      "connections",
      "credentials",
    ]),
  ],
  [
    "providers",
    new Set([
      "routing",
      "optimization",
      "experiments",
      "catalog",
      "policies",
      "eligibility",
      "connections",
    ]),
  ],
  // WORK-007 §22: /catalog is the normalized marketplace PROJECTION — it
  // consumes capabilities + providers public interfaces and owns only
  // marketplace facts. It must never import the downstream decision
  // layers (policy/eligibility/plans/strategies/routing/execution/
  // optimization/experimentation) or the future observation/evidence/
  // connection/resource modules: the catalog stores normalized facts;
  // those layers consume them.
  [
    "catalog",
    new Set([
      "routing",
      "optimization",
      "experiments",
      "eligibility",
      "policies",
      "credentials",
      "plans",
      "strategies",
      "executions",
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
    ]),
  ],
]);

/**
 * Determine the module a source file belongs to. The module is the first
 * path segment under src/ (e.g. src/platform/internal/ids.ts → "platform";
 * src/main.ts → "main"). Robust to absolute and src/-relative paths.
 */
export function moduleOf(filePath) {
  const norm = filePath.replace(/\\/g, "/");
  const marker = "/src/";
  const idx = norm.indexOf(marker);
  let after;
  if (idx >= 0) {
    after = norm.slice(idx + marker.length);
  } else if (norm.startsWith("src/")) {
    after = norm.slice("src/".length);
  } else {
    after = norm;
  }
  const first = after.split("/")[0];
  return first.replace(/\.(ts|tsx|mjs)$/, "");
}

/**
 * Extract import/export/require/dynamic-import specifiers from source text.
 * Returns the set of specifiers found.
 */
export function extractSpecifiers(source) {
  const specifiers = new Set();
  // static import/export ... from 'x'
  const fromRe = /\bfrom\s*['"]([^'"]+)['"]/g;
  // dynamic import('x')
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // require('x')
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, dynRe, reqRe]) {
    let m;
    while ((m = re.exec(source)) !== null) {
      specifiers.add(m[1]);
    }
  }
  return specifiers;
}

/**
 * Classify a specifier relative to the importing file. Returns:
 *   { kind: "external" | "relative" | "alias", module?, subpath?, target? }
 */
export function classifySpecifier(specifier, importingFile) {
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".."
  ) {
    const target = normalize(join(dirname(importingFile), specifier));
    return { kind: "relative", target };
  }
  if (specifier.startsWith("@cp/")) {
    const rest = specifier.slice("@cp/".length);
    const segs = rest.split("/");
    const module = segs[0] || "";
    const subpath = segs.slice(1).join("/");
    return { kind: "alias", module, subpath, target: join(SRC, rest) };
  }
  return { kind: "external" };
}

/**
 * A single boundary violation.
 * @typedef {{ file: string, specifier: string, rule: string, message: string }} Violation
 */

/**
 * Classify a single import specifier into at most one boundary violation.
 * Returns null when the specifier is legal. Priority (most specific first):
 *   1. platform-no-domain-imports — /platform importing any other module
 *      (bare, deep, internal, or relative). Foundational layering.
 *   2. api-no-module-internals — /api importing a module's internal surface
 *      (alias deep-internal or relative into internal/).
 *   3. no-cross-module-internal — any cross-module import targeting another
 *      module's internal/ surface.
 *   4. no-cross-module-deep-import — cross-module alias import with a
 *      non-internal subpath (e.g. @cp/providers/foo). The only legal
 *      cross-module alias form is the bare `@cp/<module>`.
 *   5. no-cross-module-relative — cross-module relative import to a
 *      non-internal path (e.g. ../../providers/foo.ts). Relative imports may
 *      not be used as an alternative public surface.
 *
 * @param {{ kind: string, module?: string, subpath?: string, target?: string }} c
 * @param {string} importingModule
 * @param {string} file
 * @param {string} specifier
 * @returns {Violation | null}
 */
function classifyViolation(c, importingModule, file, specifier) {
  if (c.kind === "alias") {
    const targetModule = c.module || "";
    if (!targetModule) return null; // malformed @cp/ — not a module boundary concern
    const isCrossModule = targetModule !== importingModule;
    if (!isCrossModule) return null; // same-module alias is an internal concern
    const subpath = c.subpath || "";
    const isInternal =
      subpath === "internal" || subpath.startsWith("internal/");
    const hasSubpath = subpath.length > 0;

    // (1) /platform foundational layering — strongest rule.
    if (importingModule === PLATFORM) {
      return {
        file,
        specifier,
        rule: "platform-no-domain-imports",
        message: `/platform must not import module "${targetModule}" (${specifier})`,
      };
    }
    // (1.5) WORK-010 capability composition entry: importable ONLY by the
    // composition root. This rule takes priority over the generic
    // deep-import rule so the trusted file's import is legal while every
    // other importer (handlers, main, any domain module) is rejected.
    if (targetModule === "credentials" && isCredentialsCompositionSubpath(subpath)) {
      if (!isCredentialsCompositionRoot(file)) {
        return {
          file,
          specifier,
          rule: "credentials-composition-restricted",
          message:
            `the credentials capability composition entry (${specifier}) may be imported ONLY by the composition root (${[...CREDENTIALS_COMPOSITION_ROOTS].join(", ")}) — ordinary modules cannot manufacture credential authority`,
        };
      }
      return null; // the trusted composition root may import it.
    }
    // (2) /api must not import module internals.
    if (importingModule === "api" && isInternal) {
      return {
        file,
        specifier,
        rule: "api-no-module-internals",
        message: `/api must not import internal of module "${targetModule}" (${specifier})`,
      };
    }
    // (3) cross-module internal import (alias form).
    if (isInternal) {
      return {
        file,
        specifier,
        rule: "no-cross-module-internal",
        message: `module "${importingModule}" imports internal of module "${targetModule}" (${specifier})`,
      };
    }
    // (4) cross-module deep import — subpath under a non-internal public
    // surface. The only legal cross-module alias form is `@cp/<module>`.
    if (hasSubpath) {
      return {
        file,
        specifier,
        rule: "no-cross-module-deep-import",
        message: `module "${importingModule}" imports deep path of module "${targetModule}" (${specifier}); use @cp/${targetModule} instead`,
      };
    }
    // (5) directional one-way rules (WORK-006 §20) — apply to the BARE
    // alias form, which is otherwise the canonical legal import. Deep /
    // internal / relative forms were already rejected above by the more
    // specific generic rules (priority chain preserved).
    const forbiddenTargets = DIRECTIONAL_FORBIDDEN.get(importingModule);
    if (forbiddenTargets && forbiddenTargets.has(targetModule)) {
      return {
        file,
        specifier,
        rule: `${importingModule}-forbidden-import`,
        message: `module "${importingModule}" must not import module "${targetModule}" (one-way dependency rule; ${specifier})`,
      };
    }
    // bare @cp/<module> — the canonical legal cross-module form.
    return null;
  }

  if (c.kind === "relative" && c.target) {
    // Resolve into the src/ tree. Escapes outside src/ are not module
    // boundary concerns (e.g. importing node_modules via a relative path,
    // or test helpers).
    const relToSrc = relative(SRC, c.target);
    if (!relToSrc || relToSrc.startsWith("..")) {
      return null;
    }
    const segs = relToSrc.split(sep);
    const targetModule = segs[0] || "";
    if (!targetModule) return null;
    const isCrossModule = targetModule !== importingModule;
    if (!isCrossModule) return null; // same-module relative — allowed
    const sub = segs.slice(1).join("/");
    const isInternal = sub === "internal" || sub.startsWith("internal/");

    // (1) /platform foundational layering — strongest rule.
    if (importingModule === PLATFORM) {
      return {
        file,
        specifier,
        rule: "platform-no-domain-imports",
        message: `/platform must not import module "${targetModule}" (${specifier})`,
      };
    }
    // (1.5) credentials capability composition entry (relative form):
    // importable ONLY by the composition root.
    if (targetModule === "credentials" && isCredentialsCompositionSubpath(sub)) {
      if (!isCredentialsCompositionRoot(file)) {
        return {
          file,
          specifier,
          rule: "credentials-composition-restricted",
          message:
            `the credentials capability composition entry (reached via ${specifier}) may be imported ONLY by the composition root (${[...CREDENTIALS_COMPOSITION_ROOTS].join(", ")}) — ordinary modules cannot manufacture credential authority`,
        };
      }
      return null;
    }
    // (2) /api must not import module internals.
    if (importingModule === "api" && isInternal) {
      return {
        file,
        specifier,
        rule: "api-no-module-internals",
        message: `/api reaches internal of module "${targetModule}" via relative import (${specifier})`,
      };
    }
    // (3) cross-module internal import (relative form).
    if (isInternal) {
      return {
        file,
        specifier,
        rule: "no-cross-module-internal",
        message: `module "${importingModule}" reaches internal of module "${targetModule}" via relative import (${specifier})`,
      };
    }
    // (5) cross-module relative import to a non-internal path — relative
    // imports may not be used as an alternative public surface.
    return {
      file,
      specifier,
      rule: "no-cross-module-relative",
      message: `module "${importingModule}" imports module "${targetModule}" via relative path (${specifier}); use @cp/${targetModule} instead`,
    };
  }

  // (6) Infrastructure-SDK isolation (architecture §2.3, §26, lock §8,
  // §12). Only /platform may import the concrete PostgreSQL/Redis/S3
  // clients. Domain modules and the API transport depend on the
  // provider-neutral platform interfaces instead. External bare
  // specifiers reach here (alias/relative branches did not match).
  if (importingModule !== PLATFORM) {
    const pkg = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0] || "";
    if (INFRA_SDK_PACKAGES.includes(pkg)) {
      return {
        file,
        specifier,
        rule: "infra-sdk-in-non-platform",
        message: `module "${importingModule}" imports infrastructure SDK "${pkg}" directly; depend on @cp/platform interfaces instead (${specifier})`,
      };
    }
    // (7) Provider-SDK isolation (architecture-lock §7, WORK-006 §20):
    // provider SDKs are allowed ONLY inside provider adapter internals
    // (src/providers/internal/adapters/*). Domain modules must never
    // import them; /providers registry/contract code must not either —
    // only the adapter files may.
    if (PROVIDER_SDK_PACKAGES.includes(pkg)) {
      const inAdapterInternals =
        importingModule === "providers" &&
        file.replace(/\\/g, "/").includes("/providers/internal/adapters/");
      if (!inAdapterInternals) {
        return {
          file,
          specifier,
          rule: "provider-sdk-isolation",
          message:
            importingModule === "providers"
              ? `provider SDK "${pkg}" may only be imported inside src/providers/internal/adapters/* (${specifier})`
              : `module "${importingModule}" must not import provider SDK "${pkg}" directly; provider SDKs live only inside provider adapter internals (${specifier})`,
        };
      }
      return null;
    }
  }

  return null;
}

/**
 * Analyze a list of source files for boundary violations. Pure function —
 * takes {path, content} pairs and returns violations. Used both by the CLI
 * scan and by the architecture test suite.
 *
 * @param {{ path: string, content: string }[]} files
 * @returns {Violation[]}
 */
export function analyzeImports(files) {
  const violations = [];
  for (const { path: file, content } of files) {
    const importingModule = moduleOf(file);
    const specifiers = extractSpecifiers(content);
    for (const specifier of specifiers) {
      const c = classifySpecifier(specifier, file);
      const v = classifyViolation(c, importingModule, file, specifier);
      if (v) violations.push(v);
    }
  }
  return violations;
}

async function listSourceFiles(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await listSourceFiles(full, acc);
    } else if (e.isFile() && /\.(ts|tsx|mjs)$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

async function main() {
  const files = await listSourceFiles(SRC);
  const contents = [];
  for (const f of files) {
    const content = await readFile(f, "utf8");
    contents.push({ path: f, content });
  }
  const violations = analyzeImports(contents);
  if (violations.length === 0) {
    console.log(
      `arch-check: OK — ${files.length} source files, 0 boundary violations`,
    );
    return;
  }
  console.error(`arch-check: FAIL — ${violations.length} violation(s)`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${relative(ROOT, v.file)}: ${v.message}`);
  }
  process.exit(1);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("arch-check: error", err);
    process.exit(2);
  });
}
