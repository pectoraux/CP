// /optimization/internal/placeholder.ts
// Private implementation surface for /optimization. Reserved for the concrete
// implementation delivered in later work items. Importing this file (or any
// other file under @cp/optimization/internal/*) from outside /optimization is a
// forbidden cross-module internal import and is rejected by the static
// architecture check (architecture-lock §8).

export const INTERNAL_MODULE = "optimization" as const;

/** Marker kept until the module's real internals land. */
export interface ModuleInternal {
  readonly module: string;
}
