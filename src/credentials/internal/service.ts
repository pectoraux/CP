// /credentials/internal/service.ts
// The /credentials module's concrete implementation (WORK-010, architecture
// §2.17, §30, §36; lock §10; frozen CONN/CRED requirements). THE
// secret-access boundary of the platform:
//
//   CredentialMetadata (PostgreSQL)  ≠  SecretMaterial (encrypted blob
//                                       in platform ObjectStorage)
//
//   /credentials owns secret access policy + metadata;
//   /platform owns the generic storage infrastructure. The physical
//   storage mechanism stays behind this boundary (WORK-010 §26).
//
// RUNTIME CAPABILITY BOUNDARY (architect review of PR #9):
//   The previous design exposed a publicly callable grant-minting method
//   (issueAdapterGrant) whose TypeScript brand is erased at runtime — any
//   code holding the service instance could mint the "grant" and resolve
//   raw secrets. That flaw is corrected with OBJECT-CAPABILITY ownership:
//
//   - CredentialsService is METADATA-ONLY (getMetadata / listCredentials).
//     It has NO mutation and NO resolution methods — there is nothing to
//     call, so holding it grants nothing beyond safe metadata reads.
//
//   - Credential mutation authority (create / replace / revoke) and
//     adapter-boundary resolution authority each exist as SEPARATE,
//     FROZEN capability objects:
//
//         createCredentialsBoundary(opts)
//              ↓ (the single construction entry — the composition root)
//         { service, mutationAuthority, adapterResolver }
//
//     The composition root hands `service` + `mutationAuthority` to the
//     /connections layer and reserves `adapterResolver` for the future
//     execution/provider-adapter seam (WORK-014), which RECEIVES it by
//     injection. There is NO minting method anywhere in the codebase: no
//     method on any distributed object can produce a new authority. The
//     authority IS the object reference; security is enforced by runtime
//     object ownership (references propagate ONLY via explicit
//     injection from the composition root) — not by a TypeScript brand.
//
//   - The capability objects are Object.freeze'd: methods cannot be
//     swapped or extended at runtime.
//
// SECRET BOUNDARY (§6-§10, §31):
//   - Connection rows store only a credential REFERENCE (id) — never
//     api keys, secrets, passwords, private keys, or OAuth tokens.
//   - Secret material is encrypted (AES-256-GCM, HKDF-derived
//     per-record key, deployment master key) and stored in the platform
//     ObjectStorage at credentials/{id}/v{n} — never in PostgreSQL.
//   - adapterResolver.resolve() is the ONLY path that returns a secret
//     value. Revoked credentials never resolve. Rotation (replaceSecret)
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

/**
 * The METADATA-ONLY service surface. Holding a CredentialsService
 * reference grants exactly: project-scoped metadata reads. There is NO
 * mutation method and NO resolution method on this class — by design
 * (architect review of PR #9): the old grant-minting method is gone, and
 * mutation/resolution authority exists only as separate capability
 * objects handed out by createCredentialsBoundary().
 */
export class CredentialsService {
  private readonly core: CredentialsCore;

  /** @internal — construct via createCredentialsBoundary(). */
  constructor(core: CredentialsCore) {
    this.core = core;
  }

  async getMetadata(projectId: string, credentialId: string): Promise<CredentialMetadata | null> {
    return getMetadata(this.core, projectId, credentialId);
  }

  async listCredentials(
    projectId: string,
    opts: ListCredentialsOptions = {},
  ): Promise<CredentialPage> {
    return listCredentials(this.core, projectId, opts);
  }
}

/**
 * Credential MUTATION authority: create / rotate (replace) / revoke.
 * Handed out ONLY by createCredentialsBoundary(); the composition root
 * injects it into the /connections layer (which performs the tenant
 * authorization before every call). Frozen at runtime.
 */
export interface CredentialMutationAuthority {
  createCredential(input: CreateCredentialInput): Promise<CredentialMetadata>;
  replaceSecret(input: ReplaceSecretInput): Promise<CredentialMetadata>;
  revokeCredential(input: RevokeCredentialInput): Promise<CredentialMetadata>;
}

/**
 * The RUNTIME capability for the execution/provider-adapter seam: the
 * ONLY object in the system that can resolve secret material. Received
 * by injection (WORK-014's execution layer will be handed this object at
 * composition); there is no way to mint, derive, or otherwise obtain
 * one except by being given the reference. Frozen at runtime.
 */
export interface AdapterCredentialResolver {
  resolve(input: ResolveCredentialInput): Promise<ResolvedSecret>;
}

/** The full construction result — the single capability distribution point. */
export interface CredentialsBoundary {
  /** Metadata-only reads. */
  service: CredentialsService;
  /** Create/replace/revoke — inject into the connection layer. */
  mutationAuthority: CredentialMutationAuthority;
  /** Secret resolution — reserve for the execution/provider-adapter seam. */
  adapterResolver: AdapterCredentialResolver;
}

export interface CredentialsBoundaryOptions {
  db: Database;
  /** The platform object-storage boundary (real S3-compatible storage). */
  storage: ObjectStorage;
  /** 32-byte master key (hex). Defaults to CP_CREDENTIAL_MASTER_KEY. */
  masterKeyHex?: string;
  logger?: Logger;
}

interface CredentialsCore {
  db: Database;
  storage: ObjectStorage;
  masterKey: Buffer | null;
  logger: Logger;
}

const MAX_SECRET_BYTES = 64 * 1024; // 64 KiB
const MAX_NAME_LEN = 200;
const STORAGE_PREFIX = "credentials";

const NOOP_SINK: LogSink = {
  emit(_record: LogRecord): void {},
};

// ---- The capability distribution point --------------------------------------

/**
 * Construct the credentials boundary: the metadata service + the two
 * frozen capability objects. This is the SINGLE construction entry and
 * the composition root's capability distribution point:
 *
 *   - `service` + `mutationAuthority` are injected into /connections;
 *   - `adapterResolver` is RESERVED for the future execution/provider-
 *     adapter seam (WORK-014), which RECEIVES it by injection.
 *
 * There is no other way to obtain any of these objects, and no method on
 * any of them can mint further authority (architect review of PR #9: the
 * runtime secret-resolution authority is object ownership, not a
 * TypeScript brand).
 */
export function createCredentialsBoundary(opts: CredentialsBoundaryOptions): CredentialsBoundary {
  const core: CredentialsCore = {
    db: opts.db,
    storage: opts.storage,
    masterKey: parseMasterKey(opts.masterKeyHex ?? process.env.CP_CREDENTIAL_MASTER_KEY),
    logger: opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" }),
  };
  const service = new CredentialsService(core);
  const mutationAuthority: CredentialMutationAuthority = Object.freeze({
    createCredential: (input: CreateCredentialInput) => createCredential(core, input),
    replaceSecret: (input: ReplaceSecretInput) => replaceSecret(core, input),
    revokeCredential: (input: RevokeCredentialInput) => revokeCredential(core, input),
  });
  const adapterResolver: AdapterCredentialResolver = Object.freeze({
    resolve: (input: ResolveCredentialInput) => resolveForAdapter(core, input),
  });
  return Object.freeze({ service, mutationAuthority, adapterResolver });
}

// ---- Mutation (module-private: reachable ONLY via the mutation capability) ----

/**
 * Create a tenant-scoped credential: metadata row in PostgreSQL +
 * encrypted secret blob in object storage. The secret parameter is
 * consumed here and NEVER persisted in any table, log, or response.
 */
async function createCredential(
  core: CredentialsCore,
  input: CreateCredentialInput,
): Promise<CredentialMetadata> {
  const kind = validateKind(input.kind);
  const name = validateName(input.name);
  validateSecret(input.secret);
  const id = `cred_${ulid()}`;
  const blob = encryptSecret(core.masterKey, id, input.secret);
  // Write the encrypted blob FIRST; the metadata row references a
  // credential whose secret already exists at version 1.
  await core.storage.put({
    key: storageKey(id, 1),
    body: Buffer.from(blob, "utf8"),
    contentType: "application/octet-stream",
  });
  try {
    await core.db.exec({
      text: `INSERT INTO cp_credentials
               (id, project_id, kind, name, status, current_version, created_by_user_id)
             VALUES ($1, $2, $3, $4, 'active', 1, $5)`,
      params: [id, input.projectId, kind, name, input.actingPrincipal.userId],
    });
  } catch (err) {
    // Metadata insert failed (duplicate name?) — remove the orphaned
    // blob so no secret material outlives its metadata row.
    await core.storage.delete(storageKey(id, 1)).catch(() => {});
    if (isUniqueViolation(err)) {
      throw policyBlocked("credential.duplicate", "a credential with this name already exists in this project", {
        reason: "duplicate_name",
      });
    }
    throw err;
  }
  core.logger.info("credentials: created", {
    credential_id: id,
    kind,
    project_id: input.projectId,
    organization_id: input.organizationId,
    user_id: input.actingPrincipal.userId,
    // NEVER the secret, its length, or any derived hash.
  });
  return requireMetadata(core, input.projectId, id);
}

/**
 * Rotate the secret: write a NEW encrypted version and delete the old
 * blob within one operation — the credential identity stays stable
 * (WORK-010 §22). Old versions cannot be resurrected: the resolver
 * reads only current_version, and the previous blob is deleted.
 */
async function replaceSecret(
  core: CredentialsCore,
  input: ReplaceSecretInput,
): Promise<CredentialMetadata> {
  const existing = await getMetadata(core, input.projectId, input.credentialId);
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
  const blob = encryptSecret(core.masterKey, input.credentialId, input.secret);
  // Write-then-switch: the new blob exists before current_version
  // points at it; then the old blob is deleted so it can never be
  // resolved again (concurrent resolvers reading the old version fail
  // closed via the version check + missing blob).
  await core.storage.put({
    key: storageKey(input.credentialId, newVersion),
    body: Buffer.from(blob, "utf8"),
    contentType: "application/octet-stream",
  });
  await core.db.exec({
    text: `UPDATE cp_credentials
           SET current_version = $1, updated_at = NOW()
           WHERE id = $2 AND project_id = $3 AND status = 'active'`,
    params: [newVersion, input.credentialId, input.projectId],
  });
  if (existing.currentVersion >= 1) {
    await core.storage.delete(storageKey(input.credentialId, existing.currentVersion)).catch(() => {});
  }
  core.logger.info("credentials: secret replaced (rotated)", {
    credential_id: input.credentialId,
    new_version: newVersion,
    project_id: input.projectId,
    organization_id: input.organizationId,
    user_id: input.actingPrincipal.userId,
  });
  return requireMetadata(core, input.projectId, input.credentialId);
}

/**
 * Revoke a credential: status → revoked and the current secret blob is
 * DELETED (the metadata row remains for audit). A revoked credential
 * never resolves again.
 */
async function revokeCredential(
  core: CredentialsCore,
  input: RevokeCredentialInput,
): Promise<CredentialMetadata> {
  const existing = await getMetadata(core, input.projectId, input.credentialId);
  if (!existing) {
    throw notFound("credential.not_found", "the credential was not found in this project");
  }
  await core.db.exec({
    text: `UPDATE cp_credentials SET status = 'revoked', updated_at = NOW()
           WHERE id = $1 AND project_id = $2`,
    params: [input.credentialId, input.projectId],
  });
  if (existing.currentVersion >= 1) {
    await core.storage.delete(storageKey(input.credentialId, existing.currentVersion)).catch(() => {});
  }
  core.logger.info("credentials: revoked", {
    credential_id: input.credentialId,
    project_id: input.projectId,
    organization_id: input.organizationId,
    user_id: input.actingPrincipal.userId,
  });
  return requireMetadata(core, input.projectId, input.credentialId);
}

// ---- Metadata reads (SAFE — never secret material) --------------------------

async function getMetadata(
  core: CredentialsCore,
  projectId: string,
  credentialId: string,
): Promise<CredentialMetadata | null> {
  const rows = await core.db.query({
    text: `SELECT * FROM cp_credentials WHERE id = $1 AND project_id = $2`,
    params: [credentialId, projectId],
  });
  const row = rows[0];
  return row ? mapCredential(row as CredentialRow) : null;
}

async function listCredentials(
  core: CredentialsCore,
  projectId: string,
  opts: ListCredentialsOptions,
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
  const rows = await core.db.query({
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
 * ONLY — reachable exclusively through the frozen adapterResolver
 * capability object (there is no other entry point). A revoked
 * credential or a missing/corrupted blob fails closed.
 */
async function resolveForAdapter(
  core: CredentialsCore,
  input: ResolveCredentialInput,
): Promise<ResolvedSecret> {
  const metadata = await getMetadata(core, input.projectId, input.credentialId);
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
    blobBytes = await core.storage.get(storageKey(input.credentialId, metadata.currentVersion));
  } catch {
    throw new AppError({
      category: "PLATFORM_FAILURE",
      code: "credential.secret.storage_unavailable",
      message: "the credential secret could not be read from secure storage",
      retryable: true,
    });
  }
  const value = decryptSecret(core.masterKey, input.credentialId, Buffer.from(blobBytes).toString("utf8"));
  // Log SAFE metadata only — never the value, its length, or hashes.
  core.logger.info("credentials: resolved for adapter boundary", {
    credential_id: input.credentialId,
    kind: metadata.kind,
    version: metadata.currentVersion,
    project_id: input.projectId,
    organization_id: input.organizationId,
  });
  return { credentialId: input.credentialId, kind: metadata.kind, value };
}

// ---- internal helpers ----------------------------------------------------------

function storageKey(credentialId: string, version: number): string {
  return `${STORAGE_PREFIX}/${credentialId}/v${version}`;
}

async function requireMetadata(
  core: CredentialsCore,
  projectId: string,
  credentialId: string,
): Promise<CredentialMetadata> {
  const meta = await getMetadata(core, projectId, credentialId);
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
