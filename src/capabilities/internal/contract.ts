// /capabilities/internal/contract.ts
// Capability contract model (architecture §6, WORK-005 §6, §7, §18).
//
// A capability contract describes WHAT an implementation must satisfy, without
// saying WHO implements it or HOW. It is the semantic, machine-readable target
// that future provider certification and optimization will consume (WORK-005
// §19: "Can this provider implementation satisfy this capability?" — answered
// here by deterministic contract validation, NOT by executing the provider).
//
// Machine-readable schemas (WORK-005 §7): contract input/output shapes are
// represented as JSON Schema documents (a stable, deterministic, widely
// understood schema language). They are stored as JSONB in PostgreSQL and
// validated structurally by `validateJsonSchemaShape` before a version may be
// published. This makes the contract layer suitable for deterministic
// compatibility checking by later layers WITHOUT requiring a third-party
// schema library (the frozen stack has none, and pulling one in would risk
// provider-independence and architect-review scope). The validator here is a
// focused, real structural check — it rejects malformed schemas and accepts
// well-formed ones deterministically.
//
// Immutability (WORK-005 §18): once a capability version reaches status
// 'active' (published), its contract fields are IMMUTABLE. An incompatible
// change requires a NEW version. The service enforces this; this module
// provides the contract type definitions and the validation that runs at
// publication time.

import { AppError } from "@cp/platform";

// ---- Side-effect classification (architecture §6) --------------------
// PURE: no observable state change.
// READ_ONLY: reads state but does not mutate it.
// IDEMPOTENT_WRITE: mutates state but is safe to retry with an idempotency key.
// NON_IDEMPOTENT_WRITE: mutates state and is NOT safe to retry blindly.
// TRANSACTIONAL: all-or-nothing; supports commit/rollback semantics.
// BEST_EFFORT: may partially succeed; not transactional, not necessarily
// idempotent (e.g. fire-and-forget notifications).
export type SideEffect =
  | "pure"
  | "read_only"
  | "idempotent_write"
  | "non_idempotent_write"
  | "transactional"
  | "best_effort";

export const SIDE_EFFECTS: readonly SideEffect[] = [
  "pure",
  "read_only",
  "idempotent_write",
  "non_idempotent_write",
  "transactional",
  "best_effort",
] as const;

export function isSideEffect(v: string): v is SideEffect {
  return (SIDE_EFFECTS as readonly string[]).includes(v);
}

// ---- Capability lifecycle (WORK-005 §11) -----------------------------
export type CapabilityStatus = "draft" | "active" | "deprecated" | "retired";

export const CAPABILITY_STATUSES: readonly CapabilityStatus[] = [
  "draft",
  "active",
  "deprecated",
  "retired",
] as const;

export function isCapabilityStatus(v: string): v is CapabilityStatus {
  return (CAPABILITY_STATUSES as readonly string[]).includes(v);
}

// Allowed lifecycle transitions (WORK-005 §11). DEPRECATED/RETIRED must NOT
// silently change the meaning of an existing published capability version —
// deprecation/retirement only flips the status flag, it never rewrites a
// contract (enforced by the service: contract fields are immutable once
// active).
export const LIFECYCLE_TRANSITIONS: ReadonlyMap<CapabilityStatus, readonly CapabilityStatus[]> =
  new Map<CapabilityStatus, readonly CapabilityStatus[]>([
    ["draft", ["active"]],
    ["active", ["deprecated", "retired"]],
    ["deprecated", ["active", "retired"]],
    // retired is terminal — no outgoing transitions.
    ["retired", []],
  ]);

// ---- Idempotency semantics (architecture §6, line 1324) --------------
// "Provider invocation idempotency is capability-specific and must be declared
// by the capability contract." Declared here as part of the contract.
export interface IdempotencySemantics {
  /** Whether an Idempotency-Key may be supplied for invocations of this capability. */
  supports_idempotency_key?: boolean;
  /** How the provider is expected to deduplicate: request_id | content_hash | none. */
  strategy?: "request_id" | "content_hash" | "none";
  /** Optional idempotency retention window in seconds. */
  ttl_seconds?: number;
}

// ---- Error model (architecture §6) ----------------------------------
// A list of well-known error codes a caller may receive when invoking this
// capability. Declared up-front so future layers can normalize provider errors
// against a stable contract vocabulary.
export interface CapabilityErrorEntry {
  code: string;
  message: string;
  retryable?: boolean;
}

// ---- A fully-resolved capability contract (a version) ----------------
export interface CapabilityContract {
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  errorModel: readonly CapabilityErrorEntry[];
  sideEffect: SideEffect;
  idempotencySemantics: IdempotencySemantics;
  requiredContext: readonly string[];
  executionModes: readonly string[];
  policyMetadata: Record<string, unknown>;
  constraints: readonly Record<string, unknown>[];
  latencyExpectations: Record<string, unknown>;
}

// ---- JSON Schema (structural) ---------------------------------------
// A minimal, real JSON-Schema shape. A schema is an object (or a boolean for
// the draft-07 "accept anything"/"reject anything" forms) with an optional
// `type` from a recognized set, and structural sub-fields validated
// recursively. This is NOT a full JSON Schema implementation — it validates
// that a document is structurally a well-formed JSON Schema suitable for
// storage and future compatibility checking (WORK-005 §7). Deep instance
// validation against a schema is the responsibility of later layers.

export type JsonSchema =
  | JsonSchemaObject
  | boolean;

export interface JsonSchemaObject {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | readonly JsonSchema[];
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  enum?: readonly unknown[];
  // The schema may declare additional unconstrained metadata keys; they are
  // preserved but not deeply interpreted by this structural validator.
  [key: string]: unknown;
}

const RECOGNIZED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/**
 * Validate that `schema` is a structurally well-formed JSON Schema document.
 * Returns the schema unchanged on success (so the caller may store it). Throws
 * a structured POLICY_BLOCKED on any malformation so the caller learns which
 * rule failed.
 *
 * This runs at version-publication time (WORK-005 §7, §22 CONTRACT tests):
 *   - valid schema accepted
 *   - malformed schema rejected (not an object, unknown type, non-schema
 *     properties/items, non-array required, etc.)
 */
export function validateJsonSchemaShape(
  schema: unknown,
  field: string,
): JsonSchema {
  const result = validateSchemaNode(schema, field, 0);
  return result;
}

const MAX_SCHEMA_DEPTH = 16;

function validateSchemaNode(
  node: unknown,
  path: string,
  depth: number,
): JsonSchema {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw contractMalformed(path, "schema exceeds maximum nesting depth");
  }
  // A boolean schema (true = accept anything; false = reject anything) is a
  // valid JSON-Schema form.
  if (typeof node === "boolean") return node;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw contractMalformed(
      path,
      "schema must be a JSON object (or a boolean) — received " +
        describeType(node),
    );
  }
  const obj = node as Record<string, unknown>;

  // `type` — if present, must be a recognized JSON-Schema type.
  if ("type" in obj) {
    const t = obj.type;
    if (typeof t === "string") {
      if (!RECOGNIZED_TYPES.has(t)) {
        throw contractMalformed(
          `${path}.type`,
          `unknown JSON-Schema type "${t}"`,
        );
      }
    } else if (Array.isArray(t)) {
      for (const el of t) {
        if (typeof el !== "string" || !RECOGNIZED_TYPES.has(el)) {
          throw contractMalformed(
            `${path}.type`,
            "type array may contain only recognized JSON-Schema type strings",
          );
        }
      }
    } else {
      throw contractMalformed(
        `${path}.type`,
        "type must be a string or an array of recognized type strings",
      );
    }
  }

  // `required` — if present, an array of strings.
  if ("required" in obj) {
    const req = obj.required;
    if (!Array.isArray(req)) {
      throw contractMalformed(`${path}.required`, "required must be an array");
    }
    for (const el of req) {
      if (typeof el !== "string" || el.length === 0) {
        throw contractMalformed(
          `${path}.required`,
          "required must be an array of non-empty strings",
        );
      }
    }
  }

  // `properties` — if present, a map of string → schema.
  if ("properties" in obj) {
    const props = obj.properties;
    if (props === null || typeof props !== "object" || Array.isArray(props)) {
      throw contractMalformed(
        `${path}.properties`,
        "properties must be an object",
      );
    }
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      validateSchemaNode(v, `${path}.properties["${k}"]`, depth + 1);
    }
  }

  // `items` — if present, a schema or an array of schemas (tuple validation).
  if ("items" in obj) {
    const items = obj.items;
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        validateSchemaNode(items[i], `${path}.items[${i}]`, depth + 1);
      }
    } else {
      validateSchemaNode(items, `${path}.items`, depth + 1);
    }
  }

  // `additionalProperties` — if present, a boolean or a schema.
  if ("additionalProperties" in obj) {
    const ap = obj.additionalProperties;
    if (typeof ap !== "boolean") {
      validateSchemaNode(ap, `${path}.additionalProperties`, depth + 1);
    }
  }

  // `enum` — if present, a non-empty array.
  if ("enum" in obj) {
    const en = obj.enum;
    if (!Array.isArray(en) || en.length === 0) {
      throw contractMalformed(
        `${path}.enum`,
        "enum must be a non-empty array",
      );
    }
  }

  // `description` — if present, a string.
  if ("description" in obj && typeof obj.description !== "string") {
    throw contractMalformed(`${path}.description`, "description must be a string");
  }

  return node as JsonSchema;
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function contractMalformed(path: string, message: string): AppError {
  return new AppError({
    category: "POLICY_BLOCKED",
    code: "capability.contract.malformed",
    message: `${path}: ${message}`,
    retryable: false,
    details: { path, message },
  });
}
