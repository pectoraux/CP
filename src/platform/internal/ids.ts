// /platform/internal/ids.ts
// Stable, sortable, collision-resistant identifiers for the control plane.
// Implements ULID (Crockford base32, 48-bit ms timestamp + 80-bit random).
// Used for request_id / execution_id / job_id / operation_id / correlation_id.

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (excludes I, L, O, U)
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10;
const RANDOM_LEN = 16;
// const TOTAL_LEN = TIME_LEN + RANDOM_LEN; // 26

function encodeTime(now: number): string {
  // 48-bit timestamp → 10 base32 chars
  let ts = Math.floor(now);
  if (ts < 0 || !Number.isSafeInteger(ts) || ts > 0xffffffffffff) {
    throw new Error(`ulid: timestamp out of range: ${now}`);
  }
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = ts % ENCODING_LEN;
    out = ENCODING[mod]! + out;
    ts = Math.floor(ts / ENCODING_LEN);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[bytes[i]! % ENCODING_LEN];
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export function newRequestId(): string {
  return "req_" + ulid();
}

export function newExecutionId(): string {
  return "exec_" + ulid();
}

export function newJobId(): string {
  return "job_" + ulid();
}

export function newOperationId(): string {
  return "op_" + ulid();
}

// correlation id defaults to the request id when not explicitly provided.
export function newCorrelationId(): string {
  return "corr_" + ulid();
}

const ULID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: string): boolean {
  return ULID_REGEX.test(value);
}
