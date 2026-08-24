// /executions/internal/placeholder.ts
// Private implementation surface for /executions. Reserved for the concrete
// implementation delivered in later work items. Importing this file (or any
// other file under @cp/executions/internal/*) from outside /executions is a
// forbidden cross-module internal import and is rejected by the static
// architecture check (architecture-lock §8).

export const INTERNAL_MODULE = "executions" as const;

/** Marker kept until the module's real internals land. */
export interface ModuleInternal {
  readonly module: string;
}
