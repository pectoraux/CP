// /api/internal/handlers-projects.ts
// WORK-004 transport routes for /projects (architecture §23, §34, §36, §2.16,
// lock §9, §11). The API layer is a transport boundary only: it imports only
// the PUBLIC interfaces of @cp/projects (and @cp/organizations for the
// org-level gate, @cp/auth for the Principal, @cp/platform for the runtime),
// never any module's internals. Authorization happens at the domain service
// boundary (ProjectsService checks roles server-side via the acting
// Principal's org membership); the API handler never re-implements role
// logic (mirrors WORK-003 §8).
//
// Routes (all under /v1/organizations/:orgId, so the WORK-003
// orgContextMiddleware resolves the authorized org first):
//   POST   /v1/organizations/:orgId/projects              — create (idempotent)
//   GET    /v1/organizations/:orgId/projects               — list (paginated)
//   GET    /v1/organizations/:orgId/projects/:projectId   — get
//   PATCH  /v1/organizations/:orgId/projects/:projectId   — update (idempotent)
//   DELETE /v1/organizations/:orgId/projects/:projectId   — archive (idempotent)
//
// Project-level tenant scoping (WORK-004): the :projectId in a path is only
// a REQUESTED TARGET; the projectContextMiddleware verifies the project
// belongs to the AUTHORIZED org (resolved by orgContextMiddleware) and sets
// the authorized ProjectContext. A cross-org project id substitution is
// rejected (POLICY_BLOCKED / project.not_found) — the existence of a project
// in a different org is never leaked.

import { Hono } from "hono";
import { AppError, type Runtime } from "@cp/platform";
import type { OrganizationsService } from "@cp/organizations";
import { ProjectsService } from "@cp/projects";
import type { Project } from "@cp/projects";
import type { Principal } from "@cp/auth";
import {
  orgContextMiddleware,
  projectContextMiddleware,
  type AuthVars,
} from "./middleware.ts";
import { IdempotencyStore, withIdempotency } from "./idempotency.ts";

export interface ProjectRouteDeps {
  runtime: Runtime;
  orgs: OrganizationsService;
  projects: ProjectsService;
  idempotency: IdempotencyStore;
}

/**
 * Register the /v1/organizations/:orgId/projects[/:projectId] routes on the
 * given Hono app. The WORK-003 authMiddleware (registered in createAuthRoutes
 * on /v1/organizations/*) already verifies a presented credential and
 * populates a Principal; missing credentials are allowed (public surface).
 * Each route chains orgContextMiddleware (401 + org-level tenant gate) and,
 * where :projectId is present, projectContextMiddleware (project-level gate).
 */
export function createProjectRoutes(
  deps: ProjectRouteDeps,
  app: Hono<{ Variables: AuthVars }>,
): void {
  const { runtime, orgs, projects, idempotency } = deps;

  // ---- Create project (side-effecting → idempotency-supported) -------

  app.post(
    "/v1/organizations/:orgId/projects",
    orgContextMiddleware(runtime, orgs),
    async (c) => {
      const ctx = c.get("orgContext")!;
      return withIdempotency(c, idempotency, ctx.principal, async (body) => {
        const name = String(body?.name ?? "").trim();
        const slug = String(body?.slug ?? "").trim();
        if (!name || !slug) {
          return c.json(
            {
              error: {
                category: "POLICY_BLOCKED",
                code: "project.validation",
                message: "name and slug are required",
                retryable: false,
                request_id: c.get("requestId"),
              },
            },
            400,
          );
        }
        // createProject checks the acting principal is an active member of
        // this org (any role) and that the (org, slug) is unique. The
        // organization id used is the AUTHORIZED one (ctx.organizationId),
        // never the raw path param.
        const project = await projects.createProject({
          organizationId: ctx.organizationId,
          name,
          slug,
          createdByUserId: ctx.principal.userId,
          actingPrincipal: ctx.principal,
        });
        return c.json({ project: serializeProject(project) }, 201);
      });
    },
  );

  // ---- List projects (paginated) -------------------------------------

  app.get(
    "/v1/organizations/:orgId/projects",
    orgContextMiddleware(runtime, orgs),
    async (c) => {
      const ctx = c.get("orgContext")!;
      // Any active member may list projects in their org.
      const limitParam = Number(c.req.query("limit"));
      const cursor = c.req.query("cursor") ?? undefined;
      const includeArchived = c.req.query("include_archived") === "true";
      const page = await projects.listProjects(ctx.organizationId, {
        limit: Number.isFinite(limitParam) ? limitParam : undefined,
        cursor,
        includeArchived,
      });
      return c.json({
        projects: page.projects.map(serializeProject),
        page: page.page,
      });
    },
  );

  // ---- Get project (project-level gate) -----------------------------

  app.get(
    "/v1/organizations/:orgId/projects/:projectId",
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const pctx = c.get("projectContext")!;
      return c.json({ project: serializeProject(pctx.project) });
    },
  );

  // ---- Update project (side-effecting → idempotency-supported) -------

  app.patch(
    "/v1/organizations/:orgId/projects/:projectId",
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const ctx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, ctx.principal, async (body) => {
        const name =
          typeof body?.name === "string" ? body.name.trim() : undefined;
        const slug =
          typeof body?.slug === "string" ? body.slug.trim() : undefined;
        if (
          (name === undefined || name.length === 0) &&
          (slug === undefined || slug.length === 0)
        ) {
          return c.json(
            {
              error: {
                category: "POLICY_BLOCKED",
                code: "project.validation",
                message: "provide a name or slug to update",
                retryable: false,
                request_id: c.get("requestId"),
              },
            },
            400,
          );
        }
        // updateProject checks admin/owner role in this org. The project id
        // and org id used are the AUTHORIZED ones (pctx).
        const updated = await projects.updateProject({
          organizationId: pctx.organizationId,
          projectId: pctx.projectId,
          name,
          slug,
          actingPrincipal: ctx.principal,
        });
        return c.json({ project: serializeProject(updated) });
      });
    },
  );

  // ---- Archive project (side-effecting → idempotency-supported) ------

  app.delete(
    "/v1/organizations/:orgId/projects/:projectId",
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const ctx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, ctx.principal, async () => {
        // archiveProject checks owner role in this org. Idempotent on
        // already-archived projects (returns the archived record).
        const archived = await projects.archiveProject({
          organizationId: pctx.organizationId,
          projectId: pctx.projectId,
          actingPrincipal: ctx.principal,
        });
        return c.json({ project: serializeProject(archived) });
      });
    },
  );

  // Silence the unused-import warning for Principal (imported for type
  // clarity; the handler receives the principal via ctx.principal).
  void (null as unknown as Principal);
}

// ---- Serialization ---------------------------------------------------

function serializeProject(p: Project): Record<string, unknown> {
  return {
    id: p.id,
    organization_id: p.organizationId,
    name: p.name,
    slug: p.slug,
    status: p.status,
    created_by_user_id: p.createdByUserId,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}
