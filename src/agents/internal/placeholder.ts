// /agents/internal/placeholder.ts
// Private implementation surface for /agents. Reserved for the concrete
// implementation delivered in later work items. Importing this file (or any
// other file under @cp/agents/internal/*) from outside /agents is a
// forbidden cross-module internal import and is rejected by the static
// architecture check (architecture-lock §8).

export const INTERNAL_MODULE = "agents" as const;

/** Marker kept until the module's real internals land. */
export interface ModuleInternal {
  readonly module: string;
}
