// /api/internal/handlers-auth.ts
// WORK-003 transport routes for /auth and /organizations (architecture
// §35, §36, §2.16, WORK-003 §4, §5, §11). The API layer is a transport
// boundary only: it imports only the PUBLIC interfaces of @cp/auth and
// @cp/organizations, never their internals. Authorization happens at the
// domain service boundary (the OrganizationsService checks permissions
// server-side); the API handler never re-implements role logic (WORK-003 §8).
//
// Routes:
//   Public:   POST /v1/auth/register, POST /v1/auth/sessions
//   Authed:   GET /v1/auth/me, POST/GET/DELETE /v1/auth/api-keys[/:id],
//             POST /v1/auth/logout
//   Tenant:   POST /v1/organizations, GET /v1/organizations,
//             GET /v1/organizations/:orgId,
//             GET /v1/organizations/:orgId/memberships,
//             POST /v1/organizations/:orgId/memberships,
//             PATCH /v1/organizations/:orgId/memberships/:userId,
//             DELETE /v1/organizations/:orgId/memberships/:userId

import { Hono } from "hono";
import { AppError, type Runtime } from "@cp/platform";
import { AuthService, parseApiKeyId } from "@cp/auth";
import type { Principal } from "@cp/auth";
import {
  OrganizationsService,
  ORG_PERMISSIONS,
} from "@cp/organizations";
import type { Role, MembershipStatus } from "@cp/auth";
import {
  authMiddleware,
  orgContextMiddleware,
  requirePrincipal,
  type AuthVars,
} from "./middleware.ts";

// Default session-token lifetime (POST /v1/auth/sessions). 12 hours —
// short enough to bound replay risk, long enough to be usable.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AuthRouteDeps {
  runtime: Runtime;
  auth: AuthService;
  orgs: OrganizationsService;
}

/**
 * Register the /v1/auth + /v1/organizations routes directly on the given
 * Hono app (rather than returning a sub-app). This keeps the main app's
 * errorMiddleware + correlationMiddleware + authMiddleware in the SAME
 * execution chain as the route handlers, so errors thrown by
 * orgContextMiddleware or the service propagate up to errorMiddleware and
 * become structured JSON responses (not Hono's default 500).
 *
 * The auth middleware runs on every sub-route so a presented credential is
 * verified and a Principal is populated; missing credentials are allowed
 * (public routes work without one).
 */
export function createAuthRoutes(
  deps: AuthRouteDeps,
  app: Hono<{ Variables: AuthVars }>,
): void {
  const { runtime, auth, orgs } = deps;
  // Verify credential IF present on every auth/org route.
  app.use("/v1/auth/*", authMiddleware(runtime, auth, orgs));
  app.use("/v1/organizations/*", authMiddleware(runtime, auth, orgs));
  app.use("/v1/organizations", authMiddleware(runtime, auth, orgs));

  // ---- Public auth routes --------------------------------------------

  app.post("/v1/auth/register", async (c) => {
    const body = await readJsonBody(c);
    const email = String(body?.email ?? "");
    const password = String(body?.password ?? "");
    if (!email || !password) {
      return c.json(
        {
          error: {
            category: "POLICY_BLOCKED",
            code: "auth.validation",
            message: "email and password are required",
            retryable: false,
          },
        },
        400,
      );
    }
    const user = await auth.createUser({ email, password });
    return c.json({ user: serializeUser(user) }, 201);
  });

  app.post("/v1/auth/sessions", async (c) => {
    const body = await readJsonBody(c);
    const email = String(body?.email ?? "");
    const password = String(body?.password ?? "");
    if (!email || !password) {
      return c.json(
        {
          error: {
            category: "POLICY_BLOCKED",
            code: "auth.validation",
            message: "email and password are required",
            retryable: false,
          },
        },
        400,
      );
    }
    // VerifyPasswordCredential throws CREDENTIAL_FAILURE on any failure
    // (unknown user, wrong password, disabled). Identical response shape
    // for unknown-user vs wrong-password — no account enumeration.
    const { userId } = await auth.verifyPasswordCredential({ email, password });
    // Issue a session-token API key with a bounded lifetime.
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const { rawKey, record } = await auth.createApiKey({
      userId,
      name: "session",
      expiresAt,
    });
    return c.json(
      {
        api_key: rawKey,
        key_id: record.id,
        expires_at: record.expiresAt?.toISOString() ?? null,
        user_id: userId,
      },
      201,
    );
  });

  // ---- Authenticated auth routes -------------------------------------

  app.post("/v1/auth/logout", requirePrincipal(), async (c) => {
    // Revoke the specific key used to authenticate this request. The
    // authMiddleware already verified it; we just need its id.
    const raw = extractCredentialFromRequest(c);
    const keyId = raw ? parseApiKeyId(raw) : null;
    if (!keyId) {
      throw new AppError({
        category: "CREDENTIAL_FAILURE",
        code: "auth.logout.no_key",
        message: "no verifiable api key to revoke",
        retryable: false,
      });
    }
    await auth.revokeApiKey(keyId);
    return c.json({ revoked: keyId }, 200);
  });

  app.get("/v1/auth/me", requirePrincipal(), async (c) => {
    const principal = c.get("principal")!;
    const user = await auth.getUser(principal.userId);
    if (!user) {
      throw new AppError({
        category: "CREDENTIAL_FAILURE",
        code: "auth.user.not_found",
        message: "user no longer exists",
        retryable: false,
      });
    }
    return c.json({
      user: serializeUser(user),
      memberships: principal.memberships
        .filter((m) => m.status === "active" || m.status === "invited" || m.status === "suspended")
        .map((m) => ({
          organization_id: m.organizationId,
          role: m.role,
          status: m.status,
        })),
    });
  });

  app.post("/v1/auth/api-keys", requirePrincipal(), async (c) => {
    const principal = c.get("principal")!;
    const body = await readJsonBody(c);
    const name = typeof body?.name === "string" ? body.name : null;
    const ttlSec = Number(body?.expires_in_seconds);
    const expiresAt =
      Number.isFinite(ttlSec) && ttlSec > 0
        ? new Date(Date.now() + ttlSec * 1000)
        : null;
    const { rawKey, record } = await auth.createApiKey({
      userId: principal.userId,
      name,
      expiresAt,
    });
    return c.json(
      {
        api_key: rawKey,
        record: serializeApiKeyRecord(record),
      },
      201,
    );
  });

  app.get("/v1/auth/api-keys", requirePrincipal(), async (c) => {
    const principal = c.get("principal")!;
    const records = await auth.listApiKeys(principal.userId);
    return c.json({ api_keys: records.map(serializeApiKeyRecord) });
  });

  app.delete("/v1/auth/api-keys/:id", requirePrincipal(), async (c) => {
    const principal = c.get("principal")!;
    const keyId = c.req.param("id");
    // Verify ownership before revoking — the caller can only revoke their
    // own keys. This is a server-side check; the path param is untrusted.
    const records = await auth.listApiKeys(principal.userId);
    const owns = records.some((r) => r.id === keyId);
    if (!owns) {
      throw new AppError({
        category: "POLICY_BLOCKED",
        code: "auth.api_key.not_owned",
        message: "api key not found or not owned by this user",
        retryable: false,
      });
    }
    await auth.revokeApiKey(keyId);
    return c.json({ revoked: keyId });
  });

  // ---- Organization routes (authenticated, non-tenant) --------------

  app.post("/v1/organizations", requirePrincipal(), async (c) => {
    const principal = c.get("principal")!;
    const body = await readJsonBody(c);
    const name = String(body?.name ?? "").trim();
    const slug = String(body?.slug ?? "").trim();
    if (!name || !slug) {
      return c.json(
        {
          error: {
            category: "POLICY_BLOCKED",
            code: "organization.validation",
            message: "name and slug are required",
            retryable: false,
          },
        },
        400,
      );
    }
    // createOrganizationWithOwner is transactional: org + initial owner
    // membership commit atomically. The caller becomes the owner.
    const { organization, ownerMembership } = await orgs.createOrganizationWithOwner({
      ownerUserId: principal.userId,
      name,
      slug,
    });
    return c.json(
      {
        organization: serializeOrganization(organization),
        owner_membership: serializeMembership(ownerMembership),
      },
      201,
    );
  });

  app.get("/v1/organizations", requirePrincipal(), async (c) => {
    const principal = c.get("principal")!;
    const orgsList = await orgs.listOrganizationsForUser(principal.userId);
    return c.json({ organizations: orgsList.map(serializeOrganization) });
  });

  // ---- Tenant-scoped routes (require orgContext) ---------------------
  // orgContextMiddleware requires a Principal (401) and resolves the
  // server-side tenant context (403 POLICY_BLOCKED if not an active
  // member of the requested :orgId).

  app.get(
    "/v1/organizations/:orgId",
    orgContextMiddleware(runtime, orgs),
    async (c) => {
      const ctx = c.get("orgContext")!;
      const organization = await orgs.getOrganization(ctx.organizationId);
      if (!organization) {
        throw new AppError({
          category: "POLICY_BLOCKED",
          code: "organization.not_found",
          message: "organization not found",
          retryable: false,
        });
      }
      return c.json({ organization: serializeOrganization(organization) });
    },
  );

  app.get(
    "/v1/organizations/:orgId/memberships",
    orgContextMiddleware(runtime, orgs),
    async (c) => {
      const ctx = c.get("orgContext")!;
      // listMembers checks the acting principal has MEMBER_LIST in this
      // org (every active member has it via the role→permission mapping).
      const members = await orgs.listMembers(
        ctx.organizationId,
        ctx.principal,
      );
      return c.json({ memberships: members.map(serializeMembership) });
    },
  );

  app.post(
    "/v1/organizations/:orgId/memberships",
    orgContextMiddleware(runtime, orgs),
    async (c) => {
      const ctx = c.get("orgContext")!;
      const body = await readJsonBody(c);
      const userId = String(body?.user_id ?? "");
      const role = String(body?.role ?? "member") as Role;
      if (!userId || !isValidRole(role)) {
        return c.json(
          {
            error: {
              category: "POLICY_BLOCKED",
              code: "organization.membership.validation",
              message: "user_id and a valid role are required",
              retryable: false,
            },
          },
          400,
        );
      }
      // addMember checks the acting principal has MEMBER_INVITE in this
      // org. Cross-org authority does NOT transfer — an admin of Org A
      // cannot add members to Org B (the permission is checked against
      // ctx.organizationId, the AUTHORIZED org).
      const membership = await orgs.addMember({
        organizationId: ctx.organizationId,
        userId,
        role,
        actingPrincipal: ctx.principal,
      });
      return c.json({ membership: serializeMembership(membership) }, 201);
    },
  );

  app.patch(
    "/v1/organizations/:orgId/memberships/:userId",
    orgContextMiddleware(runtime, orgs),
    async (c) => {
      const ctx = c.get("orgContext")!;
      const targetUserId = c.req.param("userId");
      const body = await readJsonBody(c);
      const role = typeof body?.role === "string" ? (body.role as Role) : undefined;
      const status =
        typeof body?.status === "string"
          ? (body.status as MembershipStatus)
          : undefined;
      let result;
      if (role && isValidRole(role)) {
        result = await orgs.updateRole({
          organizationId: ctx.organizationId,
          userId: targetUserId,
          role,
          actingPrincipal: ctx.principal,
        });
      }
      if (status && isValidStatus(status)) {
        result = await orgs.updateMembershipState({
          organizationId: ctx.organizationId,
          userId: targetUserId,
          status,
          actingPrincipal: ctx.principal,
        });
      }
      if (!result) {
        return c.json(
          {
            error: {
              category: "POLICY_BLOCKED",
              code: "organization.membership.validation",
              message: "provide a valid role or status to update",
              retryable: false,
            },
          },
          400,
        );
      }
      return c.json({ membership: serializeMembership(result) });
    },
  );

  app.delete(
    "/v1/organizations/:orgId/memberships/:userId",
    orgContextMiddleware(runtime, orgs),
    async (c) => {
      const ctx = c.get("orgContext")!;
      const targetUserId = c.req.param("userId");
      // removeMember checks MEMBER_MANAGE in this org and enforces the
      // last-owner invariant server-side.
      await orgs.removeMember({
        organizationId: ctx.organizationId,
        userId: targetUserId,
        actingPrincipal: ctx.principal,
      });
      return c.json({ removed: targetUserId });
    },
  );

  
}

// ---- Serialization helpers -------------------------------------------

function serializeUser(u: {
  id: string;
  email: string;
  status: string;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    status: u.status,
    created_at: u.createdAt.toISOString(),
  };
}

function serializeApiKeyRecord(r: {
  id: string;
  userId: string;
  name: string | null;
  scopes: readonly string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: r.id,
    user_id: r.userId,
    name: r.name,
    scopes: r.scopes,
    expires_at: r.expiresAt?.toISOString() ?? null,
    revoked_at: r.revokedAt?.toISOString() ?? null,
    last_used_at: r.lastUsedAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

function serializeOrganization(o: {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdByUserId: string;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    status: o.status,
    created_by_user_id: o.createdByUserId,
    created_at: o.createdAt.toISOString(),
  };
}

function serializeMembership(m: {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  status: string;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: m.id,
    organization_id: m.organizationId,
    user_id: m.userId,
    role: m.role,
    status: m.status,
    created_at: m.createdAt.toISOString(),
  };
}

// ---- Request helpers -------------------------------------------------

async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractCredentialFromRequest(c: {
  req: {
    header: (name: string) => string | undefined;
  };
}): string | null {
  const auth = c.req.header("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xKey = c.req.header("x-api-key");
  if (xKey) return xKey;
  return null;
}

function isValidRole(v: string): v is Role {
  return v === "owner" || v === "admin" || v === "member";
}

function isValidStatus(v: string): v is MembershipStatus {
  return v === "active" || v === "invited" || v === "suspended" || v === "removed";
}

// ORG_PERMISSIONS is imported only to assert the symbol exists for tree-
// shaking / to document that the API never re-implements role logic. The
// actual permission checks happen inside OrganizationsService.
void ORG_PERMISSIONS;
