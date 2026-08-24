// /credentials/internal/service.ts
// CredentialsService — the /credentials module's concrete service
// (WORK-010, architecture §2.17, §30, §36; lock §10; frozen CONN/CRED
// requirements). THE secret-access boundary of the platform:
//
//   CredentialMetadata (PostgreSQL)  ≠  SecretMaterial (encrypted blob
//                                       in platform ObjectStorage)
//
//   /credentials owns secret access policy + metadata;
//   /platform owns the generic storage infrastructure. The physical
//   storage mechanism stays behind this boundary (WORK-010 §26).
//
// SECRET BOUNDARY (§6-§10, §31):
//   - Connection rows store only a credential REFERENCE (id) — never
//     api keys, secrets, passwords, private keys, or OAuth tokens.
//   - Secret material is encrypted (AES-256-GCM, HKDF-derived
//     per-record key, deployment master key) and stored in the platform
//     ObjectStorage at credentials/{id}/v{n} — never in PostgreSQL.
//   - resolveForAdapter() is the ONLY path that returns a secret value,
//     and it requires an AdapterCredentialGrant — a branded token
//     reserved for the future execution/provider-adapter integration
//     seam (architecture §30: "adapters must receive only the
//     credentials/scopes required for their provider operation").
//     There is deliberately NO HTTP endpoint that resolves secrets and
//     NO list/get helper returning values.
//   - Revoked credentials never resolve. Rotation (replaceSecret)
//     writes a NEW encrypted version and deletes the old blob — old
//     versions cannot be resurrected.
//
// TENANCY (§18-§19): every operation is scoped by the (organizationId,
// projectId) pair resolved by the caller through the /projects public
// interface (the /connections layer and /api org/project gates perform
// that resolution — this module never queries cp_projects itself and
// imports ONLY @cp/platform). All row queries scope by project_id; the
// organizationId is carried for symmetry and logging (safe metadata
// only — ids, kinds, statuses; NEVER secret values, blobs, or the
// master key).

import {
  AppError,
  type Database,
  type DbQueryResultRow,
  type ObjectStorage,
  ulid,
  Logger,
  type LogSink,
  type LogRecord,
} from "@cp/platform";
import { CREDENTIAL_KINDS, isCredentialKind } from "./requirements.ts";
import { encryptSecret, decryptSecret, parseMasterKey } from "./crypto.ts";

// ---- Types -----------------------------------------------------------------

export type CredentialStatus = "active" | "revoked";

export const CREDENTIAL_STATUSES: readonly CredentialStatus[] = ["active", "revoked"];

/** SAFE metadata — this is the ONLY shape ordinary APIs ever see. */
export interface CredentialMetadata {
  id: string; // opaque cred_<ulid>
  projectId: string;
  kind: string;
  name: string;
  status: CredentialStatus;
  currentVersion: number;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The resolved secret — narrowly typed for the adapter boundary only. */
export interface ResolvedSecret {
  credentialId: string;
  kind: string;
  value: string;
}

/**
 * A branded authorization token for the execution/provider-adapter seam.
 * Constructible ONLY via CredentialsService.issueAdapterGrant() — the
 * single, explicit integration point the future execution layer
 * (WORK-014) uses. Ordinary domain code, /api handlers, and API clients
 * can never produce one, so they can never resolve secret material.
 */
export interface AdapterCredentialGrant {
  readonly __adapterCredentialGrant: unique symbol;
}

export interface CreateCredentialInput {
  organizationId: string; // authorized org (resolved by the caller)
  projectId: string; // authorized project (project ∈ org, verified by caller)
  kind: string;
  name: string;
  secret: string;
  actingPrincipal: { userId: string };
}

export interface ReplaceSecretInput {
  organizationId: string;
  projectId: string;
  credentialId: string;
  secret: string;
  actingPrincipal: { userId: string };
}

export interface RevokeCredentialInput {
  organizationId: string;
  projectId: string;
  credentialId: string;
  actingPrincipal: { userId: string };
}

export interface ResolveCredentialInput {
  organizationId: string;
  projectId: string;
  credentialId: string;
  grant: AdapterCredentialGrant;
}

export interface ListCredentialsOptions {
  limit?: number;
  cursor?: string | null;
  includeRevoked?: boolean;
}

export interface CredentialPage {
  credentials: CredentialMetadata[];
  nextCursor: string | null;
}

export interface CredentialsServiceOptions {
  db: Database;
  /** The platform object-storage boundary (real S3-compatible storage). */
  storage: ObjectStorage;
  /** 32-byte master key (hex). Defaults to CP_CREDENTIAL_MASTER_KEY. */
  masterKeyHex?: string;
  logger?: Logger;
}

const MAX_SECRET_BYTES = 64 * 1024; // 64 KiB
const MAX_NAME_LEN = 200;
const STORAGE_PREFIX = "credentials";

const NOOP_SINK: LogSink = {
  emit(_record: LogRecord): void {},
};

// ---- Service ----------------------------------------------------------------

export class CredentialsService {
  private readonly db: Database;
  private readonly storage: ObjectStorage;
  private readonly masterKey: Buffer | null;
  private readonly logger: Logger;

  constructor(opts: CredentialsServiceOptions) {
    this.db = opts.db;
    this.storage = opts.storage;
    this.masterKey = parseMasterKey(opts.masterKeyHex ?? process.env.CP_CREDENTIAL_MASTER_KEY);
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
  }

  // ---- The adapter-boundary grant (§8, §31) --------------------------------

  /**
   * Issue the AdapterCredentialGrant — the ONLY constructor of the
   * branded token, reserved for the future execution/provider-adapter
   * integration seam. It takes no arguments on purpose: the point is a
   * single, greppable call site the architect can audit, not a
   * privilege check. Ordinary request handling must never call this.
   */
  issueAdapterGrant(): AdapterCredentialGrant {
    return { __adapterCredentialGrant: undefined } as unknown as AdapterCredentialGrant;
  }

  // ---- Create / rotate / revoke ---------------------------------------------

  /**
   * Create a tenant-scoped credential: metadata row in PostgreSQL +
   * encrypted secret blob in object storage. The secret parameter is
   * consumed here and NEVER persisted in any table, log, or response.
   */
  async createCredential(input: CreateCredentialInput): Promise<CredentialMetadata> {
    const kind = validateKind(input.kind);
    const name = validateName(input.name);
    validateSecret(input.secret);
    const id = `cred_${ulid()}`;
    const blob = encryptSecret(this.masterKey, id, input.secret);
    // Write the encrypted blob FIRST; the metadata row references a
    // credential whose secret already exists at version 1.
    await this.storage.put({
      key: this.storageKey(id, 1),
      body: Buffer.from(blob, "utf8"),
      contentType: "application/octet-stream",
    });
    try {
      await this.db.exec({
        text: `INSERT INTO cp_credentials
                 (id, project_id, kind, name, status, current_version, created_by_user_id)
               VALUES ($1, $2, $3, $4, 'active', 1, $5)`,
        params: [id, input.projectId, kind, name, input.actingPrincipal.userId],
      });
    } catch (err) {
      // Metadata insert failed (duplicate name?) — remove the orphaned
      // blob so no secret material outlives its metadata row.
      await this.storage.delete(this.storageKey(id, 1)).catch(() => {});
      if (isUniqueViolation(err)) {
        throw policyBlocked("credential.duplicate", "a credential with this name already exists in this project", {
          reason: "duplicate_name",
        });
      }
      throw err;
    }
    this.logger.info("credentials: created", {
      credential_id: id,
      kind,
      project_id: input.projectId,
      organization_id: input.organizationId,
      user_id: input.actingPrincipal.userId,
      // NEVER the secret, its length, or any derived hash.
    });
    return this.requireMetadata(input.projectId, id);
  }

  /**
   * Rotate the secret: write a NEW encrypted version and delete the old
   * blob within one operation — the credential identity stays stable
   * (WORK-010 §22). Old versions cannot be resurrected: the resolver
   * reads only current_version, and the previous blob is deleted.
   */
  async replaceSecret(input: ReplaceSecretInput): Promise<CredentialMetadata> {
    const existing = await this.getMetadata(input.projectId, input.credentialId);
    if (!existing) {
      throw notFound("credential.not_found", "the credential was not found in this project");
    }
    if (existing.status === "revoked") {
      throw policyBlocked("credential.revoked", "a revoked credential cannot be replaced — create a new credential", {
        reason: "credential_revoked",
        credential_id: input.credentialId,
      });
    }
    validateSecret(input.secret);
    const newVersion = existing.currentVersion + 1;
    const blob = encryptSecret(this.masterKey, input.credentialId, input.secret);
    // Write-then-switch: the new blob exists before current_version
    // points at it; then the old blob is deleted so it can never be
    // resolved again (concurrent resolvers reading the old version fail
    // closed via the version check + missing blob).
    await this.storage.put({
      key: this.storageKey(input.credentialId, newVersion),
      body: Buffer.from(blob, "utf8"),
      contentType: "application/octet-stream",
    });
    await this.db.exec({
      text: `UPDATE cp_credentials
             SET current_version = $1, updated_at = NOW()
             WHERE id = $2 AND project_id = $3 AND status = 'active'`,
      params: [newVersion, input.credentialId, input.projectId],
    });
    if (existing.currentVersion >= 1) {
      await this.storage.delete(this.storageKey(input.credentialId, existing.currentVersion)).catch(() => {});
    }
    this.logger.info("credentials: secret replaced (rotated)", {
      credential_id: input.credentialId,
      new_version: newVersion,
      project_id: input.projectId,
      organization_id: input.organizationId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireMetadata(input.projectId, input.credentialId);
  }

  /**
   * Revoke a credential: status → revoked and the current secret blob is
   * DELETED (the metadata row remains for audit). A revoked credential
   * never resolves again.
   */
  async revokeCredential(input: RevokeCredentialInput): Promise<CredentialMetadata> {
    const existing = await this.getMetadata(input.projectId, input.credentialId);
    if (!existing) {
      throw notFound("credential.not_found", "the credential was not found in this project");
    }
    await this.db.exec({
      text: `UPDATE cp_credentials SET status = 'revoked', updated_at = NOW()
             WHERE id = $1 AND project_id = $2`,
      params: [input.credentialId, input.projectId],
    });
    if (existing.currentVersion >= 1) {
      await this.storage.delete(this.storageKey(input.credentialId, existing.currentVersion)).catch(() => {});
    }
    this.logger.info("credentials: revoked", {
      credential_id: input.credentialId,
      project_id: input.projectId,
      organization_id: input.organizationId,
      user_id: input.actingPrincipal.userId,
    });
    return this.requireMetadata(input.projectId, input.credentialId);
  }

  // ---- Metadata reads (SAFE — never secret material) --------------------------

  async getMetadata(projectId: string, credentialId: string): Promise<CredentialMetadata | null> {
    const rows = await this.db.query({
      text: `SELECT * FROM cp_credentials WHERE id = $1 AND project_id = $2`,
      params: [credentialId, projectId],
    });
    const row = rows[0];
    return row ? mapCredential(row as CredentialRow) : null;
  }

  async listCredentials(
    projectId: string,
    opts: ListCredentialsOptions = {},
  ): Promise<CredentialPage> {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: string[] = [`project_id = $1`];
    const params: unknown[] = [projectId];
    if (!opts.includeRevoked) {
      where.push(`status = 'active'`);
    }
    if (opts.cursor) {
      params.push(opts.cursor);
      where.push(`id < $${params.length}`);
    }
    const rows = await this.db.query({
      text: `SELECT * FROM cp_credentials WHERE ${where.join(" AND ")}
             ORDER BY id DESC LIMIT ${limit + 1}`,
      params,
    });
    const all = rows.map((r) => mapCredential(r as CredentialRow));
    const page = all.slice(0, limit);
    const nextCursor = all.length > limit ? page[page.length - 1]!.id : null;
    return { credentials: page, nextCursor };
  }

  // ---- The secret resolution boundary (§8, §10, §31) ----------------------------

  /**
   * Resolve secret material for the execution/provider-adapter boundary
   * ONLY. Requires the branded AdapterCredentialGrant; a revoked
   * credential or a missing/corrupted blob fails closed. Never called by
   * HTTP handlers — there is no resolve endpoint.
   */
  async resolveForAdapter(input: ResolveCredentialInput): Promise<ResolvedSecret> {
    const metadata = await this.getMetadata(input.projectId, input.credentialId);
    if (!metadata) {
      throw notFound("credential.not_found", "the credential was not found in this project");
    }
    if (metadata.status !== "active") {
      throw policyBlocked("credential.revoked", "the credential is revoked and cannot be resolved", {
        reason: "credential_revoked",
        credential_id: input.credentialId,
      });
    }
    if (metadata.currentVersion < 1) {
      throw policyBlocked("credential.secret.missing", "the credential has no stored secret version", {
        reason: "no_secret_version",
        credential_id: input.credentialId,
      });
    }
    let blobBytes: Uint8Array;
    try {
      blobBytes = await this.storage.get(this.storageKey(input.credentialId, metadata.currentVersion));
    } catch {
      throw new AppError({
        category: "PLATFORM_FAILURE",
        code: "credential.secret.storage_unavailable",
        message: "the credential secret could not be read from secure storage",
        retryable: true,
      });
    }
    const value = decryptSecret(this.masterKey, input.credentialId, Buffer.from(blobBytes).toString("utf8"));
    // Log SAFE metadata only — never the value, its length, or hashes.
    this.logger.info("credentials: resolved for adapter boundary", {
      credential_id: input.credentialId,
      kind: metadata.kind,
      version: metadata.currentVersion,
      project_id: input.projectId,
      organization_id: input.organizationId,
    });
    return { credentialId: input.credentialId, kind: metadata.kind, value };
  }

  // ---- internal helpers ----------------------------------------------------------

  private storageKey(credentialId: string, version: number): string {
    return `${STORAGE_PREFIX}/${credentialId}/v${version}`;
  }

  private async requireMetadata(projectId: string, credentialId: string): Promise<CredentialMetadata> {
    const meta = await this.getMetadata(projectId, credentialId);
    if (!meta) {
      throw new AppError({
        category: "PLATFORM_FAILURE",
        code: "credential.readback.failed",
        message: "credential operation succeeded but the metadata row could not be read back",
        retryable: false,
      });
    }
    return meta;
  }
}

// ---- Row mapper + validation helpers --------------------------------------------

interface CredentialRow extends DbQueryResultRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  status: string;
  current_version: number;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapCredential(row: CredentialRow): CredentialMetadata {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    status: row.status as CredentialStatus,
    currentVersion: Number(row.current_version),
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function validateKind(kind: string): string {
  if (typeof kind !== "string" || !isCredentialKind(kind)) {
    throw policyBlocked("credential.validation", `kind must be one of ${CREDENTIAL_KINDS.join("|")}`, {
      reason: "invalid_kind",
    });
  }
  return kind;
}

function validateName(name: string): string {
  const trimmed = (typeof name === "string" ? name : "").trim();
  if (trimmed.length === 0) {
    throw policyBlocked("credential.validation", "credential name is required", { reason: "missing_name" });
  }
  if (trimmed.length > MAX_NAME_LEN) {
    throw policyBlocked("credential.validation", `credential name may be at most ${MAX_NAME_LEN} characters`, {
      reason: "name_too_long",
    });
  }
  return trimmed;
}

function validateSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length === 0) {
    throw policyBlocked("credential.validation", "secret is required", { reason: "missing_secret" });
  }
  if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) {
    throw policyBlocked("credential.validation", "secret exceeds the maximum size", { reason: "secret_too_large" });
  }
}

function policyBlocked(code: string, message: string, details?: Record<string, unknown>): AppError {
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
