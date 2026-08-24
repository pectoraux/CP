// /eligibility/internal/types.ts
// The eligibility request/result vocabulary (WORK-009, architecture §10,
// §16, §36). Defines the normalized evaluation context (WORK-009 §15),
// the structured check model (§6), the failure taxonomy (§18), and
// request validation (deterministic, bounded — mirroring the WORK-008
// constrained-input discipline).
//
// Layer separation (WORK-009 §2-§5): eligibility answers "Can candidate
// X satisfy the request under the applicable rules?" — it NEVER chooses
// a winner, ranks, scores, or executes providers.

import { AppError } from "@cp/platform";

// ---- Failure taxonomy (WORK-009 §18) ---------------------------------------

export type EligibilityStatus = "eligible" | "ineligible" | "indeterminate";

export type CheckResult = "pass" | "fail" | "indeterminate";

/**
 * The three-way distinction the frozen work item requires:
 *   fail          — the candidate DEFINITELY failed a hard check
 *   indeterminate — required evidence was unavailable (never success)
 *   pass          — the check succeeded
 */
export function isCheckResult(v: string): v is CheckResult {
  return v === "pass" || v === "fail" || v === "indeterminate";
}

// ---- Checks -----------------------------------------------------------------

export type CheckCategory =
  | "capability"
  | "provider"
  | "certification"
  | "coverage"
  | "pricing"
  | "policy"
  | "health";

/** A single explainable eligibility check outcome (WORK-009 §6, §19). */
export interface EligibilityCheck {
  /** Stable check identifier, e.g. "provider.status". */
  checkId: string;
  category: CheckCategory;
  result: CheckResult;
  expected: string | number | boolean | null;
  actual: string | number | boolean | null;
  reason: string;
  /** Evidence reference (fact id, observation id, policy rule ids). */
  evidence: string | null;
}

// ---- Request ----------------------------------------------------------------

/** Minimum implementation certification levels, ordered. */
export const CERTIFICATION_LEVELS = ["registered", "contract_verified", "certified"] as const;
export type RequiredCertification = (typeof CERTIFICATION_LEVELS)[number];

export type RequiredIntegrationPath = "platform_operated" | "provider_operated";

/**
 * The normalized eligibility request constraints (WORK-009 §5, §15) —
 * explicit, structured, caller-supplied. Eligibility never queries
 * arbitrary application state; everything it needs arrives here plus the
 * catalog/policy snapshots loaded by the service.
 */
export interface EligibilityRequestConstraints {
  // Required coverage (consumed from catalog coverage facts).
  country?: string;
  region?: string;
  currency?: string;
  // Hard cost constraint (compared against the candidate's per-request
  // pricing fact).
  maxEstimatedCost?: number;
  maxEstimatedCostCurrency?: string;
  // Certification requirements.
  requiredCertification?: RequiredCertification;
  requireLiveCertification?: boolean;
  // Integration path requirement.
  requiredIntegrationPath?: RequiredIntegrationPath;
  // Coverage provenance: verified/certified facts required.
  requireVerifiedCoverage?: boolean;
  // Health: reject unavailable candidates.
  requireHealthy?: boolean;
  // Request facts that flow into the POLICY evaluation context
  // (request-level attributes, not candidate attributes).
  privacyClass?: string;
  piiAllowed?: boolean;
  executionMode?: string;
  idempotentExecution?: boolean;
  estimatedCost?: number;
}

export interface EligibilityEvaluateInput {
  organizationId: string; // AUTHORIZED org id (orgContextMiddleware)
  projectId: string; // AUTHORIZED project id (projectContextMiddleware)
  capabilityId: string;
  capabilityVersion: string;
  policyId: string;
  /** Explicit version (reproducible) or omit → the ACTIVE effective version. */
  policyVersion?: string;
  /** Optional explicit candidate list (canonical provider ids). */
  providers?: string[];
  constraints: EligibilityRequestConstraints;
  actingPrincipal: { userId: string } & Record<string, unknown>;
}

// ---- Validation ----------------------------------------------------------------

const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const REGION_RE = /^[A-Z][A-Z0-9_]{1,23}$/;
const STRING_MAX = 512;
const MAX_PROVIDERS = 50;

/**
 * Validate and normalize caller-supplied constraints. Rejects anything
 * outside the constrained shape BEFORE evaluation (deterministic input
 * discipline; no code-execution surface — values are inert primitives).
 */
export function validateConstraints(input: unknown): EligibilityRequestConstraints {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw eligibilityValidation("constraints must be an object", { reason: "invalid_constraints" });
  }
  const raw = input as Record<string, unknown>;
  const out: EligibilityRequestConstraints = {};

  if (raw.country !== undefined && raw.country !== null && raw.country !== "") {
    const v = String(raw.country);
    if (!COUNTRY_RE.test(v)) {
      throw eligibilityValidation(`country must be two uppercase letters (got "${v}")`, { reason: "invalid_country" });
    }
    out.country = v;
  }
  if (raw.region !== undefined && raw.region !== null && raw.region !== "") {
    const v = String(raw.region);
    if (!REGION_RE.test(v)) {
      throw eligibilityValidation(`region must be an uppercase region slug (got "${v}")`, { reason: "invalid_region" });
    }
    out.region = v;
  }
  if (raw.currency !== undefined && raw.currency !== null && raw.currency !== "") {
    const v = String(raw.currency);
    if (!CURRENCY_RE.test(v)) {
      throw eligibilityValidation(`currency must be three uppercase letters (got "${v}")`, { reason: "invalid_currency" });
    }
    out.currency = v;
  }
  if (raw.max_estimated_cost !== undefined && raw.max_estimated_cost !== null) {
    const v = Number(raw.max_estimated_cost);
    if (!Number.isFinite(v) || v < 0) {
      throw eligibilityValidation("max_estimated_cost must be a finite non-negative number", { reason: "invalid_max_cost" });
    }
    out.maxEstimatedCost = v;
  }
  if (raw.max_estimated_cost_currency !== undefined && raw.max_estimated_cost_currency !== null && raw.max_estimated_cost_currency !== "") {
    const v = String(raw.max_estimated_cost_currency);
    if (!CURRENCY_RE.test(v)) {
      throw eligibilityValidation(`max_estimated_cost_currency must be three uppercase letters (got "${v}")`, { reason: "invalid_cost_currency" });
    }
    out.maxEstimatedCostCurrency = v;
  }
  if (raw.required_certification !== undefined && raw.required_certification !== null && raw.required_certification !== "") {
    const v = String(raw.required_certification);
    if (!(CERTIFICATION_LEVELS as readonly string[]).includes(v)) {
      throw eligibilityValidation(`required_certification must be one of ${CERTIFICATION_LEVELS.join("|")} (got "${v}")`, { reason: "invalid_certification" });
    }
    out.requiredCertification = v as RequiredCertification;
  }
  if (raw.require_live_certification !== undefined && raw.require_live_certification !== null) {
    if (typeof raw.require_live_certification !== "boolean") {
      throw eligibilityValidation("require_live_certification must be a boolean", { reason: "invalid_flag" });
    }
    out.requireLiveCertification = raw.require_live_certification;
  }
  if (raw.required_integration_path !== undefined && raw.required_integration_path !== null && raw.required_integration_path !== "") {
    const v = String(raw.required_integration_path);
    if (v !== "platform_operated" && v !== "provider_operated") {
      throw eligibilityValidation(`required_integration_path must be platform_operated or provider_operated (got "${v}")`, { reason: "invalid_integration_path" });
    }
    out.requiredIntegrationPath = v;
  }
  if (raw.require_verified_coverage !== undefined && raw.require_verified_coverage !== null) {
    if (typeof raw.require_verified_coverage !== "boolean") {
      throw eligibilityValidation("require_verified_coverage must be a boolean", { reason: "invalid_flag" });
    }
    out.requireVerifiedCoverage = raw.require_verified_coverage;
  }
  if (raw.require_healthy !== undefined && raw.require_healthy !== null) {
    if (typeof raw.require_healthy !== "boolean") {
      throw eligibilityValidation("require_healthy must be a boolean", { reason: "invalid_flag" });
    }
    out.requireHealthy = raw.require_healthy;
  }
  if (raw.privacy_class !== undefined && raw.privacy_class !== null && raw.privacy_class !== "") {
    out.privacyClass = boundedString(raw.privacy_class, "privacy_class");
  }
  if (raw.pii_allowed !== undefined && raw.pii_allowed !== null) {
    if (typeof raw.pii_allowed !== "boolean") {
      throw eligibilityValidation("pii_allowed must be a boolean", { reason: "invalid_flag" });
    }
    out.piiAllowed = raw.pii_allowed;
  }
  if (raw.execution_mode !== undefined && raw.execution_mode !== null && raw.execution_mode !== "") {
    out.executionMode = boundedString(raw.execution_mode, "execution_mode");
  }
  if (raw.idempotent_execution !== undefined && raw.idempotent_execution !== null) {
    if (typeof raw.idempotent_execution !== "boolean") {
      throw eligibilityValidation("idempotent_execution must be a boolean", { reason: "invalid_flag" });
    }
    out.idempotentExecution = raw.idempotent_execution;
  }
  if (raw.estimated_cost !== undefined && raw.estimated_cost !== null) {
    const v = Number(raw.estimated_cost);
    if (!Number.isFinite(v) || v < 0) {
      throw eligibilityValidation("estimated_cost must be a finite non-negative number", { reason: "invalid_cost" });
    }
    out.estimatedCost = v;
  }
  return out;
}

/** Validate the optional explicit provider list. */
export function validateProviders(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) {
    throw eligibilityValidation("providers must be an array of canonical provider ids", { reason: "invalid_providers" });
  }
  if (input.length === 0) return undefined;
  if (input.length > MAX_PROVIDERS) {
    throw eligibilityValidation(`providers may contain at most ${MAX_PROVIDERS} entries`, { reason: "too_many_providers" });
  }
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
      throw eligibilityValidation("each provider id must be a non-empty string", { reason: "invalid_provider_id" });
    }
    out.push(raw);
  }
  return out;
}

function boundedString(v: unknown, field: string): string {
  const s = String(v);
  if (s.length > STRING_MAX) {
    throw eligibilityValidation(`${field} exceeds ${STRING_MAX} characters`, { reason: "value_too_long" });
  }
  return s;
}

function eligibilityValidation(message: string, details: Record<string, unknown>): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "eligibility.validation",
    message,
    retryable: false,
    details,
  });
}
