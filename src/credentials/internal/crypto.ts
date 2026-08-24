// /credentials/internal/crypto.ts
// Secret-material encryption for the /credentials boundary (WORK-010,
// architecture §2.17, §30; lock §10; WORK-010 §27).
//
// Conservative, established cryptography ONLY — no invented algorithms:
//   - Per-record data key: HKDF-SHA256(masterKey, salt = credential id,
//     info = "cp-credential-v1") → 32 bytes
//   - Cipher: AES-256-GCM with a fresh random 12-byte IV per encryption
//   - Blob layout: base64( "C1" || iv(12) || tag(16) || ciphertext )
//
// The master key comes from DEPLOYMENT configuration
// (CP_CREDENTIAL_MASTER_KEY, 32-byte hex) or an explicit service option
// (tests). It is NEVER persisted, never logged, never derived from
// organization ids/passwords, and never stored beside ciphertext. With no
// master key configured, secret operations fail LOUDLY (PLATFORM_FAILURE)
// — there is no plaintext fallback "because the environment is local"
// (WORK-010 §7).

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { AppError } from "@cp/platform";

const BLOB_VERSION = "C1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Parse a master key from hex (64 hex chars = 32 bytes). */
export function parseMasterKey(hex: string | undefined | null): Buffer | null {
  if (hex === undefined || hex === null || hex === "") return null;
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new AppError({
      category: "PLATFORM_FAILURE",
      code: "credential.master_key.invalid",
      message: "CP_CREDENTIAL_MASTER_KEY must be 32 bytes of hex (64 hex characters)",
      retryable: false,
    });
  }
  return Buffer.from(trimmed, "hex");
}

function requireMasterKey(masterKey: Buffer | null): Buffer {
  if (masterKey === null || masterKey.length !== KEY_BYTES) {
    throw new AppError({
      category: "PLATFORM_FAILURE",
      code: "credential.encryption.unconfigured",
      message:
        "credential encryption is not configured — set CP_CREDENTIAL_MASTER_KEY (32-byte hex) to store or resolve secrets; plaintext storage is never permitted",
      retryable: false,
    });
  }
  return masterKey;
}

/** Derive the per-record key: HKDF-SHA256(master, salt=credentialId). */
function recordKey(masterKey: Buffer, credentialId: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.from(credentialId, "utf8"), "cp-credential-v1", KEY_BYTES),
  );
}

/** Encrypt a secret for a credential record. Returns the opaque blob. */
export function encryptSecret(masterKeyInput: Buffer | null, credentialId: string, secret: string): string {
  const masterKey = requireMasterKey(masterKeyInput);
  const key = recordKey(masterKey, credentialId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(BLOB_VERSION, "utf8"), iv, tag, ciphertext]).toString("base64");
}

/**
 * Decrypt a secret blob for a credential record. Throws
 * credential.decryption.failed on any tampering/mismatch (wrong key,
 * corrupted blob, wrong credential id) — normalized, never leaking key
 * material in the error.
 */
export function decryptSecret(masterKeyInput: Buffer | null, credentialId: string, blob: string): string {
  const masterKey = requireMasterKey(masterKeyInput);
  const raw = Buffer.from(blob, "base64");
  const headerLen = BLOB_VERSION.length;
  if (raw.length < headerLen + IV_BYTES + 16 + 1) {
    throw decryptionFailed();
  }
  const version = raw.subarray(0, headerLen).toString("utf8");
  if (version !== BLOB_VERSION) {
    throw decryptionFailed();
  }
  const iv = raw.subarray(headerLen, headerLen + IV_BYTES);
  const tag = raw.subarray(headerLen + IV_BYTES, headerLen + IV_BYTES + 16);
  const ciphertext = raw.subarray(headerLen + IV_BYTES + 16);
  const key = recordKey(masterKey, credentialId);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw decryptionFailed();
  }
}

function decryptionFailed(): AppError {
  return new AppError({
    category: "PLATFORM_FAILURE",
    code: "credential.decryption.failed",
    message: "credential secret could not be decrypted (wrong key, corrupted record, or revoked/rotated version)",
    retryable: false,
  });
}
