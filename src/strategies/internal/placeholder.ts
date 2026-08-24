// /strategies/internal/placeholder.ts
// Private implementation surface for /strategies. Reserved for the concrete
// implementation delivered in later work items (WORK-012, WORK-021).
//
// Cross-module imports into this file (or any other file under
// @cp/strategies/internal/*) are forbidden. The only legal cross-module
// import form is the bare `@cp/strategies` entry point. Subpath alias
// imports (e.g. @cp/strategies/foo) and cross-module relative imports
// (e.g. ../../strategies/foo.ts) are likewise forbidden and are rejected
// by the static architecture check (architecture-lock §8).

export const INTERNAL_MODULE = "strategies" as const;

/** Marker kept until the module's real internals land. */
export interface ModuleInternal {
  readonly module: string;
}
