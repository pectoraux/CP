// /eligibility/internal/service.ts
// EligibilityService — the /eligibility module's concrete service
// (WORK-009, architecture §10, §36). The deterministic candidate
// eligibility layer: it answers "Can candidate X satisfy the request
// under the applicable rules?" and NEVER chooses a winner (§2).
//
// Flow (§2): request → policy resolution → candidate enumeration →
// eligibility checks → results (eligible candidates for future
// strategy/routing).
//
// Layering:
//   - Policy semantics belong to /policies — this service loads the
//     (immutable) policy version through the PUBLIC policies interface
//     and delegates evaluation to the PUBLIC pure evaluator
//     (evaluateRules). No policy SQL here (§7).
//   - Marketplace facts belong to /catalog — candidates are enumerated
//     through the PUBLIC catalog offering projection (listOfferings).
//     No marketplace SQL is duplicated (§3-§4).
//   - Capability existence belongs to /capabilities — the public
//     getCapability/getVersion surface provides the top-level summary.
//   - The core evaluator (evaluator.ts) is PURE: no DB, no network, no
//     adapter invocation, no clock. This service only LOADS snapshots
//     and invokes it (§16).
//
// Tenancy (§24): every evaluation operates in the AUTHORIZED
// (organization, project) context resolved by the /api org/project
// middlewares — never raw request params. The service re-verifies
// server-side (the WORK-008 policies precedent): the acting principal
// must hold an ACTIVE membership in the organization, and the project
// must belong to it — resolved through the /projects PUBLIC interface
// (getProject), never raw cp_projects SQL (architect review of PR #8:
// /eligibility must not become a second project authority). The policy
// is loaded ONLY within that scope, so cross-tenant policy evaluation
// cannot resolve.
//
// Statelessness (§26): eligibility persists NOTHING — no tables, no
// candidate state, no cache. Each evaluation loads a fresh snapshot
// (policy version + offerings + capability summary) and produces a
// self-describing result (the snapshot section records what was
// evaluated — §17).

import {
  AppError,
  Logger,
  type LogSink,
  type LogRecord,
} from "@cp/platform";
import type { Principal } from "@cp/auth";
import { activeMembershipIn } from "@cp/auth";
import type { CapabilitiesService } from "@cp/capabilities";
import type { CatalogService, CatalogOffering } from "@cp/catalog";
import type { PoliciesService, PolicyRule } from "@cp/policies";
import type { ProjectsService } from "@cp/projects";
import {
  validateConstraints,
  validateProviders,
  type EligibilityRequestConstraints,
} from "./types.ts";
import {
  evaluateCandidate,
  candidateDeclarationMissing,
  candidateVersionUnsupported,
  type CandidateEligibility,
  type PolicyRef,
} from "./evaluator.ts";

// ---- Result types ------------------------------------------------------------

export interface CapabilitySummary {
  capabilityId: string;
  capabilityVersion: string;
  exists: boolean;
  versionExists: boolean;
  versionStatus: string | null;
  capabilityStatus: string | null;
}

export interface EligibilitySummary {
  evaluated: number;
  eligible: number;
  ineligible: number;
  indeterminate: number;
}

export interface EligibilityEvaluation {
  capability: CapabilitySummary;
  policy: {
    policyId: string;
    policyVersion: string;
  };
  results: CandidateEligibility[];
  summary: EligibilitySummary;
}

export interface EligibilityEvaluateInput {
  organizationId: string; // AUTHORIZED org id (orgContextMiddleware)
  projectId: string; // AUTHORIZED project id (projectContextMiddleware)
  capabilityId: string;
  capabilityVersion: string;
  policyId: string;
  /** Explicit version (reproducible) or omit → the ACTIVE effective version. */
  policyVersion?: string;
  /** Optional explicit candidate list (canonical provider ids; validated
   * by validateProviders — accepted raw from the transport body). */
  providers?: unknown;
  /** Raw request constraints (transport form) — validated and normalized
   * by validateConstraints before evaluation. */
  constraints: unknown;
  actingPrincipal: Principal;
}

export interface EligibilityServiceOptions {
  logger?: Logger;
  capabilities: CapabilitiesService;
  catalog: CatalogService;
  policies: PoliciesService;
  /** The projects public interface — project existence and tenant
   * ownership are resolved HERE (architect review of PR #8: /eligibility
   * must not query cp_projects directly and become a second project
   * authority). */
  projects: ProjectsService;
}

const NOOP_SINK: LogSink = {
  emit(_record: LogRecord): void {},
};

/** Safety cap for catalog pagination during enumeration. */
const MAX_ENUMERATION_PAGES = 100;

// ---- Service -------------------------------------------------------------------

export class EligibilityService {
  private readonly logger: Logger;
  private readonly capabilities: CapabilitiesService;
  private readonly catalog: CatalogService;
  private readonly policies: PoliciesService;
  private readonly projects: ProjectsService;

  constructor(opts: EligibilityServiceOptions) {
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
    this.capabilities = opts.capabilities;
    this.catalog = opts.catalog;
    this.policies = opts.policies;
    this.projects = opts.projects;
  }

  // ---- Tenancy + authorization (§24) ----------------------------------------

  /**
   * Verify the (organizationId, projectId) scope is real and belongs
   * together, and that the acting principal holds an ACTIVE membership
   * (any role — evaluation is a read). Project existence/ownership is
   * resolved through the /projects PUBLIC interface (getProject is the
   * org-scoped tenant query — architect review of PR #8: /eligibility
   * must not duplicate it with raw SQL). The same server-side pattern
   * the policies service uses (defense in depth on top of the /api
   * gates); no second tenant system is invented. A suspended/removed
   * member fails this check and loses eligibility access.
   */
  private async requireProjectScope(
    organizationId: string,
    projectId: string,
    principal: Principal,
  ): Promise<void> {
    const membership = activeMembershipIn(principal, organizationId);
    if (!membership) {
      throw policyBlocked("eligibility.membership.required", "an active membership in this organization is required", {
        reason: "not_a_member",
        organization_id: organizationId,
      });
    }
    const project = await this.projects.getProject(organizationId, projectId);
    if (!project) {
      throw notFound("eligibility.project.not_found", "the project does not exist in this organization", {
        project_id: projectId,
      });
    }
  }

  // ---- Policy resolution (§7: public interface only) ----------------------------

  /**
   * Resolve the policy version through the PUBLIC policies interface,
   * scoped to the authorized (org, project). Explicit version → any
   * lifecycle state (reproducible historical evaluation); omitted →
   * the ACTIVE effective version only. Cross-project/org policy ids
   * simply do not resolve (scoped queries return null).
   */
  private async resolvePolicy(
    organizationId: string,
    projectId: string,
    policyId: string,
    policyVersion: string | undefined,
  ): Promise<PolicyRef> {
    let version = null as Awaited<ReturnType<PoliciesService["getVersion"]>>;
    if (policyVersion !== undefined && policyVersion !== null && policyVersion !== "") {
      version = await this.policies.getVersion(organizationId, projectId, policyId, policyVersion);
      if (!version) {
        throw notFound("eligibility.policy.version_not_found", `policy version "${policyVersion}" was not found in this project`, {
          policy_id: policyId,
          policy_version: policyVersion,
        });
      }
    } else {
      const effective = await this.policies.getEffectiveVersion(organizationId, projectId, policyId);
      if (!effective) {
        throw policyBlocked("eligibility.policy.no_active_version", "the policy has no ACTIVE version — specify an explicit policy_version to evaluate", {
          reason: "no_active_version",
          policy_id: policyId,
        });
      }
      version = effective;
    }
    return {
      policyId,
      policyVersion: version.version,
      rules: version.rules as PolicyRule[],
    };
  }

  // ---- Candidate enumeration (§4: catalog public interface only) ------------------

  /**
   * Enumerate candidate offerings for the exact requested
   * capability+version (exact-version semantics from WORK-005/006 —
   * never name-only). include_inactive=true so lifecycle rejections are
   * EXPLAINABLE results rather than silent omissions; the pure
   * evaluator rejects suspended/deprecated/revoked providers and
   * retired versions with reasons.
   */
  private async enumerateCandidates(
    capabilityId: string,
    capabilityVersion: string | undefined,
    providerId?: string,
  ): Promise<CatalogOffering[]> {
    const offerings: CatalogOffering[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      pages += 1;
      if (pages > MAX_ENUMERATION_PAGES) {
        throw platformFailure(
          "eligibility.enumeration.exceeded",
          `candidate enumeration exceeded ${MAX_ENUMERATION_PAGES} pages — refusing to silently truncate`,
        );
      }
      const page = await this.catalog.listOfferings({
        capabilityId,
        capabilityVersion,
        providerId,
        includeInactive: true,
        limit: 100,
        cursor,
      });
      offerings.push(...page.offerings);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return offerings;
  }

  // ---- Evaluation -------------------------------------------------------------------

  /**
   * Evaluate eligibility for every candidate offering of the requested
   * capability+version under the resolved policy version and the
   * caller-supplied request constraints. Deterministic: the output is a
   * pure function of (policy rules, offerings snapshot, constraints);
   * results are ordered by stable offering id (§21 — identifier
   * ordering only, never ranking).
   */
  async evaluate(input: EligibilityEvaluateInput): Promise<EligibilityEvaluation> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal);
    const constraints = validateConstraints(input.constraints);
    const providers = validateProviders(input.providers);

    // 1. Resolve the policy version (tenant-scoped public interface).
    const policy = await this.resolvePolicy(
      input.organizationId,
      input.projectId,
      input.policyId,
      input.policyVersion,
    );

    // 2. Capability summary (public capabilities interface — explains a
    //    zero-candidate result at the API level).
    const capability = await this.capabilities.getCapability(input.capabilityId);
    const version = capability
      ? await this.capabilities.getVersion(input.capabilityId, input.capabilityVersion)
      : null;
    const capabilitySummary: CapabilitySummary = {
      capabilityId: input.capabilityId,
      capabilityVersion: input.capabilityVersion,
      exists: capability !== null,
      versionExists: version !== null,
      versionStatus: version ? version.status : null,
      capabilityStatus: capability ? capability.status : null,
    };

    // 3. Enumerate + evaluate candidates.
    const results: CandidateEligibility[] = [];
    if (providers !== undefined) {
      // Named-candidate mode: evaluate each named provider precisely;
      // missing declarations/version support produce explainable
      // synthetic rejections (§28).
      for (const providerId of providers) {
        const exact = await this.enumerateCandidates(input.capabilityId, input.capabilityVersion, providerId);
        if (exact.length > 0) {
          for (const offering of exact) {
            results.push(evaluateCandidate({ offering, constraints, policy }));
          }
          continue;
        }
        // No exact-version offering: does the provider declare the
        // capability at ANY version?
        const anyVersion = await this.enumerateCandidates(input.capabilityId, undefined, providerId);
        if (anyVersion.length > 0) {
          const declaredVersions = anyVersion.map((o) => o.capability.capabilityVersion);
          results.push(candidateVersionUnsupported(providerId, policy, declaredVersions));
        } else {
          results.push(candidateDeclarationMissing(providerId, policy));
        }
      }
    } else {
      const offerings = await this.enumerateCandidates(input.capabilityId, input.capabilityVersion);
      for (const offering of offerings) {
        results.push(evaluateCandidate({ offering, constraints, policy }));
      }
      // Stable identifier ordering (§21 — semantically meaningless to
      // the decision, purely deterministic).
      results.sort((a, b) => (a.candidate.offeringId < b.candidate.offeringId ? -1 : a.candidate.offeringId > b.candidate.offeringId ? 1 : 0));
    }

    const summary: EligibilitySummary = {
      evaluated: results.length,
      eligible: results.filter((r) => r.status === "eligible").length,
      ineligible: results.filter((r) => r.status === "ineligible").length,
      indeterminate: results.filter((r) => r.status === "indeterminate").length,
    };

    // Observability (architect review of PR #8): no fabricated
    // request_id — request correlation belongs to the /api correlation
    // middleware, which already attaches the real request id to the
    // logging context.
    this.logger.info("eligibility: evaluated", {
      organization_id: input.organizationId,
      project_id: input.projectId,
      capability_id: input.capabilityId,
      capability_version: input.capabilityVersion,
      policy_id: policy.policyId,
      policy_version: policy.policyVersion,
      evaluated: summary.evaluated,
      eligible: summary.eligible,
      ineligible: summary.ineligible,
      indeterminate: summary.indeterminate,
      user_id: input.actingPrincipal.userId,
    });

    return {
      capability: capabilitySummary,
      policy: { policyId: policy.policyId, policyVersion: policy.policyVersion },
      results,
      summary,
    };
  }
}

// ---- Error helpers -----------------------------------------------------------------

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
