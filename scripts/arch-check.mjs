// scripts/arch-check.mjs
// Static architecture check (WORK-001 PLAT-AC-02).
//
// Enforces the frozen module-boundary invariants (architecture §35,
// architecture-lock §8):
//   (1) Cross-module imports into another module's `internal/` are forbidden.
//   (2) `/platform` must not import any domain module (foundational layer).
//   (3) `/api` (transport layer) must not import module internals — it may
//       import only public interfaces.
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

// Frozen modules per architecture §35, plus the /api transport layer and the
// /main process entry. The set is also derivable from the directory tree;
// listed explicitly to keep the check self-documenting.
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

      if (c.kind === "alias") {
        const { module: targetModule, subpath } = c;
        const isInternal =
          subpath &&
          (subpath === "internal" || subpath.startsWith("internal/"));
        const isCrossModule = targetModule !== importingModule;

        // Rule (1) / Rule (3): cross-module internal import. Emit the most
        // specific rule only (avoid double-counting for /api).
        if (isInternal && isCrossModule) {
          if (importingModule === "api") {
            violations.push({
              file,
              specifier,
              rule: "api-no-module-internals",
              message: `/api must not import internal of module "${targetModule}" (${specifier})`,
            });
          } else {
            violations.push({
              file,
              specifier,
              rule: "no-cross-module-internal",
              message: `module "${importingModule}" imports internal of module "${targetModule}" (${specifier})`,
            });
          }
        }
        // Rule (2): /platform must not import any other module.
        if (importingModule === PLATFORM && targetModule !== PLATFORM) {
          violations.push({
            file,
            specifier,
            rule: "platform-no-domain-imports",
            message: `/platform must not import module "${targetModule}" (${specifier})`,
          });
        }
      } else if (c.kind === "relative" && c.target) {
        // Resolve into src/ tree and check for cross-module internal reach.
        const relToSrc = relative(SRC, c.target);
        if (relToSrc && !relToSrc.startsWith("..") && !relToSrc.startsWith(".." + sep)) {
          const segs = relToSrc.split(sep);
          const targetModule = segs[0];
          const sub = segs.slice(1).join("/");
          if (
            targetModule &&
            sub &&
            (sub === "internal" || sub.startsWith("internal/")) &&
            targetModule !== importingModule
          ) {
            const rule =
              importingModule === "api"
                ? "api-no-module-internals"
                : "no-cross-module-internal";
            violations.push({
              file,
              specifier,
              rule,
              message: `module "${importingModule}" reaches internal of module "${targetModule}" via relative import (${specifier})`,
            });
          }
          // /platform foundational rule for relative imports too
          if (
            importingModule === PLATFORM &&
            targetModule &&
            targetModule !== PLATFORM
          ) {
            violations.push({
              file,
              specifier,
              rule: "platform-no-domain-imports",
              message: `/platform must not import module "${targetModule}" (${specifier})`,
            });
          }
        }
      }
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
