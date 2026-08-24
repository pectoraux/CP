// /catalog/internal/provenance.ts
// The catalog fact-provenance vocabulary (WORK-007 §6-§7; architecture
// §9). Every non-trivial catalog fact carries explicit provenance so a
// human can always answer "where did this fact come from?" — never a
// generic "confidence" number standing in for provenance.
//
// The frozen distinction (architecture §9):
//   DECLARED  — the provider claims it (provider_declared)
//   OBSERVED  — the platform observed it (platform_observed)
//   VERIFIED  — deterministic verification validated it (platform_verified)
//   CERTIFIED — evidence-backed certification approved it (certification)
//
// A provider claim is NEVER stored as an independently verified fact: the
// fact's status is derived from its source at creation, and the only
// status transition the catalog performs is declared/observed → verified,
// which REQUIRES an evidence reference (DB CHECK + service validation).

import { AppError } from "@cp/platform";

/** Where a catalog fact came from (frozen source categories). */
export type FactSourceType =
  | "provider_declared"
  | "platform_observed"
  | "platform_verified"
  | "certification"
  | "imported_external"
  | "operator_asserted";

export const FACT_SOURCE_TYPES: readonly FactSourceType[] = [
  "provider_declared",
  "platform_observed",
  "platform_verified",
  "certification",
  "imported_external",
  "operator_asserted",
] as const;

export function isFactSourceType(v: string): v is FactSourceType {
  return (FACT_SOURCE_TYPES as readonly string[]).includes(v);
}

/** The fact state in the frozen DECLARED/OBSERVED/VERIFIED/CERTIFIED space. */
export type FactStatus = "declared" | "observed" | "verified" | "certified";

export const FACT_STATUSES: readonly FactStatus[] = [
  "declared",
  "observed",
  "verified",
  "certified",
] as const;

export function isFactStatus(v: string): v is FactStatus {
  return (FACT_STATUSES as readonly string[]).includes(v);
}

/**
 * Derive a fact's initial status from its source (creation-time mapping).
 * CERTIFIED facts are only ever produced by the certification authority
 * (/providers evidence) — the catalog's own mutation surface never
 * creates them, so no source maps to 'certified' here.
 */
export function statusForSource(source: FactSourceType): FactStatus {
  switch (source) {
    case "provider_declared":
      return "declared";
    case "platform_observed":
      return "observed";
    case "platform_verified":
      return "verified";
    default:
      // certification / imported_external / operator_asserted: these do
      // not flow through catalog fact creation in WORK-007; imported and
      // operator-asserted facts enter as declared (they are claims until
      // verified), certification enters via the offering projection.
      return "declared";
  }
}

/** Health observation statuses (WORK-007 §11) — observations, not truth. */
export type HealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export const HEALTH_STATUSES: readonly HealthStatus[] = [
  "healthy",
  "degraded",
  "unavailable",
  "unknown",
] as const;

export function isHealthStatus(v: string): v is HealthStatus {
  return (HEALTH_STATUSES as readonly string[]).includes(v);
}

/** Pricing models (WORK-007 §8) — provider-neutral across domains. */
export type PricingModel =
  | "per_request"
  | "per_minute"
  | "per_token"
  | "percentage"
  | "fixed"
  | "tiered";

export const PRICING_MODELS: readonly PricingModel[] = [
  "per_request",
  "per_minute",
  "per_token",
  "percentage",
  "fixed",
  "tiered",
] as const;

export function isPricingModel(v: string): v is PricingModel {
  return (PRICING_MODELS as readonly string[]).includes(v);
}

/** Coverage dimensions (WORK-007 §10) — generic, region-agnostic. */
export type CoverageDimension = "country" | "region" | "currency";

export const COVERAGE_DIMENSIONS: readonly CoverageDimension[] = [
  "country",
  "region",
  "currency",
] as const;

export function isCoverageDimension(v: string): v is CoverageDimension {
  return (COVERAGE_DIMENSIONS as readonly string[]).includes(v);
}

const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const REGION_RE = /^[A-Z][A-Z0-9_]{1,23}$/;

/** Validate a coverage value against its dimension's shape. */
export function validateCoverageValue(
  dimension: CoverageDimension,
  value: string,
): string {
  const ok =
    dimension === "country"
      ? COUNTRY_RE.test(value)
      : dimension === "currency"
        ? CURRENCY_RE.test(value)
        : REGION_RE.test(value);
  if (!ok) {
    const shape =
      dimension === "country"
        ? "two uppercase letters (ISO-3166 alpha-2 style, e.g. GH)"
        : dimension === "currency"
          ? "three uppercase letters (ISO-4217 style, e.g. GHS)"
          : "an uppercase region slug (e.g. EU, EMEA, WEST_AFRICA)";
    throw catalogValidation(
      `coverage value for dimension "${dimension}" must be ${shape}; got "${value}"`,
      { dimension, value },
    );
  }
  return value;
}

/** Validate a pricing currency (null allowed where the model is unitless). */
export function validatePricingCurrency(
  currency: string | null | undefined,
): string | null {
  if (currency === null || currency === undefined || currency === "") return null;
  if (!CURRENCY_RE.test(currency)) {
    throw catalogValidation(
      `pricing currency must be three uppercase letters (ISO-4217 style, e.g. GHS); got "${currency}"`,
      { currency },
    );
  }
  return currency;
}

function catalogValidation(
  message: string,
  details: Record<string, unknown>,
): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "catalog.validation",
    message,
    retryable: false,
    details,
  });
}
