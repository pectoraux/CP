// /catalog/internal/service.ts
// CatalogService — the /catalog module's concrete service (WORK-007,
// architecture §5, §9, §33, lock §1, §5). Owns the normalized marketplace
// FACTS: pricing, coverage, and health observations — each with explicit
// provenance (DECLARED / OBSERVED / VERIFIED / CERTIFIED).
//
// Authority model (WORK-007 §2-§5, §13):
//   - The catalog does NOT duplicate capability semantics (/capabilities
//     owns WHAT) or provider identity (/providers owns WHO). Facts
//     reference the provider-capability DECLARATION row (provcap_<ulid>)
//     via FK; the marketplace OFFERING is a pure SQL projection over
//     providers + declarations + capabilities + catalog facts (no
//     materialized copy, nothing to synchronize — FKs and joins ARE the
//     consistency mechanism, following the WORK-006 SQL-join precedent).
//   - Mutations require the CP-level capability-admin grant (the same
//     platform-operator authority as the capability catalog and provider
//     registry): an arbitrary org owner/admin cannot mutate global
//     marketplace facts (proven in tests/security/catalog-authority).
//     Reads are authenticated-only.
//   - CERTIFIED state is sourced from /providers declaration
//     certification + evidence via the offering projection — catalog fact
//     mutations never set it. A provider claim never becomes verified
//     truth without an evidence reference.
//
// Lifecycle interaction (WORK-007 §15): the projection CONSUMES provider
// and capability lifecycles without redefining them. Active offerings
// exclude revoked/suspended/deprecated providers and retired capability
// versions/capabilities; include_inactive=true surfaces the rest for
// operator inspection (they are still labeled, never presented as active).
//
// PostgreSQL is authoritative (lock §1). The service depends ONLY on the
// provider-neutral platform Database interface plus the @cp/capabilities
// public interface for the admin-authority check (catalog → capabilities
// is the intended one-way direction; /catalog never imports /providers
// internals — only its table schema via SQL joins, same as WORK-006's
// cross-module FK/join precedent).

import {
  AppError,
  type Database,
  type DbQueryResultRow,
  ulid,
  Logger,
  type LogSink,
  type LogRecord,
} from "@cp/platform";
import type { Principal } from "@cp/auth";
import type { CapabilitiesService } from "@cp/capabilities";
import {
  type FactSourceType,
  type FactStatus,
  type HealthStatus,
  type PricingModel,
  type CoverageDimension,
  isFactSourceType,
  isHealthStatus,
  isPricingModel,
  isCoverageDimension,
  statusForSource,
  validateCoverageValue,
  validatePricingCurrency,
} from "./provenance.ts";

// ---- Record types ---------------------------------------------------------

export interface PricingFact {
  id: string;
  providerCapabilityId: string;
  model: PricingModel;
  currency: string | null;
  unit: string | null;
  amount: string; // NUMERIC as canonical string (never computed with here)
  minAmount: string | null;
  maxAmount: string | null;
  tiers: unknown;
  effectiveAt: Date;
  sourceType: FactSourceType;
  status: FactStatus;
  observedAt: Date | null;
  verifiedAt: Date | null;
  evidenceReference: string | null;
  createdByUserId: string;
  createdAt: Date;
}

export interface CoverageFact {
  id: string;
  providerCapabilityId: string;
  dimension: CoverageDimension;
  value: string;
  sourceType: FactSourceType;
  status: FactStatus;
  observedAt: Date | null;
  verifiedAt: Date | null;
  evidenceReference: string | null;
  createdByUserId: string;
  createdAt: Date;
}

export interface HealthObservation {
  id: string;
  providerId: string; // internal surrogate
  providerCanonicalId: string; // denormalized for display
  providerCapabilityId: string | null;
  region: string | null;
  status: HealthStatus;
  metrics: Record<string, unknown>;
  observedAt: Date;
  sourceType: FactSourceType;
  evidenceReference: string | null;
  createdByUserId: string;
  createdAt: Date;
}

/** The resolved declaration a catalog fact attaches to. */
interface DeclarationRef {
  declarationId: string;
  providerId: string; // internal surrogate
  providerCanonicalId: string;
  providerStatus: string;
  capabilityCanonicalId: string;
  capabilityVersion: string;
  capabilityStatus: string;
  versionStatus: string | null;
}

export interface CatalogOffering {
  offeringId: string; // = declaration id (provcap_<ulid>)
  provider: {
    providerId: string; // canonical, e.g. 'demo.echo'
    name: string;
    status: string;
    integrationPath: string;
    documentationUrl: string | null;
  };
  capability: {
    capabilityId: string; // canonical, e.g. 'demo.echo'
    capabilityVersion: string;
    capabilityStatus: string;
    versionStatus: string | null;
  };
  implementation: {
    adapterVersion: string;
    status: string; // registered | contract_verified | certified
    certificationEnvironment: string;
    supportedConstraints: Record<string, unknown>;
    credentialRequirementNames: string[];
  };
  evidence: {
    totalTests: number;
    passedTests: number;
    latestEnvironment: string | null;
  };
  pricing: PricingFact[];
  coverage: CoverageFact[];
  health: HealthObservation[];
}

export interface CatalogPage {
  offerings: CatalogOffering[];
  nextCursor: string | null;
}

// ---- Inputs ---------------------------------------------------------------

export interface AddPricingFactInput {
  providerId: string; // canonical provider id
  capabilityId: string; // canonical capability id
  capabilityVersion: string;
  model: PricingModel;
  currency?: string | null;
  unit?: string | null;
  amount: number | string;
  minAmount?: number | string | null;
  maxAmount?: number | string | null;
  tiers?: unknown;
  effectiveAt?: Date | string | null;
  sourceType: FactSourceType;
  evidenceReference?: string | null;
  actingPrincipal: Principal;
}

export interface AddCoverageFactInput {
  providerId: string;
  capabilityId: string;
  capabilityVersion: string;
  dimension: CoverageDimension;
  value: string;
  sourceType: FactSourceType;
  evidenceReference?: string | null;
  actingPrincipal: Principal;
}

export interface RecordHealthInput {
  providerId: string; // canonical provider id
  capabilityId?: string; // canonical capability id (capability-scoped)
  capabilityVersion?: string; // required with capabilityId
  region?: string | null;
  status: HealthStatus;
  metrics?: Record<string, unknown>;
  observedAt?: Date | string | null;
  sourceType: FactSourceType;
  evidenceReference?: string | null;
  actingPrincipal: Principal;
}

export interface VerifyFactInput {
  factId: string;
  evidenceReference: string;
  actingPrincipal: Principal;
}

export interface ListOfferingsOptions {
  limit?: number;
  cursor?: string | null;
  capabilityId?: string;
  capabilityVersion?: string;
  providerId?: string;
  certification?: string; // implementation status filter
  country?: string;
  region?: string;
  currency?: string;
  pricingModel?: string;
  integrationPath?: string;
  sourceType?: string;
  includeInactive?: boolean;
}

export interface CatalogServiceOptions {
  db: Database;
  logger?: Logger;
  /** The capability catalog (public interface) — used for the admin-authority check. */
  capabilities: CapabilitiesService;
}

const NOOP_SINK: LogSink = {
  emit(_record: LogRecord): void {},
};

// ---- Service ---------------------------------------------------------------

export class CatalogService {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly capabilities: CapabilitiesService;

  constructor(opts: CatalogServiceOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
    this.capabilities = opts.capabilities;
  }

  // ---- Authority -----------------------------------------------------------

  /**
   * Mutations of global marketplace facts require the CP-level
   * capability-admin grant — the same platform-operator authority that
   * gates the capability catalog (WORK-005 §22) and the provider registry
   * (WORK-006). The catalog is CP-level infrastructure, not a tenant
   * surface (WORK-007 §16, §21).
   */
  private async requireCatalogAdmin(principal: Principal): Promise<void> {
    const ok = await this.capabilities.isCapabilityAdmin(principal.userId);
    if (!ok) {
      throw policyBlocked("catalog.admin.required", "capability.manage authority is required for catalog mutations", {
        reason: "not_a_catalog_admin",
        user_id: principal.userId,
      });
    }
  }

  // ---- Declaration resolution ----------------------------------------------

  /**
   * Resolve (provider, capability, version) → the declaration row, with
   * lifecycle visibility. Facts may attach to declarations whose provider
   * or capability has since aged (history is preserved — WORK-007 §9), so
   * this returns the declaration with its CURRENT lifecycle states and
   * lets callers decide; the OFFERING PROJECTION is what excludes dead
   * entities from the active view.
   */
  private async resolveDeclaration(
    providerId: string,
    capabilityId: string,
    capabilityVersion: string,
  ): Promise<DeclarationRef> {
    const rows = await this.db.query({
      text: `SELECT pc.id AS declaration_id,
                    p.id AS provider_internal_id,
                    p.provider_id AS provider_canonical_id,
                    p.status AS provider_status,
                    c.capability_id AS capability_canonical_id,
                    c.status AS capability_status,
                    pc.capability_version,
                    v.status AS version_status
             FROM cp_provider_capabilities pc
             JOIN cp_providers p ON p.id = pc.provider_id
             JOIN cp_capabilities c ON c.id = pc.capability_id
             LEFT JOIN cp_capability_versions v
                    ON v.capability_id = pc.capability_id AND v.version = pc.capability_version
             WHERE lower(p.provider_id) = lower($1)
               AND lower(c.capability_id) = lower($2)
               AND pc.capability_version = $3`,
      params: [providerId, capabilityId, capabilityVersion],
    });
    const row = rows[0];
    if (!row) {
      throw notFound(
        "catalog.declaration.not_found",
        `no provider-capability declaration for provider "${providerId}", capability "${capabilityId}" version "${capabilityVersion}"`,
        { provider_id: providerId, capability_id: capabilityId, capability_version: capabilityVersion },
      );
    }
    return {
      declarationId: String(row.declaration_id),
      providerId: String(row.provider_internal_id),
      providerCanonicalId: String(row.provider_canonical_id),
      providerStatus: String(row.provider_status),
      capabilityCanonicalId: String(row.capability_canonical_id),
      capabilityVersion: String(row.capability_version),
      capabilityStatus: String(row.capability_status),
      versionStatus: row.version_status === null ? null : String(row.version_status),
    };
  }

  // ---- Pricing facts ---------------------------------------------------------

  /**
   * Record a pricing fact (WORK-007 §8-§9). Pricing is append-only with
   * effective_at versioning — a price change is a NEW fact; history is
   * never overwritten. The amount is stored verbatim as declared/observed
   * — the catalog NEVER computes, compares, or ranks prices.
   */
  async addPricingFact(input: AddPricingFactInput): Promise<PricingFact> {
    await this.requireCatalogAdmin(input.actingPrincipal);
    if (!isPricingModel(input.model)) {
      throw policyBlocked("catalog.validation", `unknown pricing model "${String(input.model)}"`, {
        reason: "invalid_pricing_model",
      });
    }
    if (!isFactSourceType(input.sourceType)) {
      throw policyBlocked("catalog.validation", `unknown fact source "${String(input.sourceType)}"`, {
        reason: "invalid_source_type",
      });
    }
    const declaration = await this.resolveDeclaration(
      input.providerId,
      input.capabilityId,
      input.capabilityVersion,
    );

    const currency = validatePricingCurrency(input.currency ?? null);
    const amount = parseAmount(input.amount, "amount");
    const minAmount = input.minAmount === null || input.minAmount === undefined ? null : parseAmount(input.minAmount, "min_amount");
    const maxAmount = input.maxAmount === null || input.maxAmount === undefined ? null : parseAmount(input.maxAmount, "max_amount");
    if (minAmount !== null && maxAmount !== null && Number(minAmount) > Number(maxAmount)) {
      throw policyBlocked("catalog.validation", "min_amount must not exceed max_amount", {
        reason: "invalid_bounds",
      });
    }
    const unit =
      typeof input.unit === "string" && input.unit.trim().length > 0
        ? input.unit.trim()
        : null;

    // Tiered pricing requires a tiers array; other models must not carry one.
    let tiers: unknown = null;
    if (input.model === "tiered") {
      tiers = validateTiers(input.tiers);
    } else if (input.tiers !== undefined && input.tiers !== null) {
      throw policyBlocked("catalog.validation", `tiers are only valid for the "tiered" pricing model`, {
        reason: "tiers_on_non_tiered_model",
        model: input.model,
      });
    }

    const status = statusForSource(input.sourceType);
    if (status === "verified" && !input.evidenceReference) {
      throw policyBlocked("catalog.validation", "verified pricing facts require an evidence_reference", {
        reason: "missing_evidence",
      });
    }
    const effectiveAt = parseDate(input.effectiveAt, "effective_at") ?? new Date();
    const evidenceReference =
      typeof input.evidenceReference === "string" && input.evidenceReference.trim().length > 0
        ? input.evidenceReference.trim()
        : null;

    const id = `prc_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_catalog_pricing
                 (id, provider_capability_id, model, currency, unit, amount,
                  min_amount, max_amount, tiers, effective_at, source_type,
                  status, observed_at, verified_at, evidence_reference, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16)`,
        params: [
          id,
          declaration.declarationId,
          input.model,
          currency,
          unit,
          amount,
          minAmount,
          maxAmount,
          tiers === null ? null : JSON.stringify(tiers),
          effectiveAt,
          input.sourceType,
          status,
          status === "observed" ? effectiveAt : null,
          status === "verified" ? new Date() : null,
          evidenceReference,
          input.actingPrincipal.userId,
        ],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("catalog.pricing.duplicate", "this pricing fact already exists (same declaration, model, currency, unit, effective_at, and source)", {
          reason: "duplicate_pricing_fact",
        });
      }
      throw err;
    }
    this.logger.info("catalog: pricing fact recorded", {
      pricing_fact_id: id,
      declaration: `${declaration.providerCanonicalId}:${declaration.capabilityCanonicalId}@${declaration.capabilityVersion}`,
      model: input.model,
      currency,
      source_type: input.sourceType,
      status,
      actor: input.actingPrincipal.userId,
    });
    const created = await this.getPricingFact(id);
    if (!created) {
      throw platformFailure("catalog.pricing.readback", "pricing fact creation succeeded but the row could not be read back");
    }
    return created;
  }

  async getPricingFact(id: string): Promise<PricingFact | null> {
    const rows = await this.db.query({
      text: `SELECT * FROM cp_catalog_pricing WHERE id = $1`,
      params: [id],
    });
    const row = rows[0];
    return row ? mapPricing(row as PricingRow) : null;
  }

  /** Transition a declared/observed pricing fact to VERIFIED (evidence required). */
  async verifyPricingFact(input: VerifyFactInput): Promise<PricingFact> {
    await this.requireCatalogAdmin(input.actingPrincipal);
    const fact = await this.getPricingFact(input.factId);
    if (!fact) {
      throw notFound("catalog.pricing.not_found", `pricing fact "${input.factId}" was not found`, {
        fact_id: input.factId,
      });
    }
    if (fact.status === "verified" || fact.status === "certified") {
      throw policyBlocked("catalog.fact.already_verified", `pricing fact "${input.factId}" is already ${fact.status}`, {
        reason: "already_verified",
        fact_id: input.factId,
      });
    }
    const evidence = input.evidenceReference.trim();
    if (evidence.length === 0) {
      throw policyBlocked("catalog.validation", "evidence_reference is required to verify a fact", {
        reason: "missing_evidence",
      });
    }
    await this.db.exec({
      text: `UPDATE cp_catalog_pricing
             SET status = 'verified', verified_at = NOW(), evidence_reference = $1
             WHERE id = $2`,
      params: [evidence, input.factId],
    });
    this.logger.info("catalog: pricing fact verified", {
      pricing_fact_id: input.factId,
      evidence_reference: evidence,
      actor: input.actingPrincipal.userId,
    });
    const updated = await this.getPricingFact(input.factId);
    if (!updated) {
      throw platformFailure("catalog.pricing.readback", "verification succeeded but the row could not be read back");
    }
    return updated;
  }

  // ---- Coverage facts ----------------------------------------------------------

  /**
   * Record a coverage fact (WORK-007 §10): where a provider capability is
   * available, as generic dimension/value pairs with provenance. A
   * DECLARED fact and an OBSERVED fact for the same dimension/value
   * coexist as distinct rows — the provenance distinction is the point.
   */
  async addCoverageFact(input: AddCoverageFactInput): Promise<CoverageFact> {
    await this.requireCatalogAdmin(input.actingPrincipal);
    if (!isCoverageDimension(input.dimension)) {
      throw policyBlocked("catalog.validation", `unknown coverage dimension "${String(input.dimension)}"`, {
        reason: "invalid_coverage_dimension",
      });
    }
    if (!isFactSourceType(input.sourceType)) {
      throw policyBlocked("catalog.validation", `unknown fact source "${String(input.sourceType)}"`, {
        reason: "invalid_source_type",
      });
    }
    const value = validateCoverageValue(input.dimension, input.value.trim());
    const declaration = await this.resolveDeclaration(
      input.providerId,
      input.capabilityId,
      input.capabilityVersion,
    );
    const status = statusForSource(input.sourceType);
    if (status === "verified" && !input.evidenceReference) {
      throw policyBlocked("catalog.validation", "verified coverage facts require an evidence_reference", {
        reason: "missing_evidence",
      });
    }
    const evidenceReference =
      typeof input.evidenceReference === "string" && input.evidenceReference.trim().length > 0
        ? input.evidenceReference.trim()
        : null;

    const id = `cov_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_catalog_coverage
                 (id, provider_capability_id, dimension, value, source_type,
                  status, observed_at, verified_at, evidence_reference, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        params: [
          id,
          declaration.declarationId,
          input.dimension,
          value,
          input.sourceType,
          status,
          status === "observed" ? new Date() : null,
          status === "verified" ? new Date() : null,
          evidenceReference,
          input.actingPrincipal.userId,
        ],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("catalog.coverage.duplicate", "this coverage fact already exists (same declaration, dimension, value, and source)", {
          reason: "duplicate_coverage_fact",
        });
      }
      throw err;
    }
    this.logger.info("catalog: coverage fact recorded", {
      coverage_fact_id: id,
      declaration: `${declaration.providerCanonicalId}:${declaration.capabilityCanonicalId}@${declaration.capabilityVersion}`,
      dimension: input.dimension,
      value,
      source_type: input.sourceType,
      status,
      actor: input.actingPrincipal.userId,
    });
    const created = await this.getCoverageFact(id);
    if (!created) {
      throw platformFailure("catalog.coverage.readback", "coverage fact creation succeeded but the row could not be read back");
    }
    return created;
  }

  async getCoverageFact(id: string): Promise<CoverageFact | null> {
    const rows = await this.db.query({
      text: `SELECT * FROM cp_catalog_coverage WHERE id = $1`,
      params: [id],
    });
    const row = rows[0];
    return row ? mapCoverage(row as CoverageRow) : null;
  }

  /** Transition a declared/observed coverage fact to VERIFIED (evidence required). */
  async verifyCoverageFact(input: VerifyFactInput): Promise<CoverageFact> {
    await this.requireCatalogAdmin(input.actingPrincipal);
    const fact = await this.getCoverageFact(input.factId);
    if (!fact) {
      throw notFound("catalog.coverage.not_found", `coverage fact "${input.factId}" was not found`, {
        fact_id: input.factId,
      });
    }
    if (fact.status === "verified" || fact.status === "certified") {
      throw policyBlocked("catalog.fact.already_verified", `coverage fact "${input.factId}" is already ${fact.status}`, {
        reason: "already_verified",
        fact_id: input.factId,
      });
    }
    const evidence = input.evidenceReference.trim();
    if (evidence.length === 0) {
      throw policyBlocked("catalog.validation", "evidence_reference is required to verify a fact", {
        reason: "missing_evidence",
      });
    }
    await this.db.exec({
      text: `UPDATE cp_catalog_coverage
             SET status = 'verified', verified_at = NOW(), evidence_reference = $1
             WHERE id = $2`,
      params: [evidence, input.factId],
    });
    this.logger.info("catalog: coverage fact verified", {
      coverage_fact_id: input.factId,
      evidence_reference: evidence,
      actor: input.actingPrincipal.userId,
    });
    const updated = await this.getCoverageFact(input.factId);
    if (!updated) {
      throw platformFailure("catalog.coverage.readback", "verification succeeded but the row could not be read back");
    }
    return updated;
  }

  // ---- Health observations --------------------------------------------------------

  /**
   * Record a health observation (WORK-007 §11-§12): an append-only
   * OBSERVATION of provider health (provider-wide or capability-scoped,
   * optionally region-scoped), never immutable provider truth and never a
   * routing signal. `metrics` may carry observed performance evidence
   * (latency/success-rate/availability) with provenance — the minimal
   * catalog-local representation; /observations (later work) owns the
   * full observation architecture.
   */
  async recordHealthObservation(input: RecordHealthInput): Promise<HealthObservation> {
    await this.requireCatalogAdmin(input.actingPrincipal);
    if (!isHealthStatus(input.status)) {
      throw policyBlocked("catalog.validation", `unknown health status "${String(input.status)}"`, {
        reason: "invalid_health_status",
      });
    }
    if (!isFactSourceType(input.sourceType)) {
      throw policyBlocked("catalog.validation", `unknown fact source "${String(input.sourceType)}"`, {
        reason: "invalid_source_type",
      });
    }
    const region =
      typeof input.region === "string" && input.region.trim().length > 0
        ? validateRegion(input.region.trim())
        : null;
    const observedAt = parseDate(input.observedAt, "observed_at") ?? new Date();
    const evidenceReference =
      typeof input.evidenceReference === "string" && input.evidenceReference.trim().length > 0
        ? input.evidenceReference.trim()
        : null;
    const metrics =
      input.metrics && typeof input.metrics === "object" && !Array.isArray(input.metrics)
        ? (input.metrics as Record<string, unknown>)
        : {};

    // Provider-wide or capability-scoped: resolve accordingly.
    let providerInternalId: string;
    let providerCanonicalId: string;
    let declarationId: string | null = null;
    if (input.capabilityId !== undefined && input.capabilityId !== null && input.capabilityId !== "") {
      if (!input.capabilityVersion) {
        throw policyBlocked("catalog.validation", "capability_version is required when capability_id is provided", {
          reason: "missing_capability_version",
        });
      }
      const decl = await this.resolveDeclaration(input.providerId, input.capabilityId, input.capabilityVersion);
      providerInternalId = decl.providerId;
      providerCanonicalId = decl.providerCanonicalId;
      declarationId = decl.declarationId;
    } else {
      const rows = await this.db.query({
        text: `SELECT id, provider_id FROM cp_providers WHERE lower(provider_id) = lower($1)`,
        params: [input.providerId],
      });
      const row = rows[0];
      if (!row) {
        throw notFound("catalog.provider.not_found", `provider "${input.providerId}" was not found`, {
          provider_id: input.providerId,
        });
      }
      providerInternalId = String(row.id);
      providerCanonicalId = String(row.provider_id);
    }

    const id = `hlth_${ulid()}`;
    await this.db.exec({
      text: `INSERT INTO cp_catalog_health
               (id, provider_id, provider_capability_id, region, status,
                metrics, observed_at, source_type, evidence_reference, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
      params: [
        id,
        providerInternalId,
        declarationId,
        region,
        input.status,
        JSON.stringify(metrics),
        observedAt,
        input.sourceType,
        evidenceReference,
        input.actingPrincipal.userId,
      ],
    });
    this.logger.info("catalog: health observation recorded", {
      health_observation_id: id,
      provider: providerCanonicalId,
      declaration: declarationId,
      region,
      status: input.status,
      source_type: input.sourceType,
      actor: input.actingPrincipal.userId,
    });
    const created = await this.getHealthObservation(id);
    if (!created) {
      throw platformFailure("catalog.health.readback", "health observation creation succeeded but the row could not be read back");
    }
    return created;
  }

  async getHealthObservation(id: string): Promise<HealthObservation | null> {
    const rows = await this.db.query({
      text: `SELECT h.*, p.provider_id AS provider_canonical_id
             FROM cp_catalog_health h
             JOIN cp_providers p ON p.id = h.provider_id
             WHERE h.id = $1`,
      params: [id],
    });
    const row = rows[0];
    return row ? mapHealth(row as HealthRow) : null;
  }

  // ---- Offering projection --------------------------------------------------------

  /**
   * List marketplace offerings (the normalized inventory projection).
   *
   * Active offerings (default) exclude providers whose lifecycle is
   * revoked/suspended/deprecated and capability versions (or
   * capabilities) that are retired (WORK-007 §14-§15: revoked providers
   * and retired versions are never presented as active offerings).
   * include_inactive=true surfaces the remainder for operator
   * inspection — still labeled with their real statuses, never as active.
   *
   * Coverage filters (country/region/currency) match offerings having a
   * coverage fact with that dimension/value (any provenance — the
   * catalog does not silently prefer declared over observed).
   */
  async listOfferings(opts: ListOfferingsOptions = {}): Promise<CatalogPage> {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: string[] = [];
    const params: unknown[] = [];

    if (!opts.includeInactive) {
      where.push(`p.status IN ('discovered', 'integrating', 'contract_tested', 'observed', 'certified', 'active')`);
      where.push(`COALESCE(v.status, '') <> 'retired'`);
      where.push(`c.status <> 'retired'`);
    }
    if (opts.capabilityId) {
      params.push(opts.capabilityId);
      where.push(`lower(c.capability_id) = lower($${params.length})`);
    }
    if (opts.capabilityVersion) {
      params.push(opts.capabilityVersion);
      where.push(`pc.capability_version = $${params.length}`);
    }
    if (opts.providerId) {
      params.push(opts.providerId);
      where.push(`lower(p.provider_id) = lower($${params.length})`);
    }
    if (opts.certification) {
      params.push(opts.certification);
      where.push(`pc.status = $${params.length}`);
    }
    if (opts.integrationPath) {
      params.push(opts.integrationPath);
      where.push(`p.integration_path = $${params.length}`);
    }
    if (opts.pricingModel) {
      params.push(opts.pricingModel);
      where.push(
        `EXISTS (SELECT 1 FROM cp_catalog_pricing pr
                 WHERE pr.provider_capability_id = pc.id AND pr.model = $${params.length})`,
      );
    }
    if (opts.sourceType) {
      params.push(opts.sourceType);
      const st = `$${params.length}`;
      where.push(
        `(EXISTS (SELECT 1 FROM cp_catalog_pricing pr
                  WHERE pr.provider_capability_id = pc.id AND pr.source_type = ${st})
          OR EXISTS (SELECT 1 FROM cp_catalog_coverage cv
                     WHERE cv.provider_capability_id = pc.id AND cv.source_type = ${st}))`,
      );
    }
    for (const [dimension, filter] of [
      ["country", opts.country],
      ["region", opts.region],
      ["currency", opts.currency],
    ] as const) {
      if (filter) {
        params.push(filter);
        where.push(
          `EXISTS (SELECT 1 FROM cp_catalog_coverage cv
                   WHERE cv.provider_capability_id = pc.id
                     AND cv.dimension = '${dimension}' AND cv.value = $${params.length})`,
        );
      }
    }
    if (opts.cursor) {
      params.push(opts.cursor);
      where.push(`pc.id < $${params.length}`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await this.db.query({
      text: `SELECT pc.id AS offering_id
             FROM cp_provider_capabilities pc
             JOIN cp_providers p ON p.id = pc.provider_id
             JOIN cp_capabilities c ON c.id = pc.capability_id
             LEFT JOIN cp_capability_versions v
                    ON v.capability_id = pc.capability_id AND v.version = pc.capability_version
             ${whereSql}
             ORDER BY pc.id DESC
             LIMIT ${limit + 1}`,
      params,
    });
    const ids = rows.map((r) => String(r.offering_id));
    const pageIds = ids.slice(0, limit);
    const nextCursor = ids.length > limit ? pageIds[pageIds.length - 1]! : null;
    const offerings: CatalogOffering[] = [];
    for (const id of pageIds) {
      const offering = await this.getOfferingById(id);
      if (offering) offerings.push(offering);
    }
    return { offerings, nextCursor };
  }

  /**
   * Get one offering by its id (the declaration id). Returns null when
   * the id does not exist. NOTE: this returns the offering regardless of
   * lifecycle state (labeled with real statuses); the ACTIVE view is the
   * listOfferings default. Callers inspecting a specific dead offering
   * see its true state, never a falsely active presentation.
   */
  async getOffering(offeringId: string): Promise<CatalogOffering | null> {
    return this.getOfferingById(offeringId);
  }

  private async getOfferingById(id: string): Promise<CatalogOffering | null> {
    const baseRows = await this.db.query({
      text: `SELECT pc.id AS offering_id,
                    p.provider_id AS provider_canonical_id,
                    p.name AS provider_name,
                    p.status AS provider_status,
                    p.integration_path,
                    p.documentation_url,
                    c.capability_id AS capability_canonical_id,
                    c.status AS capability_status,
                    pc.capability_version,
                    v.status AS version_status,
                    pc.adapter_version,
                    pc.status AS implementation_status,
                    pc.certification_environment,
                    pc.supported_constraints,
                    pc.credential_requirements
             FROM cp_provider_capabilities pc
             JOIN cp_providers p ON p.id = pc.provider_id
             JOIN cp_capabilities c ON c.id = pc.capability_id
             LEFT JOIN cp_capability_versions v
                    ON v.capability_id = pc.capability_id AND v.version = pc.capability_version
             WHERE pc.id = $1`,
      params: [id],
    });
    const base = baseRows[0];
    if (!base) return null;

    const declarationId = String(base.offering_id);
    const [pricingRows, coverageRows, healthRows, evidenceRows] = await Promise.all([
      this.db.query({
        text: `SELECT * FROM cp_catalog_pricing
               WHERE provider_capability_id = $1
               ORDER BY effective_at DESC, id DESC`,
        params: [declarationId],
      }),
      this.db.query({
        text: `SELECT * FROM cp_catalog_coverage
               WHERE provider_capability_id = $1
               ORDER BY dimension, value, id`,
        params: [declarationId],
      }),
      this.db.query({
        text: `SELECT h.*, p.provider_id AS provider_canonical_id
               FROM cp_catalog_health h
               JOIN cp_providers p ON p.id = h.provider_id
               WHERE h.provider_capability_id = $1
                  OR (h.provider_capability_id IS NULL AND h.provider_id = (SELECT provider_id FROM cp_provider_capabilities WHERE id = $1))
               ORDER BY h.observed_at DESC, h.id DESC
               LIMIT 50`,
        params: [declarationId],
      }),
      this.db.query({
        text: `SELECT count(*)::int AS total,
                      count(*) FILTER (WHERE result = 'pass')::int AS passed,
                      max(environment) AS latest_environment
               FROM cp_provider_certification_evidence
               WHERE provider_capability_id = $1`,
        params: [declarationId],
      }),
    ]);

    const credReqs = Array.isArray(base.credential_requirements)
      ? (base.credential_requirements as { name?: string }[])
      : [];
    const evidence = evidenceRows[0] as { total: number; passed: number; latest_environment: string | null } | undefined;

    return {
      offeringId: declarationId,
      provider: {
        providerId: String(base.provider_canonical_id),
        name: String(base.provider_name),
        status: String(base.provider_status),
        integrationPath: String(base.integration_path),
        documentationUrl: base.documentation_url === null ? null : String(base.documentation_url),
      },
      capability: {
        capabilityId: String(base.capability_canonical_id),
        capabilityVersion: String(base.capability_version),
        capabilityStatus: String(base.capability_status),
        versionStatus: base.version_status === null ? null : String(base.version_status),
      },
      implementation: {
        adapterVersion: String(base.adapter_version),
        status: String(base.implementation_status),
        certificationEnvironment: String(base.certification_environment),
        supportedConstraints:
          base.supported_constraints && typeof base.supported_constraints === "object"
            ? (base.supported_constraints as Record<string, unknown>)
            : {},
        // Metadata names only — NEVER secret values (WORK-007 §21).
        credentialRequirementNames: credReqs
          .map((r) => (typeof r.name === "string" ? r.name : null))
          .filter((n): n is string => n !== null),
      },
      evidence: {
        totalTests: Number(evidence?.total ?? 0),
        passedTests: Number(evidence?.passed ?? 0),
        latestEnvironment: evidence?.latest_environment ?? null,
      },
      pricing: pricingRows.map((r) => mapPricing(r as PricingRow)),
      coverage: coverageRows.map((r) => mapCoverage(r as CoverageRow)),
      health: healthRows.map((r) => mapHealth(r as HealthRow)),
    };
  }
}

// ---- Row mappers ------------------------------------------------------------

interface PricingRow extends DbQueryResultRow {
  id: string;
  provider_capability_id: string;
  model: string;
  currency: string | null;
  unit: string | null;
  amount: string | number;
  min_amount: string | number | null;
  max_amount: string | number | null;
  tiers: unknown;
  effective_at: Date | string;
  source_type: string;
  status: string;
  observed_at: Date | string | null;
  verified_at: Date | string | null;
  evidence_reference: string | null;
  created_by_user_id: string;
  created_at: Date | string;
}

function mapPricing(row: PricingRow): PricingFact {
  return {
    id: row.id,
    providerCapabilityId: row.provider_capability_id,
    model: row.model as PricingModel,
    currency: row.currency,
    unit: row.unit,
    amount: String(row.amount),
    minAmount: row.min_amount === null ? null : String(row.min_amount),
    maxAmount: row.max_amount === null ? null : String(row.max_amount),
    tiers: row.tiers ?? null,
    effectiveAt: new Date(row.effective_at),
    sourceType: row.source_type as FactSourceType,
    status: row.status as FactStatus,
    observedAt: row.observed_at === null ? null : new Date(row.observed_at),
    verifiedAt: row.verified_at === null ? null : new Date(row.verified_at),
    evidenceReference: row.evidence_reference,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
  };
}

interface CoverageRow extends DbQueryResultRow {
  id: string;
  provider_capability_id: string;
  dimension: string;
  value: string;
  source_type: string;
  status: string;
  observed_at: Date | string | null;
  verified_at: Date | string | null;
  evidence_reference: string | null;
  created_by_user_id: string;
  created_at: Date | string;
}

function mapCoverage(row: CoverageRow): CoverageFact {
  return {
    id: row.id,
    providerCapabilityId: row.provider_capability_id,
    dimension: row.dimension as CoverageDimension,
    value: row.value,
    sourceType: row.source_type as FactSourceType,
    status: row.status as FactStatus,
    observedAt: row.observed_at === null ? null : new Date(row.observed_at),
    verifiedAt: row.verified_at === null ? null : new Date(row.verified_at),
    evidenceReference: row.evidence_reference,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
  };
}

interface HealthRow extends DbQueryResultRow {
  id: string;
  provider_id: string;
  provider_canonical_id: string;
  provider_capability_id: string | null;
  region: string | null;
  status: string;
  metrics: unknown;
  observed_at: Date | string;
  source_type: string;
  evidence_reference: string | null;
  created_by_user_id: string;
  created_at: Date | string;
}

function mapHealth(row: HealthRow): HealthObservation {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerCanonicalId: row.provider_canonical_id,
    providerCapabilityId: row.provider_capability_id,
    region: row.region,
    status: row.status as HealthStatus,
    metrics:
      row.metrics && typeof row.metrics === "object" && !Array.isArray(row.metrics)
        ? (row.metrics as Record<string, unknown>)
        : {},
    observedAt: new Date(row.observed_at),
    sourceType: row.source_type as FactSourceType,
    evidenceReference: row.evidence_reference,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
  };
}

// ---- Validation helpers --------------------------------------------------------

function parseAmount(v: number | string, field: string): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw policyBlocked("catalog.validation", `${field} must be a finite non-negative number`, {
      reason: "invalid_amount",
      field,
    });
  }
  // Canonical string form preserves precision; the catalog never computes.
  return typeof v === "string" ? v.trim() : String(v);
}

function validateTiers(tiers: unknown): { up_to?: number | string; amount: number | string }[] {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw policyBlocked("catalog.validation", "tiered pricing requires a non-empty tiers array", {
      reason: "invalid_tiers",
    });
  }
  const out: { up_to?: number | string; amount: number | string }[] = [];
  for (const raw of tiers) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw policyBlocked("catalog.validation", "each tier must be an object { up_to?, amount }", {
        reason: "invalid_tier",
      });
    }
    const tier = raw as Record<string, unknown>;
    if (tier.amount === undefined) {
      throw policyBlocked("catalog.validation", "each tier requires an amount", {
        reason: "invalid_tier",
      });
    }
    parseAmount(tier.amount as number | string, "tiers.amount");
    if (tier.up_to !== undefined && tier.up_to !== null) {
      const upTo = typeof tier.up_to === "number" ? tier.up_to : Number(tier.up_to);
      if (!Number.isFinite(upTo) || upTo < 0) {
        throw policyBlocked("catalog.validation", "tier up_to must be a finite non-negative number", {
          reason: "invalid_tier",
        });
      }
    }
    out.push({
      ...(tier.up_to !== undefined && tier.up_to !== null ? { up_to: tier.up_to as number | string } : {}),
      amount: tier.amount as number | string,
    });
  }
  return out;
}

function validateRegion(region: string): string {
  if (!/^[A-Z][A-Z0-9_]{1,23}$/.test(region)) {
    throw policyBlocked("catalog.validation", `region must be an uppercase region slug (e.g. EU, EMEA, WEST_AFRICA); got "${region}"`, {
      reason: "invalid_region",
      region,
    });
  }
  return region;
}

function parseDate(v: Date | string | null | undefined, field: string): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw policyBlocked("catalog.validation", `${field} must be a valid date`, {
      reason: "invalid_date",
      field,
    });
  }
  return d;
}

// ---- Error helpers ------------------------------------------------------------

function policyBlocked(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code,
    message,
    retryable: false,
    details,
  });
}

function notFound(code: string, message: string, details?: Record<string, unknown>): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code,
    message,
    retryable: false,
    details: { reason: code, ...(details ?? {}) },
  });
}

function platformFailure(code: string, message: string): AppError {
  return new AppError({
    category: "PLATFORM_FAILURE",
    code,
    message,
    retryable: false,
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof AppError) {
    if (err.details?.driverCode === "23505") return true;
    const causeCode = (err.causeValue as { code?: string } | undefined)?.code;
    if (causeCode === "23505") return true;
    return false;
  }
  const rawCode = (err as { code?: string } | undefined)?.code;
  return rawCode === "23505";
}
