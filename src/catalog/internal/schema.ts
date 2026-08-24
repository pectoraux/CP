// /catalog/internal/schema.ts
// PostgreSQL schema for the /catalog module (WORK-007, architecture §5,
// §9, §33, lock §1, §5). Owns the normalized marketplace FACTS: pricing,
// coverage, and health observations — each with explicit provenance.
//
// Authority model (WORK-007 §2-§5, §13):
//   - The catalog does NOT duplicate capability semantics (/capabilities
//     owns WHAT) or provider identity (/providers owns WHO). Catalog fact
//     tables reference the provider-capability DECLARATION row
//     (cp_provider_capabilities) via FK — the same declaration identity
//     WORK-006 established. The marketplace OFFERING is a pure SQL
//     projection joining providers + declarations + capabilities +
//     catalog facts (see offering.ts); no materialized duplicate exists,
//     so there is nothing to synchronize.
//   - The offering identity IS the declaration identity (provcap_<ulid>)
//     — one offering per (provider, capability, version).
//
// Provenance (architecture §9 — DECLARED / OBSERVED / VERIFIED /
// CERTIFIED; WORK-007 §6-§7): every fact row carries source_type,
// status, observed_at, verified_at, and evidence_reference. A provider
// claim (provider_declared → status=declared) is NEVER stored as an
// independently verified fact; platform observations are status=observed;
// deterministic verification (with an evidence reference) transitions a
// fact to status=verified. CERTIFIED is an OFFERING-level state sourced
// from /providers declaration certification + evidence — catalog fact
// mutations never set it (the CHECK allows the frozen vocabulary, but the
// catalog's mutation surface only produces declared/observed/verified).
//
// Tenancy (WORK-007 §16): the marketplace catalog is GLOBAL. There is no
// organization_id/project_id on any catalog table (asserted in tests via
// information_schema). Tenant connections/credentials are WORK-010.
//
// DDL is idempotent (CREATE TABLE IF NOT EXISTS) so
// migrateCatalogSchema(db) is safe on every startup and in tests. The
// /catalog migration runs AFTER /providers (its tables FK-reference
// cp_provider_capabilities → cp_providers → cp_capabilities).

export const CATALOG_SCHEMA_STATEMENTS: readonly string[] = [
  // ---- Pricing facts (architecture §5 PricingModel; WORK-007 §8-§9) ----
  // Append-only with effective_at versioning: a provider price change is
  // a NEW row (later effective_at); historical pricing facts are never
  // overwritten or silently lost. Provider-neutral across AI / payments /
  // messaging / compute / storage / identity / data. NO price computation,
  // comparison, or "best price" — that is later routing/optimization.
  `CREATE TABLE IF NOT EXISTS cp_catalog_pricing (
    id                       TEXT PRIMARY KEY,
    provider_capability_id   TEXT NOT NULL,
    model                    TEXT NOT NULL,
    currency                 TEXT,
    unit                     TEXT,
    amount                   NUMERIC NOT NULL,
    min_amount               NUMERIC,
    max_amount               NUMERIC,
    tiers                    JSONB,
    effective_at             TIMESTAMPTZ NOT NULL,
    source_type              TEXT NOT NULL,
    status                   TEXT NOT NULL,
    observed_at              TIMESTAMPTZ,
    verified_at              TIMESTAMPTZ,
    evidence_reference       TEXT,
    created_by_user_id       TEXT NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_catalog_pricing_declaration_fk
      FOREIGN KEY (provider_capability_id)
      REFERENCES cp_provider_capabilities(id) ON DELETE RESTRICT,
    CONSTRAINT cp_catalog_pricing_model_chk
      CHECK (model IN ('per_request', 'per_minute', 'per_token',
                       'percentage', 'fixed', 'tiered')),
    CONSTRAINT cp_catalog_pricing_currency_chk
      CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    CONSTRAINT cp_catalog_pricing_amount_chk
      CHECK (amount >= 0),
    CONSTRAINT cp_catalog_pricing_bounds_chk
      CHECK (min_amount IS NULL OR min_amount >= 0),
    CONSTRAINT cp_catalog_pricing_source_chk
      CHECK (source_type IN ('provider_declared', 'platform_observed',
                             'platform_verified', 'certification',
                             'imported_external', 'operator_asserted')),
    CONSTRAINT cp_catalog_pricing_status_chk
      CHECK (status IN ('declared', 'observed', 'verified', 'certified')),
    CONSTRAINT cp_catalog_pricing_status_source_chk
      CHECK (
        (source_type = 'provider_declared'   AND status IN ('declared', 'verified')) OR
        (source_type = 'platform_observed'   AND status IN ('observed', 'verified')) OR
        (source_type = 'platform_verified'   AND status = 'verified') OR
        (source_type = 'certification'       AND status = 'certified') OR
        (source_type = 'imported_external'   AND status IN ('declared', 'observed', 'verified')) OR
        (source_type = 'operator_asserted'   AND status IN ('declared', 'verified'))
      ),
    CONSTRAINT cp_catalog_pricing_verified_requires_evidence_chk
      CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND evidence_reference IS NOT NULL))
  )`,
  // Race-safe duplicate rejection for identical concurrent pricing facts
  // (same declaration, model, currency, unit, effective_at, provenance).
  // Different effective_at values coexist — that is price history.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_catalog_pricing_fact_uidx
    ON cp_catalog_pricing
       (provider_capability_id, model, COALESCE(currency, ''),
        COALESCE(unit, ''), effective_at, source_type)`,
  // Effective-time lookup for a declaration's pricing facts.
  `CREATE INDEX IF NOT EXISTS cp_catalog_pricing_declaration_idx
    ON cp_catalog_pricing (provider_capability_id, effective_at DESC, id DESC)`,

  // ---- Coverage facts (architecture §5 Coverage; WORK-007 §10) ---------
  // Where a provider capability is available: generic dimension/value
  // pairs (country | region | currency), each with provenance. No
  // regional assumptions are baked into the schema. A DECLARED coverage
  // fact and an OBSERVED fact for the same dimension/value coexist as
  // DISTINCT rows (different provenance) — that is the point.
  `CREATE TABLE IF NOT EXISTS cp_catalog_coverage (
    id                       TEXT PRIMARY KEY,
    provider_capability_id   TEXT NOT NULL,
    dimension                TEXT NOT NULL,
    value                    TEXT NOT NULL,
    source_type              TEXT NOT NULL,
    status                   TEXT NOT NULL,
    observed_at              TIMESTAMPTZ,
    verified_at              TIMESTAMPTZ,
    evidence_reference       TEXT,
    created_by_user_id       TEXT NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_catalog_coverage_declaration_fk
      FOREIGN KEY (provider_capability_id)
      REFERENCES cp_provider_capabilities(id) ON DELETE RESTRICT,
    CONSTRAINT cp_catalog_coverage_dimension_chk
      CHECK (dimension IN ('country', 'region', 'currency')),
    CONSTRAINT cp_catalog_coverage_source_chk
      CHECK (source_type IN ('provider_declared', 'platform_observed',
                             'platform_verified', 'certification',
                             'imported_external', 'operator_asserted')),
    CONSTRAINT cp_catalog_coverage_status_chk
      CHECK (status IN ('declared', 'observed', 'verified', 'certified')),
    CONSTRAINT cp_catalog_coverage_status_source_chk
      CHECK (
        (source_type = 'provider_declared'   AND status IN ('declared', 'verified')) OR
        (source_type = 'platform_observed'   AND status IN ('observed', 'verified')) OR
        (source_type = 'platform_verified'   AND status = 'verified') OR
        (source_type = 'certification'       AND status = 'certified') OR
        (source_type = 'imported_external'   AND status IN ('declared', 'observed', 'verified')) OR
        (source_type = 'operator_asserted'   AND status IN ('declared', 'verified'))
      ),
    CONSTRAINT cp_catalog_coverage_verified_requires_evidence_chk
      CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND evidence_reference IS NOT NULL))
  )`,
  // Race-safe duplicate rejection: the same (declaration, dimension,
  // value, source_type) is one fact; identical concurrent inserts → one
  // winner. Different provenance → distinct rows.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_catalog_coverage_fact_uidx
    ON cp_catalog_coverage (provider_capability_id, dimension, value, source_type)`,
  // Coverage lookups by dimension/value (catalog filters).
  `CREATE INDEX IF NOT EXISTS cp_catalog_coverage_dimval_idx
    ON cp_catalog_coverage (dimension, value)`,
  `CREATE INDEX IF NOT EXISTS cp_catalog_coverage_declaration_idx
    ON cp_catalog_coverage (provider_capability_id)`,

  // ---- Health observations (architecture §5 health; WORK-007 §11-§12) --
  // Append-only OBSERVATIONS of provider health — never immutable
  // provider truth, never a routing signal. Rows may be provider-wide
  // (provider_capability_id NULL) or capability-scoped, optionally
  // region-scoped. `metrics` carries observed performance evidence
  // (latency/success-rate/availability) with provenance — the minimal
  // catalog-local representation; the future /observations module owns
  // the full observation architecture. NO circuit breakers, failover,
  // or traffic shifting live here.
  `CREATE TABLE IF NOT EXISTS cp_catalog_health (
    id                       TEXT PRIMARY KEY,
    provider_id              TEXT NOT NULL,
    provider_capability_id   TEXT,
    region                   TEXT,
    status                   TEXT NOT NULL,
    metrics                  JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at              TIMESTAMPTZ NOT NULL,
    source_type              TEXT NOT NULL,
    evidence_reference       TEXT,
    created_by_user_id       TEXT NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_catalog_health_provider_fk
      FOREIGN KEY (provider_id) REFERENCES cp_providers(id) ON DELETE RESTRICT,
    CONSTRAINT cp_catalog_health_declaration_fk
      FOREIGN KEY (provider_capability_id)
      REFERENCES cp_provider_capabilities(id) ON DELETE RESTRICT,
    CONSTRAINT cp_catalog_health_status_chk
      CHECK (status IN ('healthy', 'degraded', 'unavailable', 'unknown')),
    CONSTRAINT cp_catalog_health_source_chk
      CHECK (source_type IN ('platform_observed', 'platform_verified',
                             'imported_external', 'operator_asserted',
                             'provider_declared', 'certification')),
    CONSTRAINT cp_catalog_health_region_chk
      CHECK (region IS NULL OR region ~ '^[A-Z][A-Z0-9_]{1,23}$')
  )`,
  // Health history lookups (newest-first per provider / declaration).
  `CREATE INDEX IF NOT EXISTS cp_catalog_health_provider_idx
    ON cp_catalog_health (provider_id, observed_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS cp_catalog_health_declaration_idx
    ON cp_catalog_health (provider_capability_id, observed_at DESC, id DESC)`,
];
