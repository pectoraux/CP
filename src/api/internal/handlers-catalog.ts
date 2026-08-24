// /api/internal/handlers-catalog.ts
// WORK-007 transport routes for /catalog (architecture §9, §23, §33, §35,
// §36, lock §8, §9, WORK-007 §17-§19). The API layer is a transport
// boundary only: it imports only the PUBLIC interface of @cp/catalog
// (and @cp/platform for the runtime, @cp/auth for the Principal), never
// any module's internals. Authorization happens at the domain service
// boundary (CatalogService checks the CP-level capability-admin grant
// server-side).
//
// Routes (all under /v1/catalog, authenticated):
//   GET    /v1/catalog/offerings                     — list/filter offerings (paginated, any principal)
//   GET    /v1/catalog/offerings/:offeringId         — offering detail (any principal)
//   POST   /v1/catalog/pricing                       — record pricing fact (admin, idempotent)
//   POST   /v1/catalog/pricing/:factId/verification  — verify a pricing fact (admin, idempotent)
//   POST   /v1/catalog/coverage                      — record coverage fact (admin, idempotent)
//   POST   /v1/catalog/coverage/:factId/verification — verify a coverage fact (admin, idempotent)
//   POST   /v1/catalog/health                        — record health observation (admin, idempotent)
//
// Reads are the marketplace query surface (filters: capability, version,
// provider, certification, country/region/currency, pricing model,
// integration path, source type, include_inactive, cursor pagination per
// WORK-004 conventions). Mutations follow the existing Idempotency-Key
// convention via the shared IdempotencyStore (WORK-007 §19). No secrets,
// no tenant connection data, no internal database structures are exposed
// (WORK-007 §21): responses serialize an explicit allowlist of fields.
//
// Authority (WORK-007 §16-§17, §21): the catalog is GLOBAL marketplace
// infrastructure. Mutations require the capability-admin grant
// (capability.manage) — the same platform-operator authority as the
// capability catalog and provider registry. An ordinary org owner/admin
// is refused (proven in tests/security/catalog-authority).

import { Hono } from "hono";
import type { Runtime } from "@cp/platform";
import type { AuthService } from "@cp/auth";
import type { Principal } from "@cp/auth";
import type { OrganizationsService } from "@cp/organizations";
import {
  CatalogService,
  type CatalogOffering,
  type PricingFact,
  type CoverageFact,
  type HealthObservation,
  type PricingModel,
  type CoverageDimension,
  type HealthStatus,
  type FactSourceType,
  isPricingModel,
  isCoverageDimension,
  isHealthStatus,
  isFactSourceType,
} from "@cp/catalog";
import {
  authMiddleware,
  requirePrincipal,
  type AuthVars,
} from "./middleware.ts";
import { IdempotencyStore, withIdempotency } from "./idempotency.ts";

export interface CatalogRouteDeps {
  runtime: Runtime;
  auth: AuthService;
  orgs: OrganizationsService;
  catalog: CatalogService;
  idempotency: IdempotencyStore;
}

export function createCatalogRoutes(
  deps: CatalogRouteDeps,
  app: Hono<{ Variables: AuthVars }>,
): void {
  const { runtime, auth, orgs, catalog, idempotency } = deps;
  // Verify credential IF present on every /v1/catalog route.
  app.use("/v1/catalog/*", authMiddleware(runtime, auth, orgs));
  app.use("/v1/catalog", authMiddleware(runtime, auth, orgs));

  // ---- List offerings (the marketplace query surface) ------------------

  app.get("/v1/catalog/offerings", requirePrincipal(), async (c) => {
    const limitRaw = Number(c.req.query("limit") ?? 25);
    const page = await catalog.listOfferings({
      limit: Number.isFinite(limitRaw) ? limitRaw : 25,
      cursor: c.req.query("cursor") ?? null,
      capabilityId: c.req.query("capability_id") ?? undefined,
      capabilityVersion: c.req.query("capability_version") ?? undefined,
      providerId: c.req.query("provider_id") ?? undefined,
      certification: c.req.query("certification") ?? undefined,
      country: c.req.query("country") ?? undefined,
      region: c.req.query("region") ?? undefined,
      currency: c.req.query("currency") ?? undefined,
      pricingModel: c.req.query("pricing_model") ?? undefined,
      integrationPath: c.req.query("integration_path") ?? undefined,
      sourceType: c.req.query("source_type") ?? undefined,
      includeInactive: c.req.query("include_inactive") === "true",
    });
    return c.json({
      offerings: page.offerings.map(serializeOffering),
      next_cursor: page.nextCursor,
    });
  });

  // ---- Offering detail -----------------------------------------------------

  app.get("/v1/catalog/offerings/:offeringId", requirePrincipal(), async (c) => {
    const offering = await catalog.getOffering(c.req.param("offeringId"));
    if (!offering) {
      return c.json(
        {
          error: {
            category: "POLICY_BLOCKED",
            code: "catalog.offering.not_found",
            message: `offering "${c.req.param("offeringId")}" was not found`,
          },
        },
        404,
      );
    }
    return c.json({ offering: serializeOffering(offering) });
  });

  // ---- Record pricing fact (admin, idempotent) -------------------------------

  app.post(
    "/v1/catalog/pricing",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (body) => {
        const model = String(body?.model ?? "");
        if (!isPricingModel(model)) {
          return validationError(c, `model must be one of per_request|per_minute|per_token|percentage|fixed|tiered (got "${model}")`);
        }
        const sourceType = String(body?.source_type ?? "");
        if (!isFactSourceType(sourceType)) {
          return validationError(c, `source_type must be one of provider_declared|platform_observed|platform_verified|certification|imported_external|operator_asserted (got "${sourceType}")`);
        }
        if (body?.provider_id === undefined || body?.capability_id === undefined || body?.capability_version === undefined) {
          return validationError(c, "provider_id, capability_id, and capability_version are required");
        }
        if (body?.amount === undefined) {
          return validationError(c, "amount is required");
        }
        const fact = await catalog.addPricingFact({
          providerId: String(body.provider_id),
          capabilityId: String(body.capability_id),
          capabilityVersion: String(body.capability_version),
          model: model as PricingModel,
          currency: body.currency === null || body.currency === undefined ? null : String(body.currency),
          unit: body.unit === null || body.unit === undefined ? null : String(body.unit),
          amount: body.amount as number | string,
          minAmount: (body.min_amount ?? null) as number | string | null,
          maxAmount: (body.max_amount ?? null) as number | string | null,
          tiers: body?.tiers,
          effectiveAt: body?.effective_at === undefined ? null : (body.effective_at as string),
          sourceType: sourceType as FactSourceType,
          evidenceReference: body?.evidence_reference === undefined ? null : String(body.evidence_reference),
          actingPrincipal: principal,
        });
        return c.json({ pricing: serializePricing(fact) }, 201);
      });
    },
  );

  // ---- Verify pricing fact (admin, idempotent) ---------------------------------

  app.post(
    "/v1/catalog/pricing/:factId/verification",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (body) => {
        const evidence = String(body?.evidence_reference ?? "").trim();
        if (!evidence) {
          return validationError(c, "evidence_reference is required to verify a fact");
        }
        const fact = await catalog.verifyPricingFact({
          factId: c.req.param("factId"),
          evidenceReference: evidence,
          actingPrincipal: principal,
        });
        return c.json({ pricing: serializePricing(fact) });
      });
    },
  );

  // ---- Record coverage fact (admin, idempotent) ----------------------------------

  app.post(
    "/v1/catalog/coverage",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (body) => {
        const dimension = String(body?.dimension ?? "");
        if (!isCoverageDimension(dimension)) {
          return validationError(c, `dimension must be one of country|region|currency (got "${dimension}")`);
        }
        const sourceType = String(body?.source_type ?? "");
        if (!isFactSourceType(sourceType)) {
          return validationError(c, `source_type must be one of provider_declared|platform_observed|platform_verified|certification|imported_external|operator_asserted (got "${sourceType}")`);
        }
        if (body?.provider_id === undefined || body?.capability_id === undefined || body?.capability_version === undefined) {
          return validationError(c, "provider_id, capability_id, and capability_version are required");
        }
        if (body?.value === undefined) {
          return validationError(c, "value is required");
        }
        const fact = await catalog.addCoverageFact({
          providerId: String(body.provider_id),
          capabilityId: String(body.capability_id),
          capabilityVersion: String(body.capability_version),
          dimension: dimension as CoverageDimension,
          value: String(body.value),
          sourceType: sourceType as FactSourceType,
          evidenceReference: body?.evidence_reference === undefined ? null : String(body.evidence_reference),
          actingPrincipal: principal,
        });
        return c.json({ coverage: serializeCoverage(fact) }, 201);
      });
    },
  );

  // ---- Verify coverage fact (admin, idempotent) ------------------------------------

  app.post(
    "/v1/catalog/coverage/:factId/verification",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (body) => {
        const evidence = String(body?.evidence_reference ?? "").trim();
        if (!evidence) {
          return validationError(c, "evidence_reference is required to verify a fact");
        }
        const fact = await catalog.verifyCoverageFact({
          factId: c.req.param("factId"),
          evidenceReference: evidence,
          actingPrincipal: principal,
        });
        return c.json({ coverage: serializeCoverage(fact) });
      });
    },
  );

  // ---- Record health observation (admin, idempotent) ---------------------------------

  app.post(
    "/v1/catalog/health",
    requirePrincipal(),
    async (c) => {
      const principal = c.get("principal")!;
      return withIdempotency(c, idempotency, principal, async (body) => {
        const status = String(body?.status ?? "");
        if (!isHealthStatus(status)) {
          return validationError(c, `status must be one of healthy|degraded|unavailable|unknown (got "${status}")`);
        }
        const sourceType = String(body?.source_type ?? "");
        if (!isFactSourceType(sourceType)) {
          return validationError(c, `source_type must be one of provider_declared|platform_observed|platform_verified|certification|imported_external|operator_asserted (got "${sourceType}")`);
        }
        if (body?.provider_id === undefined) {
          return validationError(c, "provider_id is required");
        }
        if (body?.capability_id !== undefined && body?.capability_version === undefined) {
          return validationError(c, "capability_version is required when capability_id is provided");
        }
        const observation = await catalog.recordHealthObservation({
          providerId: String(body.provider_id),
          capabilityId: body?.capability_id === undefined ? undefined : String(body.capability_id),
          capabilityVersion: body?.capability_version === undefined ? undefined : String(body.capability_version),
          region: body?.region === undefined || body?.region === null ? null : String(body.region),
          status: status as HealthStatus,
          metrics:
            body?.metrics && typeof body.metrics === "object" && !Array.isArray(body.metrics)
              ? (body.metrics as Record<string, unknown>)
              : {},
          observedAt: body?.observed_at === undefined ? null : (body.observed_at as string),
          sourceType: sourceType as FactSourceType,
          evidenceReference: body?.evidence_reference === undefined ? null : String(body.evidence_reference),
          actingPrincipal: principal,
        });
        return c.json({ health: serializeHealth(observation) }, 201);
      });
    },
  );

  void (null as unknown as Principal);
}

// ---- Serializers (explicit allowlist: nothing secret can leak) -------------

function serializeOffering(o: CatalogOffering) {
  return {
    offering_id: o.offeringId,
    provider: {
      provider_id: o.provider.providerId,
      name: o.provider.name,
      status: o.provider.status,
      integration_path: o.provider.integrationPath,
      documentation_url: o.provider.documentationUrl,
    },
    capability: {
      capability_id: o.capability.capabilityId,
      capability_version: o.capability.capabilityVersion,
      capability_status: o.capability.capabilityStatus,
      version_status: o.capability.versionStatus,
    },
    implementation: {
      adapter_version: o.implementation.adapterVersion,
      status: o.implementation.status,
      certification_environment: o.implementation.certificationEnvironment,
      supported_constraints: o.implementation.supportedConstraints,
      // Requirement NAMES only — never secret values (WORK-007 §21).
      credential_requirement_names: o.implementation.credentialRequirementNames,
    },
    evidence: {
      total_tests: o.evidence.totalTests,
      passed_tests: o.evidence.passedTests,
      latest_environment: o.evidence.latestEnvironment,
    },
    pricing: o.pricing.map(serializePricing),
    coverage: o.coverage.map(serializeCoverage),
    health: o.health.map(serializeHealth),
  };
}

function serializePricing(f: PricingFact) {
  return {
    id: f.id,
    model: f.model,
    currency: f.currency,
    unit: f.unit,
    amount: f.amount,
    min_amount: f.minAmount,
    max_amount: f.maxAmount,
    tiers: f.tiers,
    effective_at: f.effectiveAt.toISOString(),
    provenance: {
      source_type: f.sourceType,
      status: f.status,
      observed_at: f.observedAt ? f.observedAt.toISOString() : null,
      verified_at: f.verifiedAt ? f.verifiedAt.toISOString() : null,
      evidence_reference: f.evidenceReference,
    },
    created_at: f.createdAt.toISOString(),
  };
}

function serializeCoverage(f: CoverageFact) {
  return {
    id: f.id,
    dimension: f.dimension,
    value: f.value,
    provenance: {
      source_type: f.sourceType,
      status: f.status,
      observed_at: f.observedAt ? f.observedAt.toISOString() : null,
      verified_at: f.verifiedAt ? f.verifiedAt.toISOString() : null,
      evidence_reference: f.evidenceReference,
    },
    created_at: f.createdAt.toISOString(),
  };
}

function serializeHealth(h: HealthObservation) {
  return {
    id: h.id,
    provider_id: h.providerCanonicalId,
    region: h.region,
    status: h.status,
    metrics: h.metrics,
    observed_at: h.observedAt.toISOString(),
    provenance: {
      source_type: h.sourceType,
      evidence_reference: h.evidenceReference,
    },
  };
}

function validationError(c: { json: (b: unknown, s: number) => Response; get: (k: "requestId") => string }, message: string): Response {
  return c.json(
    {
      error: {
        category: "POLICY_BLOCKED",
        code: "catalog.validation",
        message,
        retryable: false,
        request_id: c.get("requestId"),
      },
    },
    400,
  );
}
