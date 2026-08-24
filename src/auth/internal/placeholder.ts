// /auth/internal/placeholder.ts
// Private implementation surface for /auth. Reserved for the concrete
// implementation delivered in later work items. Importing this file (or any
// other file under @cp/auth/internal/*) from outside /auth is a
// forbidden cross-module internal import and is rejected by the static
// architecture check (architecture-lock §8).

export const INTERNAL_MODULE = "auth" as const;

/** Marker kept until the module's real internals land. */
export interface ModuleInternal {
  readonly module: string;
}
