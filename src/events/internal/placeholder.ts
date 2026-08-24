// /events/internal/placeholder.ts
// Private implementation surface for /events. Reserved for the concrete
// implementation delivered in later work items. Importing this file (or any
// other file under @cp/events/internal/*) from outside /events is a
// forbidden cross-module internal import and is rejected by the static
// architecture check (architecture-lock §8).

export const INTERNAL_MODULE = "events" as const;

/** Marker kept until the module's real internals land. */
export interface ModuleInternal {
  readonly module: string;
}
