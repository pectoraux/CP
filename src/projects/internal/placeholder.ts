// /projects/internal/placeholder.ts
// Private implementation surface for /projects. Reserved for the concrete
// implementation delivered in later work items. Importing this file (or any
// other file under @cp/projects/internal/*) from outside /projects is a
// forbidden cross-module internal import and is rejected by the static
// architecture check (architecture-lock §8).

export const INTERNAL_MODULE = "projects" as const;

/** Marker kept until the module's real internals land. */
export interface ModuleInternal {
  readonly module: string;
}
