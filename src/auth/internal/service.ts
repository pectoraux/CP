// /auth/internal/service.ts
// AuthService — the /auth module's concrete service (architecture §36, §30,
// §2.16, §2.17, WORK-003 §4, §6, §10, §12, §13, §14).
//
// Owns:
//   - user identity (cp_users table): create, lookup, disable
//   - API key / credential lifecycle (cp_api_keys table): issue, verify,
//     revoke, list
//   - password credential verification (verifyPasswordCredential)
//
// The service depends ONLY on the provider-neutral platform `Database`
// interface (architecture §9, WORK-003 §9). The `pg` driver is isolated to
// /platform internals and never imported here.
//
// Failure model (architecture §31, WORK-003 §12):
//   - CREDENTIAL_FAILURE: bad password, bad/expired/revoked API key,
//     disabled user, unknown user. All return 401 via the API middleware.
//   - POLICY_BLOCKED: insufficient role / suspended membership — used by
//     /organizations, not this file.
//   - PLATFORM_FAILURE: unexpected DB errors.
//
// Security properties:
//   - Raw API keys are returned ONCE at creation; only SHA-256 hashes are
//     stored (WORK-003 §13).
//   - Passwords are hashed with scrypt; never logged, never returned.
//   - Unknown-user login runs a dummy hash compare so response timing
//     matches wrong-password timing (account-enumeration mitigation,
//     WORK-003 §12).
//   - API key verification is constant-time; revoked/expired keys fail
//     before the secret comparison is reported as valid.

import {
  AppError,
  type Database,
  type DbQueryResultRow,
  type DbTransaction,
  ulid,
  Logger,
  type LogSink,
  type LogRecord,
} from "@cp/platform";
import {
  generateApiKey,
  hashApiKey,
  parseApiKeyId,
  constantTimeHexEqual,
} from "./api-key.ts";
import {
  hashPassword,
  verifyPasswordHash,
  verifyDummyPassword,
} from "./password.ts";

// ---- Public record types ----------------------------------------------

export interface UserRecord {
  id: string;
  email: string;
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string | null;
  scopes: readonly string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface CreatedApiKey {
  /** The full raw key. Returned ONCE; the caller must store it. */
  rawKey: string;
  record: ApiKeyRecord;
}

export interface CreateUserInput {
  email: string;
  password: string;
}

export interface CreateApiKeyInput {
  userId: string;
  name?: string | null;
  scopes?: readonly string[];
  /** Optional expiry (Date or epoch ms). Null/undefined = no expiry. */
  expiresAt?: Date | null;
}

export interface VerifiedCredential {
  userId: string;
  user: UserRecord;
}

// ---- Row mappers ------------------------------------------------------

interface UserRow extends DbQueryResultRow {
  id: string;
  email: string;
  password_hash: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ApiKeyRow extends DbQueryResultRow {
  id: string;
  user_id: string;
  name: string | null;
  key_hash: string;
  scopes: unknown;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  last_used_at: Date | string | null;
  created_at: Date | string;
}

function mapUser(r: UserRow): UserRecord {
  return {
    id: r.id as string,
    email: r.email as string,
    status: r.status === "disabled" ? "disabled" : "active",
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function mapApiKey(r: ApiKeyRow): ApiKeyRecord {
  const scopesRaw = r.scopes;
  let scopes: string[];
  if (Array.isArray(scopesRaw)) {
    scopes = scopesRaw.filter((s): s is string => typeof s === "string");
  } else {
    scopes = [];
  }
  const expiresAt = r.expires_at == null ? null : new Date(r.expires_at as string);
  const revokedAt = r.revoked_at == null ? null : new Date(r.revoked_at as string);
  const lastUsedAt = r.last_used_at == null ? null : new Date(r.last_used_at as string);
  return {
    id: r.id as string,
    userId: r.user_id as string,
    name: r.name as string | null,
    scopes,
    expiresAt,
    revokedAt,
    lastUsedAt,
    createdAt: new Date(r.created_at as string),
  };
}

// ---- Errors ------------------------------------------------------------

function credentialFailure(message: string, details?: Record<string, unknown>): AppError {
  return new AppError({
    category: "CREDENTIAL_FAILURE",
    code: "auth.credential",
    message,
    retryable: false,
    details,
  });
}

function platformFailure(message: string, cause?: unknown): AppError {
  return new AppError({
    category: "PLATFORM_FAILURE",
    code: "auth.platform",
    message,
    retryable: false,
    cause,
  });
}

/**
 * Detect a PostgreSQL unique_violation (SQLSTATE 23505) across the
 * platform's normalized AppError wrapper. `normalizePgError` puts the
 * driver code in `details.driverCode`; the raw pg error (preserved as the
 * AppError's `causeValue`) also carries `code`. This helper checks both so
 * the service can map duplicate inserts to a domain failure (e.g.
 * duplicate email → CREDENTIAL_FAILURE) rather than a generic
 * PLATFORM_FAILURE.
 */
function isUniqueViolation(err: unknown): boolean {
  if (err instanceof AppError) {
    const dc = err.details?.driverCode;
    if (dc === "23505") return true;
    const causeCode = (err.causeValue as { code?: string } | undefined)?.code;
    if (causeCode === "23505") return true;
    return false;
  }
  const rawCode = (err as { code?: string } | undefined)?.code;
  return rawCode === "23505";
}

// ---- Service -----------------------------------------------------------

export interface AuthServiceOptions {
  db: Database;
  logger?: Logger;
}

export class AuthService {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(opts: AuthServiceOptions) {
    this.db = opts.db;
    // Logger is optional to keep tests simple; the platform's defaultLogger
    // is used when none is provided.
    // Use a lazy import-safe fallback: import here would create a cycle in
    // some bundlers, so we accept undefined and handle it.
    this.logger = opts.logger ?? createSilentLogger();
  }

  // ---- Users -----------------------------------------------------------

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const email = normalizeEmail(input.email);
    if (!isValidEmail(email)) {
      throw credentialFailure("email is not valid", { reason: "malformed_email" });
    }
    if (typeof input.password !== "string" || input.password.length < 8) {
      throw credentialFailure("password must be at least 8 characters", {
        reason: "weak_password",
      });
    }
    const id = `usr_${ulid()}`;
    const { value: passwordHash } = hashPassword(input.password);
    try {
      await this.db.exec({
        text: `INSERT INTO cp_users (id, email, password_hash, status)
               VALUES ($1, $2, $3, 'active')`,
        params: [id, email, passwordHash],
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw credentialFailure("an account with this email already exists", {
          reason: "duplicate_email",
        });
      }
      throw platformFailure("createUser failed", err);
    }
    const user = await this.getUser(id);
    if (!user) {
      throw platformFailure("createUser: user disappeared after insert");
    }
    this.logger.info("auth: user created", { user_id: id });
    return user;
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const rows = await this.db.query({
      text: `SELECT id, email, password_hash, status, created_at, updated_at
             FROM cp_users WHERE id = $1`,
      params: [id],
    });
    const row = rows[0];
    return row ? mapUser(row as UserRow) : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const canonical = normalizeEmail(email);
    const rows = await this.db.query({
      text: `SELECT id, email, password_hash, status, created_at, updated_at
             FROM cp_users WHERE lower(email) = lower($1)`,
      params: [canonical],
    });
    const row = rows[0];
    return row ? mapUser(row as UserRow) : null;
  }

  async disableUser(id: string): Promise<void> {
    await this.db.exec({
      text: `UPDATE cp_users SET status = 'disabled', updated_at = NOW()
             WHERE id = $1`,
      params: [id],
    });
    this.logger.info("auth: user disabled", { user_id: id });
  }

  // ---- Password credential verification -------------------------------

  /**
   * Verify an email+password credential and return the authenticated user.
   * Throws CREDENTIAL_FAILURE on any failure (unknown user, wrong password,
   * disabled user). Unknown-user runs a dummy hash compare to equalize
   * timing (account-enumeration mitigation, WORK-003 §12).
   */
  async verifyPasswordCredential(input: {
    email: string;
    password: string;
  }): Promise<VerifiedCredential> {
    const canonical = normalizeEmail(input.email);
    const user = await this.getUserByEmail(canonical);
    if (!user) {
      // Equalize timing: run a real-but-failing comparison.
      verifyDummyPassword(input.password);
      throw credentialFailure("invalid credentials", { reason: "unknown_user" });
    }
    if (user.status === "disabled") {
      verifyDummyPassword(input.password);
      throw credentialFailure("invalid credentials", { reason: "disabled" });
    }
    // Load the stored hash for this user.
    const rows = await this.db.query({
      text: `SELECT password_hash FROM cp_users WHERE id = $1`,
      params: [user.id],
    });
    const stored = rows[0]?.password_hash as string | undefined;
    if (typeof stored !== "string" || !verifyPasswordHash(input.password, stored)) {
      throw credentialFailure("invalid credentials", { reason: "wrong_password" });
    }
    return { userId: user.id, user };
  }

  // ---- API keys -------------------------------------------------------

  /**
   * Issue a new API key for a user. The raw key is returned ONCE; only the
   * SHA-256 hash is persisted. The caller is responsible for delivering the
   * raw key to the user and never storing it server-side.
   */
  async createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    if (typeof input.userId !== "string" || input.userId.length === 0) {
      throw credentialFailure("userId is required", { reason: "missing_user" });
    }
    const user = await this.getUser(input.userId);
    if (!user) {
      throw credentialFailure("user not found", { reason: "unknown_user" });
    }
    if (user.status === "disabled") {
      throw credentialFailure("user is disabled", { reason: "disabled" });
    }
    const { id, rawKey, keyHash } = generateApiKey();
    const scopes = input.scopes ?? [];
    const expiresAt = input.expiresAt ?? null;
    await this.db.exec({
      text: `INSERT INTO cp_api_keys
              (id, user_id, name, key_hash, scopes, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())`,
      params: [
        id,
        input.userId,
        input.name ?? null,
        keyHash,
        JSON.stringify(scopes),
        expiresAt,
      ],
    });
    const record: ApiKeyRecord = {
      id,
      userId: input.userId,
      name: input.name ?? null,
      scopes,
      expiresAt: expiresAt ? new Date(expiresAt.getTime()) : null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
    };
    this.logger.info("auth: api key issued", {
      user_id: input.userId,
      key_id: id,
    });
    return { rawKey, record };
  }

  /**
   * Verify a raw API key and return the authenticated user id + key id.
   * Throws CREDENTIAL_FAILURE on any failure (malformed, unknown, revoked,
   * expired, wrong secret, disabled user). Constant-time hash comparison.
   */
  async verifyApiKey(rawKey: string): Promise<{
    userId: string;
    keyId: string;
  }> {
    const keyId = parseApiKeyId(rawKey);
    if (keyId === null) {
      throw credentialFailure("invalid api key", { reason: "malformed" });
    }
    const rows = await this.db.query({
      text: `SELECT id, user_id, key_hash, scopes, expires_at, revoked_at
             FROM cp_api_keys WHERE id = $1`,
      params: [keyId],
    });
    const row = rows[0] as ApiKeyRow | undefined;
    if (!row) {
      throw credentialFailure("invalid api key", { reason: "unknown_key" });
    }
    if (row.revoked_at != null) {
      throw credentialFailure("api key revoked", { reason: "revoked" });
    }
    if (row.expires_at != null) {
      const exp = new Date(row.expires_at as string);
      if (exp.getTime() <= Date.now()) {
        throw credentialFailure("api key expired", { reason: "expired" });
      }
    }
    const computedHash = hashApiKey(rawKey);
    if (!constantTimeHexEqual(computedHash, row.key_hash as string)) {
      throw credentialFailure("invalid api key", { reason: "wrong_secret" });
    }
    // Verify the user still exists and is active.
    const user = await this.getUser(row.user_id as string);
    if (!user) {
      throw credentialFailure("invalid api key", { reason: "unknown_user" });
    }
    if (user.status === "disabled") {
      throw credentialFailure("user is disabled", { reason: "disabled" });
    }
    // Fire-and-forget last_used_at update — must not block verification or
    // cause a failure if the update errors. Use a separate try/catch.
    this.touchLastUsed(keyId).catch((err) => {
      this.logger.warn("auth: last_used_at update failed", {
        key_id: keyId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { userId: row.user_id as string, keyId };
  }

  private async touchLastUsed(keyId: string): Promise<void> {
    await this.db.exec({
      text: `UPDATE cp_api_keys SET last_used_at = NOW() WHERE id = $1`,
      params: [keyId],
    });
  }

  async revokeApiKey(keyId: string): Promise<void> {
    const res = await this.db.exec({
      text: `UPDATE cp_api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
      params: [keyId],
    });
    if (res.affectedRows === 0) {
      // Already revoked or never existed — treat as not-found credential.
      throw credentialFailure("api key not found or already revoked", {
        reason: "not_found",
      });
    }
    this.logger.info("auth: api key revoked", { key_id: keyId });
  }

  async listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.db.query({
      text: `SELECT id, user_id, name, key_hash, scopes, expires_at, revoked_at,
              last_used_at, created_at
             FROM cp_api_keys WHERE user_id = $1
             ORDER BY created_at DESC`,
      params: [userId],
    });
    return rows.map((r) => mapApiKey(r as ApiKeyRow));
  }

  // ---- Transactions (used by /organizations via the shared Database) --

  /**
   * Run `fn` inside a database transaction. Exposed so /organizations can
   * compose multi-step membership operations atomically using the SAME
   * database connection (e.g. create-org + initial-owner-membership).
   * The function receives a DbTransaction whose query/exec are scoped to
   * the transaction.
   */
  runInTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }
}

// ---- Helpers -----------------------------------------------------------

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Minimal email shape check — not RFC-perfect, but rejects obviously
// malformed input (no @, empty local part, no domain). Sufficient for
// WORK-003; full validation is out of scope.
function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > 254) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes(".")) return false;
  // No whitespace anywhere.
  if (/\s/.test(email)) return false;
  return true;
}

// A silent logger used when none is provided. Constructed from the real
// platform Logger class with a no-op sink so the object behaves identically
// to a normal Logger. Tests that want to assert on log records pass a
// CapturingLogSink-backed Logger via AuthServiceOptions.
const NOOP_SINK: LogSink = { emit: (_record: LogRecord) => {} };
function createSilentLogger(): Logger {
  return new Logger({ sink: NOOP_SINK, level: "warn" });
}
