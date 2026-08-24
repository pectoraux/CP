// /capabilities — public interface.
//
// Responsibility (architecture §2.2, §6, §36, §37, lock §1, §7, §8,
// WORK-005 CAP-001..004):
//   - provider-neutral capability identities (canonical `namespace.action`)
//   - immutable versioned capability contracts (input/output JSON Schemas,
//     error model, side-effect classification, idempotency semantics, required
//     context, execution modes, policy metadata)
//   - the directed, version-aware capability dependency graph (cycle
//     detection, self-dep rejection, duplicate-edge rejection, retired-status
//     validation, deterministic traversal)
//   - capability + version lifecycle (draft → active → deprecated → retired)
//   - the CP-level platform-admin grant that gates global catalog mutations
//
// This module is part of the frozen module set (architecture §35). It exposes
// ONE public interface entry point; other modules may import ONLY from this
// file. Importing @cp/capabilities/internal/* from outside this module is a
// forbidden cross-module internal import (architecture-lock §8) and is
// rejected by the static architecture check.
//
// Provider independence (lock §7, WORK-005 §13): /capabilities MUST NOT import
// any provider SDK (Stripe/Adyen/Paystack/OpenAI/Anthropic/AWS/GCP), nor pg,
// ioredis, redis, aws4fetch, or any provider adapter. The service depends
// only on @cp/platform's provider-neutral Database interface and @cp/auth's
// Principal vocabulary. No provider terminology leaks into the contract.
//
// Dependency direction (WORK-005): /capabilities → @cp/platform (Database,
// ids, logging, error model) + @cp/auth (Principal). It does NOT import
// /providers, /routing, /optimization, /experiments, or any provider adapter
// (those belong to later work items and would violate provider-neutrality).

// ---- CapabilitiesService (DB-backed) ---------------------------------
export { CapabilitiesService } from "./internal/service.ts";
export type {
  CapabilitiesServiceOptions,
  Capability,
  CapabilityVersion,
  CapabilityDependency,
  DependencyGraph,
  CreateCapabilityInput,
  ListCapabilitiesOptions,
  CapabilityPage,
  TransitionCapabilityInput,
  CreateVersionInput,
  TransitionVersionInput,
  AddDependencyInput,
  ListVersionsOptions,
} from "./internal/service.ts";

// ---- Contract model (architecture §6) --------------------------------
export type {
  CapabilityContract,
  SideEffect,
  CapabilityStatus,
  IdempotencySemantics,
  CapabilityErrorEntry,
  JsonSchema,
  JsonSchemaObject,
} from "./internal/contract.ts";
export {
  SIDE_EFFECTS,
  CAPABILITY_STATUSES,
  LIFECYCLE_TRANSITIONS,
  isSideEffect,
  isCapabilityStatus,
  validateJsonSchemaShape,
} from "./internal/contract.ts";

// ---- Canonical identifier validation (WORK-005 §5) -------------------
export {
  isValidCapabilityId,
  validateCapabilityId,
  isValidVersion,
  validateVersion,
  CAPABILITY_ID_MAX_LEN,
} from "./internal/identifiers.ts";

// ---- Dependency graph primitives (WORK-005 §9, §17) -------------------
export {
  detectCycle,
  reachableFrom,
  topologicalOrder,
  nodeKey,
} from "./internal/graph.ts";
export type { GraphNode, GraphEdge, CycleResult } from "./internal/graph.ts";

// ---- Schema migration ------------------------------------------------
export { CAP_SCHEMA_STATEMENTS } from "./internal/schema.ts";
export { migrateCapabilitiesSchema } from "./internal/schema-runner.ts";

// Backwards-compatible symbol from the WORK-001 placeholder (kept stable;
// no in-tree consumer relies on it, but the export is retained so removing
// it cannot break an external reference).
export const MODULE_NAME = "capabilities" as const;
