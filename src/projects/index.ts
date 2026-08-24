// /projects — public interface.
//
// Responsibility (architecture §34, §36, §2.16, §23, lock §1, §8, §10,
// WORK-004):
//   - project identity (cp_projects table) under an organization
//   - project lifecycle: create / read / update / archive
//   - project-level tenant scoping (resolveProjectContext — the project
//     must belong to the authorized org; cross-org project id substitution
//     is rejected server-side)
//   - cursor pagination on the project list endpoint
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import ONLY
// from this file. Importing @cp/projects/internal/* from outside this
// module is a forbidden cross-module internal import (architecture-lock §8)
// and is rejected by the static architecture check.
//
// Dependency direction (WORK-004): /projects imports @cp/platform (Database,
// ids, logging, error model) and @cp/auth (Principal, Role,
// activeMembershipIn). /projects does NOT import /organizations — the org
// context is resolved upstream (in /api via /organizations.resolveOrgContext)
// and passed in as the authorized organization id. No infra SDK
// (pg/ioredis/aws4fetch) is imported here — only @cp/platform's
// provider-neutral Database interface.

// ---- ProjectsService (DB-backed) -------------------------------------
export { ProjectsService } from "./internal/service.ts";
export type {
  ProjectsServiceOptions,
  Project,
  ProjectContext,
  ProjectStatus,
  CreateProjectInput,
  UpdateProjectInput,
  ArchiveProjectInput,
  ListProjectsOptions,
  ProjectPage,
} from "./internal/service.ts";

// ---- Schema migration ------------------------------------------------
export { PROJ_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateProjectsSchema } from "./internal/schema-runner.ts";

// The MODULE_NAME / moduleStatus helpers from the WORK-001 placeholder are
// retained for backwards compatibility with any consumer that imported them
// (none in-tree, but the symbol is kept stable).
export const MODULE_NAME = "projects" as const;
