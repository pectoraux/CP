// /providers/internal/service.ts
// ProvidersService — the /providers module's concrete service (WORK-006,
// architecture §7, §8, §32, lock §7). Owns:
//   - provider identity and lifecycle (cp_providers) — global CP-level
//     records, canonical ids like `paystack` / `demo.echo`
//   - provider-capability implementation declarations
//     (cp_provider_capabilities) — "provider P implements capability C at
//     EXACTLY version V via adapter version A"
//   - certification evidence (cp_provider_certification_evidence) —
//     append-only, environment-qualified (fixture | live)
//
// Authority (WORK-006 §3, §11): provider records are GLOBAL (a provider
// such as OpenAI is not owned by an organization); tenant-scoped
// CONNECTIONS and credentials belong to WORK-010. Mutations require the
// SAME CP-level platform-admin grant that gates the capability catalog
// (capability.manage — established in WORK-005): the provider registry is
// CP-level infrastructure, and an arbitrary org owner/admin cannot mutate
// it (proven in tests/security/provider-authority). Reads are
// authenticated-only.
//
// Capability compatibility (WORK-006 §12): a declaration is validated
// against the AUTHORITATIVE capability catalog via the /capabilities
// public interface — the capability must exist, the version must exist,
// and the version must not be retired. Compatibility is contract/version
// based, never name-based. If a platform adapter is registered for the
// provider, its declared capability versions must match the declaration.
//
// Certification (architecture §32, WORK-006 §13, §14): certification is
// EVIDENCE-BACKED. `runContractTests` executes the deterministic contract
// suite through the adapter, persists every outcome as an evidence row
// (test, result, capability, provider, adapter version, timestamp,
// environment, artifact reference), and advances declaration
// certification state ONLY when the evidence supports it:
//   registered → contract_verified  (gate tests pass; any environment)
//   contract_verified → certified   (ALL tests pass AND environment=live)
// A fixture adapter can therefore produce contract verification but can
// NEVER produce live certification — "contract verified" and "live
// provider certified" are distinct, and a mock is never a live
// certification.
//
// PostgreSQL is authoritative (lock §1). The service depends ONLY on the
// provider-neutral platform `Database` interface; `/capabilities` is
// consumed through its public interface (legal direction: providers →
// capabilities — the capability graph is upstream of providers).

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
import {
  type CapabilitiesService,
  type CapabilityVersion,
} from "@cp/capabilities";
import type { CredentialRequirement } from "@cp/credentials";
import {
  validateProviderId,
  validateAdapterVersion,
} from "./identifiers.ts";
import {
  AdapterRegistry,
  type AdapterEnvironment,
  type IntegrationPath,
  type ProviderAdapter,
} from "./adapter.ts";
import {
  runAdapterContractTests,
  type ContractTestOutcome,
} from "./contract-tests.ts";

// ---- Lifecycle (frozen architecture §7) --------------------------------

export type ProviderStatus =
  | "discovered"
  | "integrating"
  | "contract_tested"
  | "observed"
  | "certified"
  | "active"
  | "suspended"
  | "deprecated"
  | "revoked";

export const PROVIDER_STATUSES: readonly ProviderStatus[] = [
  "discovered",
  "integrating",
  "contract_tested",
  "observed",
  "certified",
  "active",
  "suspended",
  "deprecated",
  "revoked",
] as const;

/**
 * Valid lifecycle transitions (frozen §7 pipeline with operational
 * off-ramps; REVOKED is terminal). `contract_tested` and `certified` are
 * EVIDENCE-GATED by the service (see transitionProvider) — the map below
 * is the structural graph; the evidence gates are enforced on top.
 */
export const PROVIDER_LIFECYCLE_TRANSITIONS: ReadonlyMap<
  ProviderStatus,
  readonly ProviderStatus[]
> = new Map([
  ["discovered", ["integrating", "revoked"]],
  ["integrating", ["contract_tested", "discovered", "revoked"]],
  ["contract_tested", ["observed", "revoked"]],
  ["observed", ["certified", "revoked"]],
  ["certified", ["active", "revoked"]],
  ["active", ["suspended", "deprecated"]],
  ["suspended", ["active", "deprecated", "revoked"]],
  ["deprecated", ["revoked"]],
  ["revoked", []],
]);

export function isProviderStatus(v: string): v is ProviderStatus {
  return (PROVIDER_STATUSES as readonly string[]).includes(v);
}

/** Declaration certification state (evidence-driven, never manual). */
export type ImplementationStatus =
  | "registered"
  | "contract_verified"
  | "certified";

// ---- Record types --------------------------------------------------------

export interface Provider {
  id: string; // internal surrogate (prov_<ulid>)
  providerId: string; // canonical 'demo.echo'
  name: string;
  description: string;
  status: ProviderStatus;
  integrationPath: IntegrationPath;
  documentationUrl: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderCapability {
  id: string; // internal surrogate (provcap_<ulid>)
  providerId: string; // internal surrogate of the provider
  providerCanonicalId: string; // denormalized canonical 'demo.echo'
  capabilityId: string; // internal surrogate of the capability
  capabilityCanonicalId: string; // canonical 'demo.echo' capability
  capabilityVersion: string;
  adapterVersion: string;
  status: ImplementationStatus;
  certificationEnvironment: "none" | AdapterEnvironment;
  supportedConstraints: Record<string, unknown>;
  credentialRequirements: CredentialRequirement[];
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CertificationEvidenceRecord {
  id: string;
  providerCapabilityId: string;
  capabilityCanonicalId: string;
  capabilityVersion: string;
  testName: string;
  result: "pass" | "fail";
  environment: AdapterEnvironment;
  adapterVersion: string;
  artifactRef: string | null;
  detail: Record<string, unknown>;
  createdByUserId: string;
  createdAt: Date;
}

// ---- Inputs ---------------------------------------------------------------

export interface CreateProviderInput {
  providerId: string;
  name: string;
  description?: string;
  integrationPath?: IntegrationPath;
  documentationUrl?: string;
  actingPrincipal: Principal;
}

export interface ListProvidersOptions {
  limit?: number;
  cursor?: string | null;
  status?: ProviderStatus;
}

export interface ProviderPage {
  providers: Provider[];
  nextCursor: string | null;
}

export interface TransitionProviderInput {
  providerId: string;
  toStatus: ProviderStatus;
  actingPrincipal: Principal;
}

export interface DeclareCapabilityInput {
  providerId: string;
  capabilityId: string; // canonical capability id
  capabilityVersion: string;
  adapterVersion?: string; // defaults to the registered adapter's version
  supportedConstraints?: Record<string, unknown>;
  actingPrincipal: Principal;
}

export interface RunContractTestsInput {
  providerId: string;
  actingPrincipal: Principal;
}

export interface RunContractTestsResult {
  environment: AdapterEnvironment;
  adapterVersion: string;
  declarationResults: {
    capabilityId: string;
    capabilityVersion: string;
    statusBefore: ImplementationStatus;
    statusAfter: ImplementationStatus;
    outcomes: ContractTestOutcome[];
  }[];
  evidenceIds: string[];
}

export interface ProvidersServiceOptions {
  db: Database;
  logger?: Logger;
  /** The capability catalog (public /capabilities interface). */
  capabilities: CapabilitiesService;
  /** Registry of available provider adapters. */
  adapters: AdapterRegistry;
}

const NOOP_SINK: LogSink = {
  emit(_record: LogRecord): void {},
};

// ---- Service ---------------------------------------------------------------

export class ProvidersService {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly capabilities: CapabilitiesService;
  private readonly adapters: AdapterRegistry;

  constructor(opts: ProvidersServiceOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
    this.capabilities = opts.capabilities;
    this.adapters = opts.adapters;
  }

  // ---- Authority ---------------------------------------------------------

  /**
   * Mutations of the global provider registry require the CP-level
   * capability-admin grant (capability.manage) — the same platform-operator
   * authority that gates the global capability catalog (WORK-005 §22).
   * Provider registry mutation is a CP-level platform operation, NOT a
   * tenant operation: an arbitrary org owner/admin is refused (proven in
   * tests/security/provider-authority).
   */
  private async requireRegistryAdmin(principal: Principal): Promise<void> {
    const ok = await this.capabilities.isCapabilityAdmin(principal.userId);
    if (!ok) {
      throw policyBlocked("provider.admin.required", "capability.manage authority is required for provider registry mutations", {
        reason: "not_a_registry_admin",
        user_id: principal.userId,
      });
    }
  }

  // ---- Provider identity --------------------------------------------------

  async createProvider(input: CreateProviderInput): Promise<Provider> {
    await this.requireRegistryAdmin(input.actingPrincipal);
    const providerId = validateProviderId(input.providerId);
    const name = (typeof input.name === "string" ? input.name : "").trim();
    if (name.length === 0) {
      throw policyBlocked("provider.validation", "provider name is required", {
        reason: "missing_name",
      });
    }
    const description =
      typeof input.description === "string" ? input.description.trim() : "";
    const integrationPath: IntegrationPath =
      input.integrationPath ?? "platform_operated";
    const documentationUrl =
      typeof input.documentationUrl === "string" && input.documentationUrl.trim().length > 0
        ? input.documentationUrl.trim()
        : null;

    // If a platform adapter is registered under this provider id, keep the
    // registry record consistent with the adapter descriptor (same
    // integration path). Provider-operated integrations (frozen §8.2) may
    // register without a platform-side adapter.
    const adapter = this.adapters.get(providerId);
    if (adapter) {
      const d = adapter.descriptor();
      if (d.integrationPath !== integrationPath) {
        throw policyBlocked("provider.validation", `the registered adapter for "${providerId}" declares integration path "${d.integrationPath}"`, {
          reason: "integration_path_mismatch",
          adapter_integration_path: d.integrationPath,
        });
      }
    }

    const id = `prov_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_providers
                 (id, provider_id, name, description, status, integration_path, documentation_url, created_by_user_id)
               VALUES ($1, $2, $3, $4, 'discovered', $5, $6, $7)`,
        params: [id, providerId, name, description, integrationPath, documentationUrl, input.actingPrincipal.userId],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("provider.duplicate", "a provider with this id already exists", {
          reason: "duplicate_provider_id",
          provider_id: providerId,
        });
      }
      throw err;
    }
    this.logger.info("providers: created provider", {
      provider_id: providerId,
      integration_path: integrationPath,
      has_adapter: adapter !== undefined,
      actor: input.actingPrincipal.userId,
    });
    const created = await this.getProvider(providerId);
    if (!created) {
      throw platformFailure("provider.create.readback", "provider creation succeeded but the row could not be read back");
    }
    return created;
  }

  async getProvider(canonicalId: string): Promise<Provider | null> {
    const rows = await this.db.query({
      text: `SELECT * FROM cp_providers WHERE lower(provider_id) = lower($1)`,
      params: [canonicalId],
    });
    const row = rows[0];
    return row ? mapProvider(row as ProviderRow) : null;
  }

  async listProviders(opts: ListProvidersOptions = {}): Promise<ProviderPage> {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    if (opts.cursor) {
      params.push(opts.cursor);
      where.push(`id < $${params.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await this.db.query({
      text: `SELECT * FROM cp_providers ${whereSql}
             ORDER BY id DESC LIMIT ${limit + 1}`,
      params,
    });
    const all = rows.map((r) => mapProvider(r as ProviderRow));
    const page = all.slice(0, limit);
    const nextCursor = all.length > limit ? page[page.length - 1]!.id : null;
    return { providers: page, nextCursor };
  }

  /**
   * Transition the provider lifecycle (frozen §7). Two transitions are
   * EVIDENCE-GATED (architecture §32: certification is evidence-backed;
   * WORK-006 §13: certification must produce evidence):
   *   → contract_tested: at least one declaration exists AND every
   *     declaration is at least contract_verified.
   *   → certified: at least one declaration is 'certified' — which by
   *     construction required LIVE evidence (fixture runs cap at
   *     contract_verified). Unreachable until a live adapter exists.
   */
  async transitionProvider(input: TransitionProviderInput): Promise<Provider> {
    await this.requireRegistryAdmin(input.actingPrincipal);
    const provider = await this.getProvider(input.providerId);
    if (!provider) {
      throw notFound("provider.not_found", `provider "${input.providerId}" was not found`);
    }
    const to = input.toStatus;
    if (!isProviderStatus(to)) {
      throw policyBlocked("provider.validation", `unknown provider status "${String(to)}"`, { reason: "invalid_status" });
    }
    const allowed = PROVIDER_LIFECYCLE_TRANSITIONS.get(provider.status) ?? [];
    if (!allowed.includes(to)) {
      throw policyBlocked("provider.transition.invalid", `provider cannot transition from "${provider.status}" to "${to}"`, {
        reason: "invalid_transition",
        from: provider.status,
        to,
        allowed,
      });
    }
    if (to === "contract_tested") {
      const declarations = await this.listProviderCapabilities(provider.providerId);
      if (declarations.length === 0) {
        throw policyBlocked("provider.transition.gate", "contract_tested requires at least one capability declaration", {
          reason: "no_declarations",
        });
      }
      const notVerified = declarations.filter((d) => d.status === "registered");
      if (notVerified.length > 0) {
        throw policyBlocked("provider.transition.gate", "contract_tested requires every declaration to be at least contract_verified (passing contract-test evidence)", {
          reason: "declaration_not_verified",
          unverified: notVerified.map((d) => `${d.capabilityCanonicalId}@${d.capabilityVersion}`),
        });
      }
    }
    if (to === "certified") {
      const declarations = await this.listProviderCapabilities(provider.providerId);
      const certified = declarations.filter((d) => d.status === "certified");
      if (certified.length === 0) {
        throw policyBlocked("provider.transition.gate", "certified requires at least one certified capability implementation (live evidence)", {
          reason: "no_certified_implementation",
        });
      }
    }
    await this.db.exec({
      text: `UPDATE cp_providers SET status = $1, updated_at = NOW()
             WHERE id = $2`,
      params: [to, provider.id],
    });
    this.logger.info("providers: transitioned provider", {
      provider_id: provider.providerId,
      from: provider.status,
      to,
      actor: input.actingPrincipal.userId,
    });
    const updated = await this.getProvider(provider.providerId);
    if (!updated) {
      throw platformFailure("provider.transition.readback", "transition succeeded but the row could not be read back");
    }
    return updated;
  }

  // ---- Provider capability declarations -----------------------------------

  /**
   * Declare that a provider implements a capability at an EXACT version.
   * Compatibility is contract/version based (WORK-006 §12): the capability
   * must exist in the authoritative catalog, the version must exist and
   * not be retired, and — when a platform adapter is registered — the
   * adapter must declare exactly this capability+version. Credential
   * REQUIREMENTS (metadata) are persisted from the adapter descriptor;
   * secret values never enter this table.
   */
  async declareProviderCapability(input: DeclareCapabilityInput): Promise<ProviderCapability> {
    await this.requireRegistryAdmin(input.actingPrincipal);
    const provider = await this.getProvider(input.providerId);
    if (!provider) {
      throw notFound("provider.not_found", `provider "${input.providerId}" was not found`);
    }
    if (provider.status === "revoked") {
      throw policyBlocked("provider.revoked", "a revoked provider cannot declare new capabilities", {
        reason: "provider_revoked",
      });
    }

    // Capability/version compatibility against the AUTHORITATIVE catalog.
    const capability = await this.capabilities.getCapability(input.capabilityId);
    if (!capability) {
      throw policyBlocked("provider.capability.unknown", `capability "${input.capabilityId}" does not exist in the catalog`, {
        reason: "capability_not_found",
        capability_id: input.capabilityId,
      });
    }
    if (capability.status === "retired") {
      throw policyBlocked("provider.capability.retired", `capability "${input.capabilityId}" is retired`, {
        reason: "capability_retired",
        capability_id: input.capabilityId,
      });
    }
    const version = await this.capabilities.getVersion(input.capabilityId, input.capabilityVersion);
    if (!version) {
      throw policyBlocked("provider.capability.version_unknown", `capability "${input.capabilityId}" has no version "${input.capabilityVersion}"`, {
        reason: "capability_version_not_found",
        capability_id: input.capabilityId,
        capability_version: input.capabilityVersion,
      });
    }
    if (version.status === "retired") {
      throw policyBlocked("provider.capability.version_retired", `capability "${input.capabilityId}" version "${input.capabilityVersion}" is retired`, {
        reason: "capability_version_retired",
        capability_id: input.capabilityId,
        capability_version: input.capabilityVersion,
      });
    }

    // Adapter consistency: when a platform adapter is registered for this
    // provider, it must declare exactly this capability + version, and the
    // declaration inherits the adapter's version + credential requirements.
    const adapter = this.adapters.get(provider.providerId);
    let adapterVersion: string;
    let credentialRequirements: CredentialRequirement[];
    if (adapter) {
      const d = adapter.descriptor();
      const decl = d.capabilities.find((c) => c.capabilityId === input.capabilityId);
      if (!decl) {
        throw policyBlocked("provider.capability.unsupported", `the registered adapter for "${provider.providerId}" does not implement capability "${input.capabilityId}"`, {
          reason: "adapter_capability_mismatch",
          adapter_declared: d.capabilities.map((c) => c.capabilityId),
        });
      }
      if (!decl.capabilityVersions.includes(input.capabilityVersion)) {
        throw policyBlocked("provider.capability.unsupported", `the registered adapter for "${provider.providerId}" implements ${input.capabilityId} at version(s) ${decl.capabilityVersions.join(", ")} — not "${input.capabilityVersion}"`, {
          reason: "adapter_version_mismatch",
          adapter_declared_versions: decl.capabilityVersions,
        });
      }
      adapterVersion = validateAdapterVersion(input.adapterVersion ?? d.adapterVersion);
      credentialRequirements = d.credentialRequirements;
    } else {
      // Provider-operated registry-only declaration (frozen §8.2): the
      // adapter arrives later; the declaration records what the provider
      // claims. Claims remain claims until verified/certified.
      if (!input.adapterVersion) {
        throw policyBlocked("provider.validation", "adapter_version is required when no platform adapter is registered for this provider", {
          reason: "missing_adapter_version",
        });
      }
      adapterVersion = validateAdapterVersion(input.adapterVersion);
      credentialRequirements = [];
    }

    const supportedConstraints =
      input.supportedConstraints && typeof input.supportedConstraints === "object"
        ? input.supportedConstraints
        : {};

    const id = `provcap_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_provider_capabilities
                 (id, provider_id, capability_id, capability_version, adapter_version,
                  status, certification_environment, supported_constraints,
                  credential_requirements, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5, 'registered', 'none', $6::jsonb, $7::jsonb, $8)`,
        params: [
          id,
          provider.id,
          capability.id,
          input.capabilityVersion,
          adapterVersion,
          JSON.stringify(supportedConstraints),
          JSON.stringify(credentialRequirements),
          input.actingPrincipal.userId,
        ],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("provider.capability.duplicate", "this provider already declares this capability version", {
          reason: "duplicate_declaration",
          provider_id: provider.providerId,
          capability_id: input.capabilityId,
          capability_version: input.capabilityVersion,
        });
      }
      throw err;
    }
    this.logger.info("providers: declared capability implementation", {
      provider_id: provider.providerId,
      capability_id: input.capabilityId,
      capability_version: input.capabilityVersion,
      adapter_version: adapterVersion,
      credential_requirement_names: credentialRequirements.map((r) => r.name),
      actor: input.actingPrincipal.userId,
    });
    const created = await this.getDeclarationById(id);
    if (!created) {
      throw platformFailure("provider.declare.readback", "declaration creation succeeded but the row could not be read back");
    }
    return created;
  }

  async listProviderCapabilities(canonicalProviderId: string): Promise<ProviderCapability[]> {
    const provider = await this.getProvider(canonicalProviderId);
    if (!provider) {
      throw notFound("provider.not_found", `provider "${canonicalProviderId}" was not found`);
    }
    const rows = await this.db.query({
      text: `SELECT pc.*, c.capability_id AS capability_canonical_id,
                    p.provider_id AS provider_canonical_id
             FROM cp_provider_capabilities pc
             JOIN cp_capabilities c ON c.id = pc.capability_id
             JOIN cp_providers p ON p.id = pc.provider_id
             WHERE pc.provider_id = $1
             ORDER BY pc.created_at DESC, pc.id DESC`,
      params: [provider.id],
    });
    return rows.map((r) => mapDeclaration(r as DeclarationRow));
  }

  // ---- Certification ------------------------------------------------------

  /**
   * Run the deterministic adapter contract suite for every declaration of
   * a provider, persist every outcome as certification EVIDENCE, and
   * advance declaration certification state where the evidence supports
   * it — all within one transaction (evidence + state move together).
   *
   * Certification boundaries (WORK-006 §14):
   *   - evidence environment comes from the ADAPTER (fixture | live); a
   *     fixture run can advance a declaration to contract_verified but
   *     NEVER to certified
   *   - every outcome (pass AND fail) is persisted — failures are
   *     evidence too
   */
  async runContractTests(input: RunContractTestsInput): Promise<RunContractTestsResult> {
    await this.requireRegistryAdmin(input.actingPrincipal);
    const provider = await this.getProvider(input.providerId);
    if (!provider) {
      throw notFound("provider.not_found", `provider "${input.providerId}" was not found`);
    }
    const adapter = this.adapters.get(provider.providerId);
    if (!adapter) {
      throw policyBlocked("provider.adapter.missing", `no adapter is registered for provider "${provider.providerId}" — contract tests require a registered adapter`, {
        reason: "no_adapter",
      });
    }
    const declarations = await this.listProviderCapabilities(provider.providerId);
    if (declarations.length === 0) {
      throw policyBlocked("provider.declarations.missing", `provider "${provider.providerId}" has no capability declarations to test`, {
        reason: "no_declarations",
      });
    }

    // Execute the suite OUTSIDE the transaction (reads + adapter
    // invocations only — no writes), then persist atomically.
    const run = await runAdapterContractTests({
      adapter,
      declarations: declarations.map((d) => ({
        capabilityId: d.capabilityCanonicalId,
        capabilityVersion: d.capabilityVersion,
        persistedCredentialRequirements: d.credentialRequirements,
      })),
      getCapabilityVersion: (canonicalId, version) =>
        this.capabilities.getVersion(canonicalId, version),
      // Contract tests use a deterministic STATIC credential — secret
      // values never touch the registry, the logs, or the evidence rows.
      credentials: {
        resolve: async (name: string) => {
          void name;
          return { name, value: "fixture-contract-test-credential" };
        },
      },
      logger: this.logger,
    });

    const evidenceIds: string[] = [];
    const declarationResults: RunContractTestsResult["declarationResults"] = [];

    await this.db.transaction(async (tx) => {
      for (const result of run.declarationResults) {
        const declaration = declarations.find(
          (d) =>
            d.capabilityCanonicalId === result.declaration.capabilityId &&
            d.capabilityVersion === result.declaration.capabilityVersion,
        )!;
        // Evidence rows for EVERY outcome (pass and fail alike).
        for (const outcome of result.outcomes) {
          const evidenceId = `evid_${ulid()}`;
          evidenceIds.push(evidenceId);
          await tx.exec({
            text: `INSERT INTO cp_provider_certification_evidence
                     (id, provider_capability_id, test_name, result, environment,
                      adapter_version, artifact_ref, detail, created_by_user_id)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
            params: [
              evidenceId,
              declaration.id,
              outcome.testName,
              outcome.result,
              run.environment,
              run.adapterVersion,
              `contract-suite:${run.adapterVersion}`,
              JSON.stringify(outcome.detail),
              input.actingPrincipal.userId,
            ],
          });
        }
        // State advancement — evidence-driven only. "contract_verified"
        // requires the FULL deterministic suite to pass (a declaration
        // whose output does not conform or whose errors do not normalize
        // is NOT contract-verified); "certified" additionally requires
        // the evidence to come from a LIVE adapter (a fixture run can
        // never certify — WORK-006 §14).
        let statusAfter = declaration.status;
        if (result.allPassed && declaration.status === "registered") {
          statusAfter = "contract_verified";
        }
        if (
          result.allPassed &&
          run.environment === "live" &&
          (declaration.status === "contract_verified" || declaration.status === "registered")
        ) {
          statusAfter = "certified";
        }
        if (statusAfter !== declaration.status) {
          await tx.exec({
            text: `UPDATE cp_provider_capabilities
                   SET status = $1, certification_environment = $2, updated_at = NOW()
                   WHERE id = $3`,
            params: [statusAfter, run.environment, declaration.id],
          });
        }
        declarationResults.push({
          capabilityId: result.declaration.capabilityId,
          capabilityVersion: result.declaration.capabilityVersion,
          statusBefore: declaration.status,
          statusAfter,
          outcomes: result.outcomes,
        });
      }
    });

    this.logger.info("providers: contract tests executed", {
      provider_id: provider.providerId,
      environment: run.environment,
      adapter_version: run.adapterVersion,
      evidence_count: evidenceIds.length,
      declarations: declarationResults.map((d) => ({
        capability: `${d.capabilityId}@${d.capabilityVersion}`,
        from: d.statusBefore,
        to: d.statusAfter,
      })),
      actor: input.actingPrincipal.userId,
    });

    return {
      environment: run.environment,
      adapterVersion: run.adapterVersion,
      declarationResults,
      evidenceIds,
    };
  }

  /** List certification evidence for a provider (newest-first). */
  async listCertificationEvidence(canonicalProviderId: string): Promise<CertificationEvidenceRecord[]> {
    const provider = await this.getProvider(canonicalProviderId);
    if (!provider) {
      throw notFound("provider.not_found", `provider "${canonicalProviderId}" was not found`);
    }
    const rows = await this.db.query({
      text: `SELECT e.*, c.capability_id AS capability_canonical_id,
                    pc.capability_version
             FROM cp_provider_certification_evidence e
             JOIN cp_provider_capabilities pc ON pc.id = e.provider_capability_id
             JOIN cp_capabilities c ON c.id = pc.capability_id
             WHERE pc.provider_id = $1
             ORDER BY e.created_at DESC, e.id DESC`,
      params: [provider.id],
    });
    return rows.map((r) => mapEvidence(r as EvidenceRow));
  }

  // ---- internal helpers -----------------------------------------------------

  private async getDeclarationById(id: string): Promise<ProviderCapability | null> {
    const rows = await this.db.query({
      text: `SELECT pc.*, c.capability_id AS capability_canonical_id,
                    p.provider_id AS provider_canonical_id
             FROM cp_provider_capabilities pc
             JOIN cp_capabilities c ON c.id = pc.capability_id
             JOIN cp_providers p ON p.id = pc.provider_id
             WHERE pc.id = $1`,
      params: [id],
    });
    const row = rows[0];
    return row ? mapDeclaration(row as DeclarationRow) : null;
  }
}

// ---- Row mappers -----------------------------------------------------------

interface ProviderRow extends DbQueryResultRow {
  id: string;
  provider_id: string;
  name: string;
  description: string;
  status: string;
  integration_path: string;
  documentation_url: string | null;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    description: row.description,
    status: row.status as ProviderStatus,
    integrationPath: row.integration_path as IntegrationPath,
    documentationUrl: row.documentation_url,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface DeclarationRow extends DbQueryResultRow {
  id: string;
  provider_id: string;
  provider_canonical_id: string;
  capability_id: string;
  capability_canonical_id: string;
  capability_version: string;
  adapter_version: string;
  status: string;
  certification_environment: string;
  supported_constraints: unknown;
  credential_requirements: unknown;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapDeclaration(row: DeclarationRow): ProviderCapability {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerCanonicalId: row.provider_canonical_id,
    capabilityId: row.capability_id,
    capabilityCanonicalId: row.capability_canonical_id,
    capabilityVersion: row.capability_version,
    adapterVersion: row.adapter_version,
    status: row.status as ImplementationStatus,
    certificationEnvironment: row.certification_environment as ProviderCapability["certificationEnvironment"],
    supportedConstraints:
      row.supported_constraints && typeof row.supported_constraints === "object"
        ? (row.supported_constraints as Record<string, unknown>)
        : {},
    credentialRequirements: Array.isArray(row.credential_requirements)
      ? (row.credential_requirements as CredentialRequirement[])
      : [],
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface EvidenceRow extends DbQueryResultRow {
  id: string;
  provider_capability_id: string;
  capability_canonical_id: string;
  capability_version: string;
  test_name: string;
  result: string;
  environment: string;
  adapter_version: string;
  artifact_ref: string | null;
  detail: unknown;
  created_by_user_id: string;
  created_at: Date | string;
}

function mapEvidence(row: EvidenceRow): CertificationEvidenceRecord {
  return {
    id: row.id,
    providerCapabilityId: row.provider_capability_id,
    capabilityCanonicalId: row.capability_canonical_id,
    capabilityVersion: row.capability_version,
    testName: row.test_name,
    result: row.result as "pass" | "fail",
    environment: row.environment as AdapterEnvironment,
    adapterVersion: row.adapter_version,
    artifactRef: row.artifact_ref,
    detail:
      row.detail && typeof row.detail === "object"
        ? (row.detail as Record<string, unknown>)
        : {},
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
  };
}

// ---- Error helpers -----------------------------------------------------------

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

function notFound(code: string, message: string): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code,
    message,
    retryable: false,
    details: { reason: code },
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
