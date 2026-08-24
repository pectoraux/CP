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
