// /api/internal/handlers-providers.ts
// WORK-006 transport routes for /providers (architecture §7, §8, §23,
// §32, §35, §36, lock §7, §8, WORK-006 §21). The API layer is a transport
// boundary only: it imports only the PUBLIC interface of @cp/providers
// (and @cp/platform for the runtime, @cp/auth for the Principal), never
// any module's internals. Authorization happens at the domain service
// boundary (ProvidersService checks the CP-level capability-admin grant
// server-side); the handler never re-implements authority logic.
//
// Routes (all under /v1/providers, authenticated; the :providerId path
// param is the canonical id e.g. 'demo.echo'):
//   POST   /v1/providers                                                    — create (idempotent, admin)
//   GET    /v1/providers                                                    — list (paginated, any principal)
//   GET    /v1/providers/:providerId                                        — get (any principal)
//   POST   /v1/providers/:providerId/lifecycle                              — transition lifecycle (admin, idempotent)
//   POST   /v1/providers/:providerId/capabilities                           — declare implementation (admin, idempotent)
//   GET    /v1/providers/:providerId/capabilities                           — list declarations (any principal)
//   POST   /v1/providers/:providerId/capabilities/:capabilityId/versions/:version/certification-tests
//                                                                           — run the adapter contract suite for one declaration, record evidence (admin, idempotent)
//   GET    /v1/providers/:providerId/certification                          — evidence list (any principal)
//
// Authority (WORK-006 §3, §11): the provider registry is GLOBAL CP-level
// infrastructure. Mutations require the capability-admin grant
// (capability.manage) — the same platform-operator authority as the
// capability catalog. Reads are authenticated-only.
//
// Secrets: NOTHING in these responses is secret. Credential requirements
// serialize as METADATA (kind/name/scopes — never values). Tenant
// connection data does not exist on these routes (future /connections).

import { Hono } from "hono";
import type { Runtime } from "@cp/platform";
import type { AuthService } from "@cp/auth";
import type { Principal } from "@cp/auth";
import type { OrganizationsService } from "@cp/organizations";
import {
  ProvidersService,
  type Provider,
  type ProviderCapability,
  type CertificationEvidenceRecord,
  type ProviderStatus,
  isProviderStatus,
} from "@cp/providers";
import {
  authMiddleware,
  requirePrincipal,
  type AuthVars,
} from "./middleware.ts";
import { IdempotencyStore, withIdempotency } from "./idempotency.ts";

export interface ProviderRouteDeps {
  runtime: Runtime;
  auth: AuthService;
  orgs: OrganizationsService;
  providers: ProvidersService;
  idempotency: IdempotencyStore;
}

export function createProviderRoutes(
  deps: ProviderRouteDeps,
  app: Hono<{ Variables: AuthVars }>,
): void {
  const { runtime, auth, orgs, providers, idempotency } = deps;
  // Verify credential IF present on every /v1/providers route.
  app.use("/v1/providers/*", authMiddleware(runtime, auth, orgs));
  app.use("/v1/providers", authMiddleware(runtime, auth, orgs));

  // ---- Create provider (side-effecting → idempotency-supported) ---------

  app.post(
    "/v1/providers",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (body) => {
        const providerId = String(body?.provider_id ?? "").trim();
        const name = String(body?.name ?? "").trim();
        if (!providerId || !name) {
          return validationError(c, "provider_id and name are required");
        }
        const integrationPath = String(body?.integration_path ?? "platform_operated");
        if (integrationPath !== "platform_operated" && integrationPath !== "provider_operated") {
          return validationError(c, "integration_path must be platform_operated or provider_operated");
        }
        const provider = await providers.createProvider({
          providerId,
          name,
          description: typeof body?.description === "string" ? body.description : undefined,
          integrationPath,
          documentationUrl:
            typeof body?.documentation_url === "string" ? body.documentation_url : undefined,
          actingPrincipal: principal,
        });
        return c.json({ provider: serializeProvider(provider) }, 201);
      });
    },
  );

  // ---- List providers ------------------------------------------------------

  app.get("/v1/providers", requirePrincipal(), async (c) => {
    const limit = Number(c.req.query("limit") ?? 25);
    const statusParam = c.req.query("status");
    let status: ProviderStatus | undefined;
    if (statusParam !== undefined && statusParam !== "") {
      if (!isProviderStatus(statusParam)) {
        return validationError(c, `unknown provider status "${statusParam}"`);
      }
      status = statusParam;
    }
    const page = await providers.listProviders({
      limit: Number.isFinite(limit) ? limit : 25,
      cursor: c.req.query("cursor") ?? null,
      status,
    });
    return c.json({
      providers: page.providers.map(serializeProvider),
      next_cursor: page.nextCursor,
    });
  });

  // ---- Get provider ----------------------------------------------------------

  app.get("/v1/providers/:providerId", requirePrincipal(), async (c) => {
    const provider = await providers.getProvider(decodeId(c.req.param("providerId")));
    if (!provider) {
      return c.json(
        {
          error: {
            category: "POLICY_BLOCKED",
            code: "provider.not_found",
            message: `provider "${decodeId(c.req.param("providerId"))}" was not found`,
          },
        },
        404,
      );
    }
    return c.json({ provider: serializeProvider(provider) });
  });

  // ---- Lifecycle transition ---------------------------------------------------

  app.post(
    "/v1/providers/:providerId/lifecycle",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (body) => {
        const toStatus = String(body?.status ?? "");
        if (!isProviderStatus(toStatus)) {
          return validationError(c, `unknown provider status "${toStatus}"`);
        }
        const provider = await providers.transitionProvider({
          providerId: decodeId(c.req.param("providerId")),
          toStatus,
          actingPrincipal: principal,
        });
        return c.json({ provider: serializeProvider(provider) });
      });
    },
  );

  // ---- Declare capability implementation -----------------------------------

  app.post(
    "/v1/providers/:providerId/capabilities",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (body) => {
        const capabilityId = String(body?.capability_id ?? "").trim();
        const capabilityVersion = String(body?.capability_version ?? "").trim();
        if (!capabilityId || !capabilityVersion) {
          return validationError(c, "capability_id and capability_version are required");
        }
        const declaration = await providers.declareProviderCapability({
          providerId: decodeId(c.req.param("providerId")),
          capabilityId,
          capabilityVersion,
          adapterVersion:
            typeof body?.adapter_version === "string" ? body.adapter_version : undefined,
          supportedConstraints:
            body?.supported_constraints && typeof body.supported_constraints === "object"
              ? (body.supported_constraints as Record<string, unknown>)
              : undefined,
          actingPrincipal: principal,
        });
        return c.json({ implementation: serializeDeclaration(declaration) }, 201);
      });
    },
  );

  // ---- List declarations ------------------------------------------------------

  app.get("/v1/providers/:providerId/capabilities", requirePrincipal(), async (c) => {
    const declarations = await providers.listProviderCapabilities(
      decodeId(c.req.param("providerId")),
    );
    return c.json({ implementations: declarations.map(serializeDeclaration) });
  });

  // ---- Run certification contract tests (evidence-producing) -----------------

  app.post(
    "/v1/providers/:providerId/capabilities/:capabilityId/versions/:version/certification-tests",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (_body) => {
        const result = await providers.runContractTests({
          providerId: decodeId(c.req.param("providerId")),
          actingPrincipal: principal,
        });
        return c.json(
          {
            environment: result.environment,
            adapter_version: result.adapterVersion,
            declaration_results: result.declarationResults.map((d) => ({
              capability_id: d.capabilityId,
              capability_version: d.capabilityVersion,
              status_before: d.statusBefore,
              status_after: d.statusAfter,
              outcomes: d.outcomes.map((o) => ({
                test: o.testName,
                result: o.result,
                detail: o.detail,
              })),
            })),
            evidence_ids: result.evidenceIds,
          },
          200,
        );
      });
    },
  );

  // ---- Certification evidence list ---------------------------------------------

  app.get("/v1/providers/:providerId/certification", requirePrincipal(), async (c) => {
    const evidence = await providers.listCertificationEvidence(
      decodeId(c.req.param("providerId")),
    );
    return c.json({ evidence: evidence.map(serializeEvidence) });
  });

  void (null as unknown as Principal);
}

// ---- Serializers (explicit allowlist: nothing secret can leak) -------------

function serializeProvider(p: Provider) {
  return {
    id: p.id,
    provider_id: p.providerId,
    name: p.name,
    description: p.description,
    status: p.status,
    integration_path: p.integrationPath,
    documentation_url: p.documentationUrl,
    created_by_user_id: p.createdByUserId,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

function serializeDeclaration(d: ProviderCapability) {
  return {
    id: d.id,
    provider_id: d.providerCanonicalId,
    capability_id: d.capabilityCanonicalId,
    capability_version: d.capabilityVersion,
    adapter_version: d.adapterVersion,
    status: d.status,
    certification_environment: d.certificationEnvironment,
    supported_constraints: d.supportedConstraints,
    // METADATA ONLY — kinds/names/scopes, never secret values (WORK-006 §10).
    credential_requirements: d.credentialRequirements.map((r) => ({
      name: r.name,
      kind: r.kind,
      description: r.description,
      scopes: r.scopes,
      optional: r.optional,
    })),
    created_by_user_id: d.createdByUserId,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

function serializeEvidence(e: CertificationEvidenceRecord) {
  return {
    id: e.id,
    capability_id: e.capabilityCanonicalId,
    capability_version: e.capabilityVersion,
    test: e.testName,
    result: e.result,
    environment: e.environment,
    adapter_version: e.adapterVersion,
    artifact_ref: e.artifactRef,
    detail: e.detail,
    created_by_user_id: e.createdByUserId,
    created_at: e.createdAt.toISOString(),
  };
}

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function validationError(c: { json: (b: unknown, s: number) => Response; get: (k: "requestId") => string }, message: string): Response {
  return c.json(
    {
      error: {
        category: "POLICY_BLOCKED",
        code: "provider.validation",
        message,
        retryable: false,
        request_id: c.get("requestId"),
      },
    },
    400,
  );
}
