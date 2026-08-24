// /api/internal/handlers-eligibility.ts
// WORK-009 transport routes for /eligibility (architecture §10, §23,
// §35, §36, lock §8, §9, WORK-009 §20). The API layer is a transport
// boundary only: it imports only the PUBLIC interface of
// @cp/eligibility (and @cp/platform for the runtime, @cp/auth for the
// Principal), never any module's internals. Authorization happens at
// the domain service boundary (EligibilityService re-verifies active
// membership + project scope server-side) on top of the standard
// WORK-004 tenant gates.
//
// Route (project-scoped — the policy being consumed is tenant-scoped
// under Organization → Project, so eligibility operates in the same
// authorized org/project context):
//   POST /v1/organizations/:orgId/projects/:projectId/eligibility/evaluate
//
// Accepts: capability_id, capability_version, policy_id, optional
// policy_version (explicit → reproducible; omitted → the ACTIVE
// effective version), optional providers[] (named-candidate mode), and
// a constraints context (country/region/currency, max_estimated_cost,
// certification requirements, integration path, coverage provenance,
// health, request facts for the policy context).
//
// Returns: capability summary, resolved policy version, per-candidate
// results (status eligible|ineligible|indeterminate + explainable
// checks + policy result + snapshot), and counts. NO ranking, NO
// winner, NO scores — the next layer decides.
//
// Evaluation mutates no state; the endpoint follows the WORK-008
// evaluate precedent and supports Idempotency-Key replay. No provider
// secrets are exposed (credential-requirement names never appear in
// eligibility output at all).

import { Hono } from "hono";
import type { Runtime } from "@cp/platform";
import type { AuthService } from "@cp/auth";
import type { Principal } from "@cp/auth";
import type { OrganizationsService } from "@cp/organizations";
import type { ProjectsService } from "@cp/projects";
import {
  EligibilityService,
  type CandidateEligibility,
  type EligibilityEvaluation,
} from "@cp/eligibility";
import {
  authMiddleware,
  orgContextMiddleware,
  projectContextMiddleware,
  type AuthVars,
} from "./middleware.ts";
import { IdempotencyStore, withIdempotency } from "./idempotency.ts";

export interface EligibilityRouteDeps {
  runtime: Runtime;
  auth: AuthService;
  orgs: OrganizationsService;
  projects: ProjectsService;
  eligibility: EligibilityService;
  idempotency: IdempotencyStore;
}

export function createEligibilityRoutes(
  deps: EligibilityRouteDeps,
  app: Hono<{ Variables: AuthVars }>,
): void {
  const { runtime, auth, orgs, projects, eligibility, idempotency } = deps;

  const base = "/v1/organizations/:orgId/projects/:projectId/eligibility";

  app.post(
    `${base}/evaluate`,
    authMiddleware(runtime, auth, orgs),
    orgContextMiddleware(runtime, orgs),
    projectContextMiddleware(runtime, projects),
    async (c) => {
      const orgCtx = c.get("orgContext")!;
      const pctx = c.get("projectContext")!;
      return withIdempotency(c, idempotency, orgCtx.principal, async (body) => {
        const capabilityId = String(body?.capability_id ?? "").trim();
        const capabilityVersion = String(body?.capability_version ?? "").trim();
        const policyId = String(body?.policy_id ?? "").trim();
        if (!capabilityId || !capabilityVersion || !policyId) {
          return validationError(c, "capability_id, capability_version, and policy_id are required");
        }
        const policyVersionRaw = body?.policy_version;
        const policyVersion =
          policyVersionRaw === undefined || policyVersionRaw === null || policyVersionRaw === ""
            ? undefined
            : String(policyVersionRaw);
        const providersRaw = body?.providers;
        const providers =
          providersRaw === undefined || providersRaw === null
            ? undefined
            : (Array.isArray(providersRaw) ? (providersRaw as unknown[]) : undefined);
        const evaluation = await eligibility.evaluate({
          organizationId: orgCtx.organizationId,
          projectId: pctx.projectId,
          capabilityId,
          capabilityVersion,
          policyId,
          policyVersion,
          providers,
          constraints: body?.context ?? {},
          actingPrincipal: orgCtx.principal,
        });
        return c.json({ eligibility: serializeEvaluation(evaluation) });
      });
    },
  );

  void (null as unknown as Principal);
}

// ---- Serializers (explicit allowlist; no secrets, no ranking) ------------------

function serializeEvaluation(e: EligibilityEvaluation) {
  return {
    capability: {
      capability_id: e.capability.capabilityId,
      capability_version: e.capability.capabilityVersion,
      exists: e.capability.exists,
      version_exists: e.capability.versionExists,
      version_status: e.capability.versionStatus,
      capability_status: e.capability.capabilityStatus,
    },
    policy: {
      policy_id: e.policy.policyId,
      policy_version: e.policy.policyVersion,
    },
    results: e.results.map(serializeResult),
    summary: {
      evaluated: e.summary.evaluated,
      eligible: e.summary.eligible,
      ineligible: e.summary.ineligible,
      indeterminate: e.summary.indeterminate,
    },
  };
}

function serializeResult(r: CandidateEligibility) {
  return {
    candidate: {
      offering_id: r.candidate.offeringId,
      provider: {
        provider_id: r.candidate.provider.providerId,
        name: r.candidate.provider.name,
        status: r.candidate.provider.status,
        integration_path: r.candidate.provider.integrationPath,
      },
      capability: {
        capability_id: r.candidate.capability.capabilityId,
        capability_version: r.candidate.capability.capabilityVersion,
        capability_status: r.candidate.capability.capabilityStatus,
        version_status: r.candidate.capability.versionStatus,
      },
      implementation: {
        adapter_version: r.candidate.implementation.adapterVersion,
        status: r.candidate.implementation.status,
        certification_environment: r.candidate.implementation.certificationEnvironment,
      },
    },
    status: r.status,
    checks: r.checks.map(serializeCheck),
    failures: r.failures.map(serializeCheck),
    indeterminate: r.indeterminate.map(serializeCheck),
    satisfied: r.satisfied.map(serializeCheck),
    policy: r.policy
      ? {
          policy_id: r.policy.policyId,
          policy_version: r.policy.policyVersion,
          hard_passed: r.policy.hardPassed,
          hard_violations: r.policy.hardViolations.map((v) => ({
            rule_id: v.ruleId,
            subject: v.subject,
            operator: v.operator,
            mode: v.mode,
            result: v.result,
            expected: v.expected,
            actual: v.actual,
            reason: v.reason,
          })),
          // Preferences are exposed for downstream strategy — they NEVER
          // affected eligibility (WORK-009 §8).
          preference_satisfied: r.policy.preferenceSatisfied.map((v) => v.ruleId),
          preference_violated: r.policy.preferenceViolated.map((v) => v.ruleId),
        }
      : null,
    snapshot: {
      policy_id: r.snapshot.policyId,
      policy_version: r.snapshot.policyVersion,
      offering_id: r.snapshot.offeringId,
      provider_status: r.snapshot.providerStatus,
      implementation_status: r.snapshot.implementationStatus,
      certification_environment: r.snapshot.certificationEnvironment,
      pricing_fact: r.snapshot.pricingFact,
      per_request_pricing_fact: r.snapshot.perRequestPricingFact,
      health_observation: r.snapshot.healthObservation,
    },
  };
}

function serializeCheck(check: {
  checkId: string;
  category: string;
  result: string;
  expected: string | number | boolean | null;
  actual: string | number | boolean | null;
  reason: string;
  evidence: string | null;
}) {
  return {
    check_id: check.checkId,
    category: check.category,
    result: check.result,
    expected: check.expected,
    actual: check.actual,
    reason: check.reason,
    evidence: check.evidence,
  };
}

function validationError(c: { json: (b: unknown, s: number) => Response; get: (k: "requestId") => string }, message: string): Response {
  return c.json(
    {
      error: {
        category: "POLICY_BLOCKED",
        code: "eligibility.validation",
        message,
        retryable: false,
        request_id: c.get("requestId"),
      },
    },
    400,
  );
}
