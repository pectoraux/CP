// /strategies — public interface.
//
// Responsibility (architecture §36): strategy identity, immutable strategy
// versions, and the active production strategy reference for a goal/plan.
// Strategy content is owned here; promotion and rollback are owned by
// /experiments (architecture-lock §3, §4, dependency-graph §4).
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import ONLY
// from this file. The only legal cross-module import form is the bare
// `@cp/strategies` entry point. Any subpath import —
//   @cp/strategies/foo
//   @cp/strategies/internal/foo
// — is a forbidden cross-module import (architecture-lock §8) and is
// rejected by the static architecture check.
//
// Concrete behavior is delivered across later work items (WORK-012, WORK-021);
// WORK-001 establishes the boundary and a minimal, typed public surface so
// the static architecture check can enforce it.

export const MODULE_NAME = "strategies" as const;

export interface ModuleStatus {
  name: string;
  ready: boolean;
  implementedIn: string | null;
}

export function moduleStatus(): ModuleStatus {
  return {
    name: MODULE_NAME,
    ready: false,
    implementedIn: null,
  };
}
