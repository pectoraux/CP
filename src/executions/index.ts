// /executions — public interface.
//
// Responsibility (architecture §36): live execution lifecycle and execution records.
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import ONLY
// from this file. Importing @cp/executions/internal/* from outside this
// module is a forbidden cross-module internal import (architecture-lock §8).
//
// Concrete behavior is delivered across later work items; WORK-001
// establishes the boundary and a minimal, typed public surface so the
// static architecture check can enforce it.

export const MODULE_NAME = "executions" as const;

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
