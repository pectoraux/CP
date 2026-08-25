// /api/internal/idempotency.ts
// Idempotency support for side-effecting /v1 API requests
// (architecture §23, architecture-lock §9, §11, WORK-004 API-002).
//
// The `/v1` API must support idempotency keys so a client may safely retry a
// side-effecting request (POST/PATCH/DELETE) without producing a duplicate
// effect. Concretely: when a request carries an `Idempotency-Key` header,
// the server remembers the (key, user) → (request fingerprint, response)
// mapping for a bounded TTL; a replay of the same key + same request body
// returns the stored response; a replay of the same key with a DIFFERENT
// body is rejected (409).
//
// Storage authority (architecture-lock §1): PostgreSQL is the authoritative
// store for idempotency records (they determine the response to a request,
// i.e. control-plane state). Redis is not used here. The store depends only
// on the provider-neutral platform `Database` interface — `pg` is isolated
// to /platform internals.
//
// Concurrency model (reserve-then-execute):
//   1. Reserve the key: DELETE any expired row for (key, user), then INSERT
//      a "pending" row (response_status NULL). The UNIQUE(key, user_id)
//      constraint means exactly one request wins the reservation.
//   2. If the reservation INSERT hits a unique violation, a concurrent
//      request is in flight (or done): fetch the existing row.
//        - different request body hash  → 409 (key reused with a different
//          request — the client must use a new key)
//        - same body, response present  → return the cached response
//        - same body, response absent  → 409 (in-flight; the client should
//          back off and retry the SAME key)
//   3. The reservation-holder runs the handler. On a 2xx/4xx response the
//      row is finalized with the response. On a 5xx (transient) the
//      reservation is deleted so the same key can be retried.
//
// This prevents double-execution of side effects under concurrent replay:
// only the reservation-holder runs the handler; concurrent repliers see the
// pending row and get 409 (in-flight) or, after completion, the cached
// response.

import { createHash } from "node:crypto";
import type { Context } from "hono";
import {
  type Database,
  type DbQueryResultRow,
  AppError,
  ulid,
  Logger,
  type LogSink,
  type LogRecord,
} from "@cp/platform";
import type { Principal } from "@cp/auth";
import type { AuthVars } from "./middleware.ts";

// ---- Schema -----------------------------------------------------------

export const IDEMPOTENCY_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cp_idempotency (
    id                       TEXT PRIMARY KEY,
    key                      TEXT NOT NULL,
    user_id                  TEXT NOT NULL,
    organization_id          TEXT,
    request_method           TEXT NOT NULL,
    request_path             TEXT NOT NULL,
    request_body_hash        TEXT NOT NULL,
    response_status          INTEGER,
    response_body           TEXT,
    response_content_type   TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at               TIMESTAMPTZ NOT NULL
  )`,
  // One record per (key, user). A key is unique within a user's scope; two
  // different users may independently use the same key string.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_idempotency_key_user_uidx
    ON cp_idempotency (key, user_id)`,
  `CREATE INDEX IF NOT EXISTS cp_idempotency_user_expires_idx
    ON cp_idempotency (user_id, expires_at)`,
];

export async function migrateIdempotencySchema(db: Database): Promise<void> {
  for (const stmt of IDEMPOTENCY_SCHEMA_STATEMENTS) {
    await db.exec({ text: stmt, params: [] });
  }
}

// ---- Record types ------------------------------------------------------

interface IdempotencyRow extends DbQueryResultRow {
  id: string;
  key: string;
  user_id: string;
  organization_id: string | null;
  request_method: string;
  request_path: string;
  request_body_hash: string;
  response_status: number | null;
  response_body: string | null;
  response_content_type: string | null;
  created_at: Date | string;
  expires_at: Date | string;
}

export interface IdempotencyRecord {
  key: string;
  userId: string;
  organizationId: string | null;
  requestMethod: string;
  requestPath: string;
  requestBodyHash: string;
  responseStatus: number | null;
  responseBody: string | null;
  responseContentType: string | null;
}

function mapRow(r: IdempotencyRow): IdempotencyRecord {
  return {
    key: r.key as string,
    userId: r.user_id as string,
    organizationId: (r.organization_id as string | null) ?? null,
    requestMethod: r.request_method as string,
    requestPath: r.request_path as string,
    requestBodyHash: r.request_body_hash as string,
    responseStatus: typeof r.response_status === "number" ? r.response_status : null,
    responseBody: (r.response_body as string | null) ?? null,
    responseContentType: (r.response_content_type as string | null) ?? null,
  };
}

// ---- Store ------------------------------------------------------------

export interface IdempotencyStoreOptions {
  db: Database;
  /** How long a key is remembered. Default 24h. */
  ttlMs?: number;
  logger?: Logger;
}

const NOOP_SINK: LogSink = { emit: (_r: LogRecord) => {} };
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class IdempotencyStore {
  private readonly db: Database;
  private readonly ttlMs: number;
  private readonly logger: Logger;

  constructor(opts: IdempotencyStoreOptions) {
    this.db = opts.db;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.logger = opts.logger ?? new Logger({ sink: NOOP_SINK, level: "warn" });
  }

  /**
   * Look up an existing (non-expired) record for (key, user). Returns null
   * if none exists or the existing one has expired.
   */
  async get(key: string, userId: string): Promise<IdempotencyRecord | null> {
    const rows = await this.db.query({
      text: `SELECT id, key, user_id, organization_id, request_method,
                request_path, request_body_hash, response_status,
                response_body, response_content_type, created_at, expires_at
             FROM cp_idempotency
             WHERE key = $1 AND user_id = $2 AND expires_at > NOW()`,
      params: [key, userId],
    });
    const row = rows[0];
    return row ? mapRow(row as IdempotencyRow) : null;
  }

  /**
   * Reserve a key: delete any expired row for (key, user), then insert a
   * pending row. Returns true if this caller won the reservation, or the
   * existing record if a concurrent caller already holds it.
   */
  async reserve(input: {
    key: string;
    userId: string;
    organizationId?: string | null;
    requestMethod: string;
    requestPath: string;
    requestBodyHash: string;
  }): Promise<{ reserved: true } | { reserved: false; record: IdempotencyRecord }> {
    const id = `idm_${ulid()}`;
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    // Clear any expired reservation for this (key, user) so a fresh request
    // after TTL may reuse the key.
    await this.db.exec({
      text: `DELETE FROM cp_idempotency
             WHERE key = $1 AND user_id = $2 AND expires_at <= NOW()`,
      params: [input.key, input.userId],
    });
    try {
      await this.db.exec({
        text: `INSERT INTO cp_idempotency
                 (id, key, user_id, organization_id, request_method,
                  request_path, request_body_hash, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        params: [
          id,
          input.key,
          input.userId,
          input.organizationId ?? null,
          input.requestMethod,
          input.requestPath,
          input.requestBodyHash,
          expiresAt,
        ],
      });
      return { reserved: true };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent request won the reservation (or a non-expired one
        // still holds it). Fetch and return it.
        const existing = await this.get(input.key, input.userId);
        if (existing) {
          return { reserved: false, record: existing };
        }
        // Race: the row expired/was deleted between the INSERT failure and
        // the SELECT. Retry once.
        return this.reserve(input);
      }
      throw err;
    }
  }

  /**
   * Finalize a reservation with the captured response. Only call this on a
   * 2xx/4xx response (deterministic). For 5xx, use deleteReservation so the
   * client may retry with the same key.
   */
  async storeResponse(input: {
    key: string;
    userId: string;
    responseStatus: number;
    responseBody: string;
    responseContentType: string;
  }): Promise<void> {
    await this.db.exec({
      text: `UPDATE cp_idempotency
             SET response_status = $1,
                 response_body = $2,
                 response_content_type = $3
             WHERE key = $4 AND user_id = $5`,
      params: [
        input.responseStatus,
        input.responseBody,
        input.responseContentType,
        input.key,
        input.userId,
      ],
    });
  }

  /**
   * Delete a reservation (used on 5xx so the same key may be retried).
   */
  async deleteReservation(key: string, userId: string): Promise<void> {
    await this.db.exec({
      text: `DELETE FROM cp_idempotency WHERE key = $1 AND user_id = $2`,
      params: [key, userId],
    });
  }
}

// ---- Helpers ----------------------------------------------------------

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

/**
 * Compute the request fingerprint: sha256(method + path + body). The body is
 * the raw request text so semantically-identical JSON with different
 * whitespace is treated as different (clients SHOULD send identical bytes
 * on retry; this is the conservative, predictable choice).
 */
export function fingerprintRequest(
  method: string,
  path: string,
  bodyText: string,
): string {
  return createHash("sha256")
    .update(`${method}\n${path}\n${bodyText}`)
    .digest("hex");
}

// ---- Idempotency guard (handler-level helper) ------------------------

/**
 * The result of running the protected handler — the materialized Response
 * the server will return. Captured so withIdempotency can store it.
 */
export type HandlerFn = (
  body: Record<string, unknown> | null,
) => Promise<Response>;

/**
 * Run a side-effecting handler under idempotency protection. If the request
 * carries an `Idempotency-Key` header, the (key, user, request fingerprint,
 * response) is recorded in the idempotency store; a replay returns the
 * cached response. Without the header, the handler runs normally (opt-in).
 *
 * The body is read ONCE here and passed (parsed) to `fn` so the handler
 * does not need to re-read the consumed request stream.
 */
export async function withIdempotency(
  c: Context<{ Variables: AuthVars }>,
  store: IdempotencyStore,
  principal: Principal,
  fn: HandlerFn,
  opts?: {
    /**
     * WORK-010 §24-§25 (secrets + idempotency): optional transform applied
     * to the RAW request body text BEFORE fingerprinting, used by
     * secret-bearing endpoints to keep raw secret material out of the
     * persisted request fingerprint. The transform must be deterministic:
     * the same logical request (including the same secret) must produce
     * the same transformed text, while the raw secret itself is never
     * written to cp_idempotency (only the transformed fingerprint is).
     */
    fingerprintBody?: (bodyText: string) => string;
  },
): Promise<Response> {
  const key = c.req.header("idempotency-key");
  const userId = principal.userId;

  // Read the body once. For requests with no body, this is empty.
  let bodyText = "";
  try {
    bodyText = await c.req.text();
  } catch {
    bodyText = "";
  }
  const body = safeParseJson(bodyText);

  // No idempotency key → run normally. Still pass the parsed body so the
  // handler does not need to re-read the stream.
  if (!key || key.length === 0) {
    return fn(body);
  }

  const fingerprintText = opts?.fingerprintBody ? opts.fingerprintBody(bodyText) : bodyText;
  const requestHash = fingerprintRequest(c.req.method, c.req.path, fingerprintText);

  // An existing record for this (key, user)?
  const existing = await store.get(key, userId);
  if (existing) {
    if (existing.requestBodyHash !== requestHash) {
      // Same key, different body — the client reused a key with a different
      // request. Reject so the client surfaces the bug rather than silently
      // getting a stale response.
      return conflictResponse(
        c,
        "idempotency_key_reused",
        "Idempotency-Key was already used for a different request",
      );
    }
    if (existing.responseStatus === null || existing.responseBody === null) {
      // Same key + body, but a concurrent request is in flight.
      return conflictResponse(
        c,
        "idempotency_in_flight",
        "a request with this Idempotency-Key is already being processed",
      );
    }
    // Same key + body, completed → replay the cached response verbatim.
    return new Response(existing.responseBody, {
      status: existing.responseStatus,
      headers: {
        "content-type": existing.responseContentType ?? "application/json",
        "x-idempotent-replay": "true",
      },
    });
  }

  // Reserve the key (reserve-then-execute prevents double side-effects).
  const orgId = c.get("orgContext")?.organizationId ?? null;
  const reservation = await store.reserve({
    key,
    userId,
    organizationId: orgId,
    requestMethod: c.req.method,
    requestPath: c.req.path,
    requestBodyHash: requestHash,
  });
  if (!reservation.reserved) {
    // A concurrent caller won the reservation between our get() and
    // reserve(). Re-evaluate against the now-current record.
    const record = reservation.record;
    if (record.requestBodyHash !== requestHash) {
      return conflictResponse(
        c,
        "idempotency_key_reused",
        "Idempotency-Key was already used for a different request",
      );
    }
    if (record.responseStatus === null || record.responseBody === null) {
      return conflictResponse(
        c,
        "idempotency_in_flight",
        "a request with this Idempotency-Key is already being processed",
      );
    }
    return new Response(record.responseBody, {
      status: record.responseStatus,
      headers: {
        "content-type": record.responseContentType ?? "application/json",
        "x-idempotent-replay": "true",
      },
    });
  }

  // We hold the reservation. Run the handler.
  let response: Response;
  try {
    response = await fn(body);
  } catch (err) {
    // On any throw, drop the reservation so the client may retry with the
    // same key (the side-effect did not complete, or completed ambiguously).
    await store.deleteReservation(key, userId).catch(() => {});
    throw err;
  }

  // 5xx is transient — drop the reservation so the same key retries cleanly.
  if (response.status >= 500) {
    await store.deleteReservation(key, userId).catch(() => {});
    return response;
  }

  // 2xx/4xx — deterministic. Capture and store for replay.
  const respBody = await response.clone().text();
  const respCt = response.headers.get("content-type") ?? "application/json";
  await store.storeResponse({
    key,
    userId,
    responseStatus: response.status,
    responseBody: respBody,
    responseContentType: respCt,
  });
  return response;
}

function conflictResponse(
  c: Context<{ Variables: AuthVars }>,
  code: string,
  message: string,
): Response {
  const requestId = c.get("requestId");
  return c.json(
    {
      error: {
        category: "POLICY_BLOCKED",
        code,
        message,
        retryable: false,
        request_id: requestId,
      },
    },
    409,
  );
}

function safeParseJson(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
