// /catalog — public interface.
//
// Responsibility (architecture §5, §9, §33, §36, lock §1, §5, WORK-007):
// normalized marketplace inventory and provider capability facts.
//
// WORK-007 delivers the marketplace catalog:
//   - the OFFERING projection: "provider X implements capability Y
//     version Z" joined with marketplace facts — the normalized answer to
//     What can be done? By whom? Where? Under what constraints? At what
//     declared price? With what observed evidence? With what
//     verification/certification state?
//   - pricing facts (provider-neutral models, append-only effective_at
//     versioning, provenance)
//   - coverage facts (generic country/region/currency dimensions,
//     provenance)
//   - health observations (append-only, provider-wide or
//     capability-scoped, optional observed performance metrics)
//   - fact provenance: DECLARED / OBSERVED / VERIFIED / CERTIFIED with
//     source_type, observed_at, verified_at, evidence_reference — a
//     provider claim is never represented as independently verified fact
//
// Authority (WORK-007 §2-§5): the catalog does NOT own capability
// semantics (/capabilities) or provider identity (/providers); it owns
// marketplace FACTS and references the provider-capability declaration
// established by WORK-006. The offering is a pure SQL projection — no
// duplicated materialized state.
//
// Dependency direction (WORK-007 §22): /catalog → @cp/capabilities
// (admin-authority check) + @cp/platform + @cp/auth. It NEVER imports
// /routing, /optimization, /experiments, /eligibility, /policies, or any
// downstream layer — enforced by the static architecture check. The
// catalog stores normalized facts; later policy/eligibility/routing/
// optimization layers consume them.
//
// This module is part of the frozen module set (architecture §35). It
// exposes ONE public interface entry point; other modules may import ONLY
// from this file.

// ---- CatalogService (DB-backed facts + offering projection) --------------
export { CatalogService } from "./internal/service.ts";
export type {
  CatalogServiceOptions,
  PricingFact,
  CoverageFact,
  HealthObservation,
  CatalogOffering,
  CatalogPage,
  AddPricingFactInput,
  AddCoverageFactInput,
  RecordHealthInput,
  VerifyFactInput,
  ListOfferingsOptions,
} from "./internal/service.ts";

// ---- Provenance vocabulary (architecture §9; WORK-007 §6-§7) --------------
export type {
  FactSourceType,
  FactStatus,
  HealthStatus,
  PricingModel,
  CoverageDimension,
} from "./internal/provenance.ts";
export {
  FACT_SOURCE_TYPES,
  FACT_STATUSES,
  HEALTH_STATUSES,
  PRICING_MODELS,
  COVERAGE_DIMENSIONS,
  isFactSourceType,
  isFactStatus,
  isHealthStatus,
  isPricingModel,
  isCoverageDimension,
  statusForSource,
  validateCoverageValue,
  validatePricingCurrency,
} from "./internal/provenance.ts";

// ---- Schema migration --------------------------------------------------------
export { CATALOG_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateCatalogSchema } from "./internal/schema-runner.ts";

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "catalog" as const;
