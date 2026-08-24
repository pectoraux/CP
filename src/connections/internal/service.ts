// /connections/internal/service.ts
// ConnectionsService — the /connections module's concrete service
// (WORK-010, architecture §34, §36; lock §10; frozen CONN-001..004).
// Owns the tenant-scoped connection layer:
//
//     Global Provider ( /providers )
//            ↓ reference
//     Tenant Connection ( project-scoped, this module )
//            ↓ reference
//     Credential Reference ( /credentials — metadata only here )
//            ↓ (future execution layer, via the adapter grant)
//     Provider Adapter
//
// Layer separation (WORK-010 §2, §16-§17): /providers = WHO the platform
// provider is; /catalog = WHAT it offers; /connections = HOW THIS TENANT
// IS CONNECTED; /credentials = WHERE secret material lives. A connection
// NEVER stores secret material, NEVER duplicates provider identity, and
// NEVER mutates catalog/eligibility state (§34). Connection existence
// influences nothing global.
//
// All provider/capability compatibility validation goes through PUBLIC
// interfaces only (§5, §20): ProvidersService.getProvider +
// listProviderCapabilities, CapabilitiesService.getCapability +
// getVersion, ProjectsService.getProject (the WORK-009 review lesson:
// never raw table SQL for other modules' data). This module's SQL touches
// ONLY cp_connections.
//
// TENANCY (§18): every operation takes the AUTHORIZED (organizationId,
// projectId) pair resolved by the /api org/project middlewares and
// re-verifies server-side (active membership + project ∈ org via the
// projects public interface). Cross-org/cross-project ids simply do not
// resolve.
//
// VERIFICATION (§11, §33): STRUCTURAL ONLY — credentials structurally
// complete, provider/capability compatible, configuration valid. NO live
// provider calls, NO adapter invocation (the adapter boundary belongs to
// future execution work; there is no ad-hoc HTTP integration here).

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
import { activeMembershipIn } from "@cp/auth";
import type { ProjectsService } from "@cp/projects";
import type { CapabilitiesService } from "@cp/capabilities";
import type { ProvidersService } from "@cp/providers";
import type { CredentialsService, CredentialMetadata } from "@cp/credentials";

// ---- Lifecycle (WORK-010 §4) ------------------------------------------------

export type ConnectionStatus = "draft" | "active" | "paused" | "revoked";

export const CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  "draft",
  "active",
  "paused",
  "revoked",
] as const;

/**
 * Valid connection lifecycle transitions. Activation (draft → active) is
 * additionally gated by the service on a prior successful VERIFICATION —
 * a connection must not become active merely because it exists. REVOKED
 * is terminal.
 */
export const CONNECTION_LIFECYCLE: ReadonlyMap<ConnectionStatus, readonly ConnectionStatus[]> =
  new Map([
    ["draft", ["active", "revoked"]],
    ["active", ["paused", "revoked"]],
    ["paused", ["active", "revoked"]],
    ["revoked", []],
  ]);

export function isConnectionStatus(v: string): v is ConnectionStatus {
  return (CONNECTION_STATUSES as readonly string[]).includes(v);
}

// ---- Record types -------------------------------------------------------------

/** SAFE connection representation — metadata only, never secrets. */
export interface Connection {
  id: string; // conn_<ulid>
  projectId: string;
  providerId: string; // canonical provider id (display, validated at write)
  capabilityCanonicalId: string | null;
  capabilityVersion: string | null;
  environment: string;
  label: string;
  configuration: Record<string, unknown>;
  credentialId: string | null;
  credentialKind: string | null;
  credentialStatus: string | null;
  credentialConfigured: boolean;
  status: ConnectionStatus;
  lastVerifiedAt: Date | null;
  verificationResult: {
    passed: boolean;
    checks: { checkId: string; result: "pass" | "fail"; reason: string }[];
    verifiedAt: string;
  } | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VerificationOutcome {
  passed: boolean;
  checks: { checkId: string; result: "pass" | "fail"; reason: string }[];
  verifiedAt: string;
}

// ---- Inputs ---------------------------------------------------------------------

export interface CreateConnectionInput {
  organizationId: string; // AUTHORIZED org id (orgContextMiddleware)
  projectId: string; // AUTHORIZED project id (projectContextMiddleware)
  providerId: string; // canonical provider id, e.g. 'demo.echo'
  capabilityId?: string; // optional canonical capability scoping
  capabilityVersion?: string;
  environment?: string; // default 'default'; 'production'/'sandbox'/...
  label?: string;
  configuration?: Record<string, unknown>;
  actingPrincipal: Principal;
}

export interface UpdateConnectionInput {
  organizationId: string;
  projectId: string;
  connectionId: string;
  label?: string;
  configuration?: Record<string, unknown>;
  actingPrincipal: Principal;
}

export interface TransitionConnectionInput {
  organizationId: string;
  projectId: string;
  connectionId: string;
  toStatus: ConnectionStatus;
  actingPrincipal: Principal;
}

export interface AttachCredentialInput {
  organizationId: string;
  projectId: string;
  connectionId: string;
  kind: string;
  name: string;
  secret: string;
  actingPrincipal: Principal;
}

export interface DetachCredentialInput {
  organizationId: string;
  projectId: string;
  connectionId: string;
  actingPrincipal: Principal;
}

export interface VerifyConnectionInput {
  organizationId: string;
  projectId: string;
  connectionId: string;
  actingPrincipal: Principal;
}

export interface ListConnectionsOptions {
  limit?: number;
  cursor?: string | null;
  providerId?: string; // canonical filter
  status?: ConnectionStatus;
  includeRevoked?: boolean;
}

export interface ConnectionPage {
  connections: Connection[];
  nextCursor: string | null;
}

export interface ConnectionsServiceOptions {
  db: Database;
  logger?: Logger;
  projects: ProjectsService;
  capabilities: CapabilitiesService;
  providers: ProvidersService;
  credentials: CredentialsService;
}

const NOOP_SINK: LogSink = {
  emit(_record: LogRecord): void {},
};

const MAX_LABEL_LEN = 200;
const MAX_CONFIG_KEYS = 32;
const MAX_CONFIG_DEPTH = 3;
const MAX_CONFIG_STRING = 512;
/** Keys whose names suggest secret material — rejected outright (§13). */
const SECRETISH_KEY_RE = /secret|password|passwd|token|api[_-]?key|credential|private[_-]?key|refresh[_-]?token/i;

// ---- Service ----------------------------------------------------------------------

export class ConnectionsService {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly projects: ProjectsService;
  private readonly capabilities: CapabilitiesService;
  private readonly providers: ProvidersService;
  private readonly credentials: CredentialsService;

  constructor(opts: ConnectionsServiceOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
    this.projects = opts.projects;
    this.capabilities = opts.capabilities;
    this.providers = opts.providers;
    this.credentials = opts.credentials;
  }

  // ---- Tenancy + authorization (§18) ------------------------------------------

  /**
   * Verify the (organizationId, projectId) scope through the /projects
   * PUBLIC interface (getProject — the org-scoped tenant query) and that
   * the acting principal holds an ACTIVE membership. Mutations
   * additionally require the admin or owner role (the WORK-004/008
   * precedent). Defense in depth on top of the /api gates; no second
   * tenant system.
   */
  private async requireProjectScope(
    organizationId: string,
    projectId: string,
    principal: Principal,
    opts: { requireAdmin?: boolean } = {},
  ): Promise<void> {
    const membership = activeMembershipIn(principal, organizationId);
    if (!membership) {
      throw policyBlocked("connection.membership.required", "an active membership in this organization is required", {
        reason: "not_a_member",
        organization_id: organizationId,
      });
    }
    if (opts.requireAdmin && membership.role !== "admin" && membership.role !== "owner") {
      throw policyBlocked("connection.role.required", "the admin or owner role is required to mutate connections", {
        reason: "insufficient_role",
        required_roles: ["admin", "owner"],
        actual_role: membership.role,
      });
    }
    const project = await this.projects.getProject(organizationId, projectId);
    if (!project) {
      throw notFound("connection.project.not_found", "the project does not exist in this organization", {
        project_id: projectId,
      });
    }
  }

  // ---- Provider / capability compatibility (§5, §20 — public interfaces only) ----

  /**
   * Validate the provider reference + optional capability scoping against
   * the AUTHORITATIVE public interfaces:
   *   - provider exists (ProvidersService.getProvider)
   *   - provider is not revoked (creation to a revoked provider rejected)
   *   - when capability-scoped: capability exists, version exists
   *     (CapabilitiesService), and the provider DECLARES that exact
   *     capability+version (ProvidersService.listProviderCapabilities)
   * Returns the resolved internal + canonical ids for persistence.
   */
  private async validateProviderReferences(
    providerCanonicalId: string,
    capabilityCanonicalId: string | undefined,
    capabilityVersion: string | undefined,
  ): Promise<{
    providerInternalId: string;
    providerCanonicalId: string;
    capabilityInternalId: string | null;
    capabilityCanonicalId: string | null;
    capabilityVersion: string | null;
    declaredCredentialKinds: string[] | null;
  }> {
    const provider = await this.providers.getProvider(providerCanonicalId);
    if (!provider) {
      throw policyBlocked("connection.provider.unknown", `provider "${providerCanonicalId}" does not exist`, {
        reason: "provider_not_found",
        provider_id: providerCanonicalId,
      });
    }
    if (provider.status === "revoked") {
      throw policyBlocked("connection.provider.revoked", `provider "${providerCanonicalId}" is revoked`, {
        reason: "provider_revoked",
        provider_id: providerCanonicalId,
      });
    }

    if (capabilityCanonicalId === undefined || capabilityCanonicalId === null || capabilityCanonicalId === "") {
      return {
        providerInternalId: provider.id,
        providerCanonicalId: provider.providerId,
        capabilityInternalId: null,
        capabilityCanonicalId: null,
        capabilityVersion: null,
        declaredCredentialKinds: null,
      };
    }
    if (!capabilityVersion) {
      throw policyBlocked("connection.validation", "capability_version is required when capability_id is provided", {
        reason: "missing_capability_version",
      });
    }

    const capability = await this.capabilities.getCapability(capabilityCanonicalId);
    if (!capability) {
      throw policyBlocked("connection.capability.unknown", `capability "${capabilityCanonicalId}" does not exist`, {
        reason: "capability_not_found",
      });
    }
    const version = await this.capabilities.getVersion(capabilityCanonicalId, capabilityVersion);
    if (!version) {
      throw policyBlocked("connection.capability.version_unknown", `capability "${capabilityCanonicalId}" has no version "${capabilityVersion}"`, {
        reason: "capability_version_not_found",
      });
    }

    // Exact declaration check via the providers public interface.
    const declarations = await this.providers.listProviderCapabilities(provider.providerId);
    const declaration = declarations.find(
      (d) =>
        d.capabilityCanonicalId === capabilityCanonicalId &&
        d.capabilityVersion === capabilityVersion,
    );
    if (!declaration) {
      throw policyBlocked("connection.capability.unsupported", `provider "${provider.providerId}" does not declare capability "${capabilityCanonicalId}" version "${capabilityVersion}"`, {
        reason: "capability_not_declared",
        provider_id: provider.providerId,
        capability_id: capabilityCanonicalId,
        capability_version: capabilityVersion,
        declared: declarations.map((d) => `${d.capabilityCanonicalId}@${d.capabilityVersion}`),
      });
    }

    return {
      providerInternalId: provider.id,
      providerCanonicalId: provider.providerId,
      capabilityInternalId: capability.id,
      capabilityCanonicalId: capability.capabilityId,
      capabilityVersion,
      declaredCredentialKinds: declaration.credentialRequirements.map((r) => r.kind),
    };
  }

  // ---- CRUD -------------------------------------------------------------------

  async createConnection(input: CreateConnectionInput): Promise<Connection> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const refs = await this.validateProviderReferences(
      input.providerId,
      input.capabilityId,
      input.capabilityVersion,
    );
    const environment = input.environment === undefined || input.environment === null || input.environment === ""
      ? "default"
      : input.environment.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(environment)) {
      throw policyBlocked("connection.validation", `environment must be a lowercase slug (letter-first, [a-z0-9-], <=63 chars); got "${environment}"`, {
        reason: "invalid_environment",
      });
    }
    const label =
      typeof input.label === "string" ? input.label.trim().slice(0, MAX_LABEL_LEN) : "";
    const configuration = validateConfiguration(input.configuration);

    const id = `conn_${ulid()}`;
    try {
      await this.db.exec({
        text: `INSERT INTO cp_connections
                 (id, project_id, provider_id, provider_canonical_id,
                  capability_id, capability_canonical_id, capability_version,
                  environment, label, configuration, status, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'draft', $11)`,
        params: [
          id,
          input.projectId,
          refs.providerInternalId,
          refs.providerCanonicalId,
          refs.capabilityInternalId,
          refs.capabilityCanonicalId,
          refs.capabilityVersion,
          environment,
          label,
          JSON.stringify(configuration),
          input.actingPrincipal.userId,
        ],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw policyBlocked("connection.duplicate", "a connection for this provider and environment already exists in this project", {
          reason: "duplicate_connection",
          provider_id: refs.providerCanonicalId,
          environment,
        });
      }
      throw err;
    }
    this.logger.info("connections: created", {
      connection_id: id,
      provider_id: refs.providerCanonicalId,
      capability: refs.capabilityCanonicalId
        ? `${refs.capabilityCanonicalId}@${refs.capabilityVersion}`
        : null,
      environment,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireConnection(input.projectId, id);
  }

  async getConnection(
    organizationId: string,
    projectId: string,
    connectionId: string,
    principal: Principal,
  ): Promise<Connection | null> {
    await this.requireProjectScope(organizationId, projectId, principal);
    return this.getConnectionRow(projectId, connectionId);
  }

  async listConnections(
    organizationId: string,
    projectId: string,
    principal: Principal,
    opts: ListConnectionsOptions = {},
  ): Promise<ConnectionPage> {
    await this.requireProjectScope(organizationId, projectId, principal);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: string[] = [`c.project_id = $1`];
    const params: unknown[] = [projectId];
    if (opts.providerId) {
      params.push(opts.providerId);
      where.push(`c.provider_canonical_id = $${params.length}`);
    }
    if (opts.status) {
      params.push(opts.status);
      where.push(`c.status = $${params.length}`);
    } else if (!opts.includeRevoked) {
      where.push(`c.status <> 'revoked'`);
    }
    if (opts.cursor) {
      params.push(opts.cursor);
      where.push(`c.id < $${params.length}`);
    }
    const rows = await this.db.query({
      text: `SELECT c.*, cred.kind AS credential_kind, cred.status AS credential_status,
                    cred.current_version AS credential_version
             FROM cp_connections c
             LEFT JOIN cp_credentials cred ON cred.id = c.credential_id
             WHERE ${where.join(" AND ")}
             ORDER BY c.id DESC
             LIMIT ${limit + 1}`,
      params,
    });
    const all = rows.map((r) => mapConnection(r as ConnectionRow));
    const page = all.slice(0, limit);
    const nextCursor = all.length > limit ? page[page.length - 1]!.id : null;
    return { connections: page, nextCursor };
  }

  async updateConnection(input: UpdateConnectionInput): Promise<Connection> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const existing = await this.getConnectionRow(input.projectId, input.connectionId);
    if (!existing) {
      throw notFound("connection.not_found", "the connection was not found in this project");
    }
    if (existing.status === "revoked") {
      throw policyBlocked("connection.revoked", "a revoked connection cannot be updated", {
        reason: "connection_revoked",
      });
    }
    const label =
      input.label === undefined ? existing.label : input.label.trim().slice(0, MAX_LABEL_LEN);
    const configuration =
      input.configuration === undefined ? existing.configuration : validateConfiguration(input.configuration);
    await this.db.exec({
      text: `UPDATE cp_connections SET label = $1, configuration = $2::jsonb, updated_at = NOW()
             WHERE id = $3 AND project_id = $4`,
      params: [label, JSON.stringify(configuration), input.connectionId, input.projectId],
    });
    this.logger.info("connections: updated", {
      connection_id: input.connectionId,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireConnection(input.projectId, input.connectionId);
  }

  /**
   * Revoke (DELETE) a connection. Revoked is terminal. The connection's
   * credential is NOT auto-revoked — credential lifecycle belongs to the
   * credential endpoints (explicit operator action; §22 semantics).
   */
  async transitionConnection(input: TransitionConnectionInput): Promise<Connection> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const existing = await this.getConnectionRow(input.projectId, input.connectionId);
    if (!existing) {
      throw notFound("connection.not_found", "the connection was not found in this project");
    }
    if (!isConnectionStatus(input.toStatus)) {
      throw policyBlocked("connection.validation", `unknown connection status "${String(input.toStatus)}"`, {
        reason: "invalid_status",
      });
    }
    const allowed = CONNECTION_LIFECYCLE.get(existing.status) ?? [];
    if (!allowed.includes(input.toStatus)) {
      throw policyBlocked("connection.transition.invalid", `connection cannot transition from "${existing.status}" to "${input.toStatus}"`, {
        reason: "invalid_transition",
        from: existing.status,
        to: input.toStatus,
        allowed,
      });
    }
    // ACTIVATION GATE (§4): a connection must not become active merely
    // because it exists — activation requires a prior PASSING structural
    // verification.
    if (input.toStatus === "active") {
      const verified = existing.verificationResult?.passed === true && existing.lastVerifiedAt !== null;
      if (!verified) {
        throw policyBlocked("connection.activation.unverified", "the connection must pass verification before it can be activated", {
          reason: "not_verified",
          connection_id: input.connectionId,
        });
      }
    }
    await this.db.exec({
      text: `UPDATE cp_connections SET status = $1, updated_at = NOW()
             WHERE id = $2 AND project_id = $3`,
      params: [input.toStatus, input.connectionId, input.projectId],
    });
    this.logger.info("connections: transitioned", {
      connection_id: input.connectionId,
      from: existing.status,
      to: input.toStatus,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireConnection(input.projectId, input.connectionId);
  }

  // ---- Credential attach / detach (the /credentials boundary does the rest) ------

  /**
   * Attach (or replace) the connection's credential: creates a NEW
   * tenant-scoped credential through the /credentials service with the
   * given secret and points the connection at it. If the connection
   * already references a credential, that OLD credential is REVOKED and
   * the reference replaced (rotation semantics: stable connection
   * identity, new credential — §22). The secret never appears in the
   * returned Connection (metadata only) nor in any log.
   */
  async attachCredential(input: AttachCredentialInput): Promise<Connection> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const existing = await this.getConnectionRow(input.projectId, input.connectionId);
    if (!existing) {
      throw notFound("connection.not_found", "the connection was not found in this project");
    }
    if (existing.status === "revoked") {
      throw policyBlocked("connection.revoked", "a revoked connection cannot be configured", {
        reason: "connection_revoked",
      });
    }
    // Kind compatibility (§21): when the connection is capability-scoped
    // and the provider's declaration lists credential requirements, the
    // credential kind must match one of them.
    if (existing.capabilityCanonicalId) {
      const declarations = await this.providers.listProviderCapabilities(existing.providerId);
      const declaration = declarations.find(
        (d) =>
          d.capabilityCanonicalId === existing.capabilityCanonicalId &&
          d.capabilityVersion === existing.capabilityVersion,
      );
      if (declaration && declaration.credentialRequirements.length > 0) {
        const kinds = declaration.credentialRequirements.map((r) => r.kind);
        if (!(kinds as string[]).includes(input.kind)) {
          throw policyBlocked("connection.credential.kind_mismatch", `credential kind "${input.kind}" does not match the provider's declared requirement kinds: ${kinds.join(", ")}`, {
            reason: "kind_mismatch",
            declared_kinds: kinds,
          });
        }
      }
    }
    const credential = await this.credentials.createCredential({
      organizationId: input.organizationId,
      projectId: input.projectId,
      kind: input.kind as never,
      name: input.name,
      secret: input.secret,
      actingPrincipal: input.actingPrincipal,
    });
    await this.db.exec({
      text: `UPDATE cp_connections SET credential_id = $1, updated_at = NOW()
             WHERE id = $2 AND project_id = $3`,
      params: [credential.id, input.connectionId, input.projectId],
    });
    // Rotation: revoke the OLD credential (if any) AFTER the reference
    // switched — the old secret cannot be resurrected and the connection
    // identity stayed stable.
    if (existing.credentialId && existing.credentialId !== credential.id) {
      await this.credentials.revokeCredential({
        organizationId: input.organizationId,
        projectId: input.projectId,
        credentialId: existing.credentialId,
        actingPrincipal: input.actingPrincipal,
      }).catch((err) => {
        this.logger.warn("connections: old credential revocation failed during rotation", {
          connection_id: input.connectionId,
          old_credential_id: existing.credentialId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    this.logger.info("connections: credential attached", {
      connection_id: input.connectionId,
      credential_id: credential.id, // opaque reference — never the secret
      kind: credential.kind,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireConnection(input.projectId, input.connectionId);
  }

  /**
   * Detach the connection's credential and REVOKE it (the secret is
   * deleted from secure storage). The connection remains, now
   * unconfigured for credentials.
   */
  async detachCredential(input: DetachCredentialInput): Promise<Connection> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const existing = await this.getConnectionRow(input.projectId, input.connectionId);
    if (!existing) {
      throw notFound("connection.not_found", "the connection was not found in this project");
    }
    if (!existing.credentialId) {
      throw policyBlocked("connection.credential.absent", "the connection has no credential to detach", {
        reason: "no_credential",
      });
    }
    await this.credentials.revokeCredential({
      organizationId: input.organizationId,
      projectId: input.projectId,
      credentialId: existing.credentialId,
      actingPrincipal: input.actingPrincipal,
    });
    await this.db.exec({
      text: `UPDATE cp_connections SET credential_id = NULL, updated_at = NOW()
             WHERE id = $1 AND project_id = $2`,
      params: [input.connectionId, input.projectId],
    });
    this.logger.info("connections: credential detached + revoked", {
      connection_id: input.connectionId,
      credential_id: existing.credentialId,
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireConnection(input.projectId, input.connectionId);
  }

  // ---- Structural verification (§11, §33 — NO live provider calls) ----------------

  /**
   * Verify the connection STRUCTURALLY: provider exists + not revoked;
   * capability/version still declared (when scoped); credential
   * configured, active, stored (version ≥ 1), and kind-compatible with
   * the declaration's requirements; configuration valid. Records
   * last_verified_at + the check results. This is NOT provider
   * execution — no adapter invocation, no network calls.
   */
  async verifyConnection(input: VerifyConnectionInput): Promise<Connection> {
    await this.requireProjectScope(input.organizationId, input.projectId, input.actingPrincipal, {
      requireAdmin: true,
    });
    const existing = await this.getConnectionRow(input.projectId, input.connectionId);
    if (!existing) {
      throw notFound("connection.not_found", "the connection was not found in this project");
    }
    const checks: { checkId: string; result: "pass" | "fail"; reason: string }[] = [];

    // 1. Provider exists + not revoked.
    const provider = await this.providers.getProvider(existing.providerId);
    if (!provider) {
      checks.push({ checkId: "provider.exists", result: "fail", reason: `provider "${existing.providerId}" no longer exists` });
    } else if (provider.status === "revoked") {
      checks.push({ checkId: "provider.status", result: "fail", reason: `provider is revoked` });
    } else {
      checks.push({ checkId: "provider.status", result: "pass", reason: `provider is ${provider.status}` });
    }

    // 2. Capability declaration still valid (when scoped).
    if (existing.capabilityCanonicalId && existing.capabilityVersion) {
      const declarations = await this.providers.listProviderCapabilities(existing.providerId);
      const declaration = declarations.find(
        (d) =>
          d.capabilityCanonicalId === existing.capabilityCanonicalId &&
          d.capabilityVersion === existing.capabilityVersion,
      );
      if (!declaration) {
        checks.push({
          checkId: "capability.declared",
          result: "fail",
          reason: `provider no longer declares ${existing.capabilityCanonicalId}@${existing.capabilityVersion}`,
        });
      } else {
        checks.push({
          checkId: "capability.declared",
          result: "pass",
          reason: `provider declares ${existing.capabilityCanonicalId}@${existing.capabilityVersion}`,
        });

        // 3. Credential structurally complete against the declaration.
        const requiredKinds = declaration.credentialRequirements.map((r) => r.kind);
        if (requiredKinds.length > 0) {
          const credential = existing.credentialId
            ? await this.credentials.getMetadata(input.projectId, existing.credentialId)
            : null;
          if (!credential) {
            checks.push({ checkId: "credential.configured", result: "fail", reason: "no credential attached (the provider requires one)" });
          } else if (credential.status !== "active") {
            checks.push({ checkId: "credential.status", result: "fail", reason: `credential is ${credential.status}` });
          } else if (credential.currentVersion < 1) {
            checks.push({ checkId: "credential.secret", result: "fail", reason: "credential has no stored secret" });
          } else if (!(requiredKinds as string[]).includes(credential.kind)) {
            checks.push({ checkId: "credential.kind", result: "fail", reason: `credential kind "${credential.kind}" does not match required kinds: ${requiredKinds.join(", ")}` });
          } else {
            checks.push({ checkId: "credential.configured", result: "pass", reason: `active ${credential.kind} credential attached` });
          }
        } else if (existing.credentialId) {
          // No declared requirements but a credential exists — check it is healthy.
          const credential = await this.credentials.getMetadata(input.projectId, existing.credentialId);
          if (!credential || credential.status !== "active" || credential.currentVersion < 1) {
            checks.push({ checkId: "credential.configured", result: "fail", reason: "attached credential is revoked or has no stored secret" });
          } else {
            checks.push({ checkId: "credential.configured", result: "pass", reason: `active ${credential.kind} credential attached` });
          }
        } else {
          checks.push({ checkId: "credential.configured", result: "pass", reason: "no credential required by the provider declaration" });
        }
      }
    } else {
      // Provider-wide connection (no capability scoping): a credential is
      // optional configuration.
      if (existing.credentialId) {
        const credential = await this.credentials.getMetadata(input.projectId, existing.credentialId);
        if (!credential || credential.status !== "active" || credential.currentVersion < 1) {
          checks.push({ checkId: "credential.configured", result: "fail", reason: "attached credential is revoked or has no stored secret" });
        } else {
          checks.push({ checkId: "credential.configured", result: "pass", reason: `active ${credential.kind} credential attached` });
        }
      } else {
        checks.push({ checkId: "credential.configured", result: "pass", reason: "no credential attached" });
      }
    }

    // 4. Configuration structurally valid (it was validated at write; a
    //    legacy/edited row would still pass shape screening here).
    validateConfiguration(existing.configuration);
    checks.push({ checkId: "configuration.valid", result: "pass", reason: "configuration is structurally valid" });

    const outcome: VerificationOutcome = {
      passed: checks.every((c) => c.result === "pass"),
      checks,
      verifiedAt: new Date().toISOString(),
    };
    await this.db.exec({
      text: `UPDATE cp_connections
             SET last_verified_at = NOW(), verification_result = $1::jsonb, updated_at = NOW()
             WHERE id = $2 AND project_id = $3`,
      params: [JSON.stringify(outcome), input.connectionId, input.projectId],
    });
    this.logger.info("connections: verified (structural)", {
      connection_id: input.connectionId,
      passed: outcome.passed,
      failed_checks: checks.filter((c) => c.result === "fail").map((c) => c.checkId),
      organization_id: input.organizationId,
      project_id: input.projectId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireConnection(input.projectId, input.connectionId);
  }

  // ---- internal helpers ------------------------------------------------------------

  private async getConnectionRow(projectId: string, connectionId: string): Promise<Connection | null> {
    const rows = await this.db.query({
      text: `SELECT c.*, cred.kind AS credential_kind, cred.status AS credential_status,
                    cred.current_version AS credential_version
             FROM cp_connections c
             LEFT JOIN cp_credentials cred ON cred.id = c.credential_id
             WHERE c.id = $1 AND c.project_id = $2`,
      params: [connectionId, projectId],
    });
    const row = rows[0];
    return row ? mapConnection(row as ConnectionRow) : null;
  }

  private async requireConnection(projectId: string, connectionId: string): Promise<Connection> {
    const conn = await this.getConnectionRow(projectId, connectionId);
    if (!conn) {
      throw new AppError({
        category: "PLATFORM_FAILURE",
        code: "connection.readback.failed",
        message: "connection operation succeeded but the row could not be read back",
        retryable: false,
      });
    }
    return conn;
  }
}

// ---- Row mapper --------------------------------------------------------------------

interface ConnectionRow extends DbQueryResultRow {
  id: string;
  project_id: string;
  provider_canonical_id: string;
  capability_canonical_id: string | null;
  capability_version: string | null;
  environment: string;
  label: string;
  configuration: unknown;
  credential_id: string | null;
  credential_kind: string | null;
  credential_status: string | null;
  credential_version: number | null;
  status: string;
  last_verified_at: Date | string | null;
  verification_result: unknown;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapConnection(row: ConnectionRow): Connection {
  const vr = row.verification_result as VerificationOutcome | null | undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    providerId: row.provider_canonical_id,
    capabilityCanonicalId: row.capability_canonical_id,
    capabilityVersion: row.capability_version,
    environment: row.environment,
    label: row.label,
    configuration:
      row.configuration && typeof row.configuration === "object" && !Array.isArray(row.configuration)
        ? (row.configuration as Record<string, unknown>)
        : {},
    credentialId: row.credential_id,
    credentialKind: row.credential_kind,
    credentialStatus: row.credential_status,
    // SAFE derived flag — the shape ordinary APIs expose (§19).
    credentialConfigured:
      row.credential_id !== null &&
      row.credential_status === "active" &&
      Number(row.credential_version ?? 0) >= 1,
    status: row.status as ConnectionStatus,
    lastVerifiedAt: row.last_verified_at === null ? null : new Date(row.last_verified_at),
    verificationResult:
      vr && typeof vr === "object" && Array.isArray((vr as VerificationOutcome).checks)
        ? (vr as VerificationOutcome)
        : null,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ---- Configuration validation (§13 — non-secret, bounded) ------------------------------

/**
 * Validate provider-neutral connection configuration: an object with at
 * most MAX_CONFIG_KEYS keys, nesting depth at most MAX_CONFIG_DEPTH,
 * bounded string values — and NO secret-ish keys (rejected outright:
 * secrets must go through the dedicated credential endpoint, never the
 * configuration JSON).
 */
export function validateConfiguration(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw policyBlocked("connection.validation", "configuration must be an object", {
      reason: "invalid_configuration",
    });
  }
  const out = validateConfigObject(input as Record<string, unknown>, 0, "configuration");
  return out;
}

function validateConfigObject(
  obj: Record<string, unknown>,
  depth: number,
  path: string,
): Record<string, unknown> {
  const keys = Object.keys(obj);
  if (keys.length > MAX_CONFIG_KEYS) {
    throw policyBlocked("connection.validation", `configuration may contain at most ${MAX_CONFIG_KEYS} keys`, { reason: "config_too_large" });
  }
  if (depth > MAX_CONFIG_DEPTH) {
    throw policyBlocked("connection.validation", `configuration nesting exceeds depth ${MAX_CONFIG_DEPTH}`, { reason: "config_too_deep" });
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (SECRETISH_KEY_RE.test(key)) {
      throw policyBlocked("connection.validation", `configuration key "${key}" is not allowed — secrets must be configured through the credential endpoint, never the connection configuration`, {
        reason: "secretish_key_rejected",
        key,
      });
    }
    if (key.length > 128) {
      throw policyBlocked("connection.validation", "configuration keys must be at most 128 characters", { reason: "config_key_too_long" });
    }
    const value = obj[key]!;
    if (value === null) {
      out[key] = null;
    } else if (typeof value === "string") {
      if (value.length > MAX_CONFIG_STRING) {
        throw policyBlocked("connection.validation", `configuration value for "${key}" exceeds ${MAX_CONFIG_STRING} characters`, { reason: "config_value_too_long" });
      }
      out[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw policyBlocked("connection.validation", `configuration value for "${key}" must be finite`, { reason: "invalid_config_value" });
      }
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      if (value.length > MAX_CONFIG_KEYS) {
        throw policyBlocked("connection.validation", `configuration array for "${key}" exceeds ${MAX_CONFIG_KEYS} items`, { reason: "config_too_large" });
      }
      out[key] = value.map((item, i) => {
        if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
          if (typeof item === "string" && item.length > MAX_CONFIG_STRING) {
            throw policyBlocked("connection.validation", `configuration value at ${path}.${key}[${i}] exceeds ${MAX_CONFIG_STRING} characters`, { reason: "config_value_too_long" });
          }
          return item;
        }
        throw policyBlocked("connection.validation", `configuration arrays may contain only primitives (at ${path}.${key}[${i}])`, { reason: "invalid_config_value" });
      });
    } else if (typeof value === "object") {
      out[key] = validateConfigObject(value as Record<string, unknown>, depth + 1, `${path}.${key}`);
    } else {
      throw policyBlocked("connection.validation", `configuration value for "${key}" has an unsupported type`, { reason: "invalid_config_value" });
    }
  }
  return out;
}

// ---- Error helpers --------------------------------------------------------------------

function policyBlocked(code: string, message: string, details?: Record<string, unknown>): AppError {
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

// Re-export for the public interface (metadata shape used by serializers).
export type { CredentialMetadata };
