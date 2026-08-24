// /providers/internal/contract-tests.ts
// The adapter contract-test harness (WORK-006 §13, §14; frozen spec §8.1,
// §32). Executes the deterministic contract suite for every capability
// declaration of a provider and returns per-test outcomes that the service
// persists as certification EVIDENCE rows.
//
// The suite proves, per declared (capability, version):
//   capability.declared       — the adapter declares the exact capability
//                                AND version (compatibility is
//                                contract/version based, never name-based)
//   capability.version_exists — the capability version exists in the
//                                catalog and is not retired
//   input.accepted             — the adapter accepts its own declared
//                                sample input
//   output.conforms            — the adapter output conforms to the
//                                capability output schema (top-level +
//                                required properties)
//   error.normalized           — a malformed input produces a NORMALIZED
//                                AppError (never a raw SDK error leaking
//                                across the adapter boundary)
//   unsupported.rejected       — invoking an UNDECLARED version rejects
//                                with provider.capability.unsupported
//   credentials.declared       — the adapter declares well-formed
//                                credential requirements (metadata only)
//
// Certification boundaries (WORK-006 §14):
//   - environment comes from the ADAPTER descriptor (fixture | live).
//     A fixture adapter can produce contract verification, never live
//     certification. The harness never upgrades the environment.
//   - "contract verified" and "live provider certified" are distinct:
//     ALL tests passing advances a declaration to contract_verified;
//     certified additionally requires environment === "live".
//
// This harness is deterministic: no network, no clocks in pass/fail
// decisions, no randomness.

import type { AppError, Logger } from "@cp/platform";
import { AppError as AppErrorClass } from "@cp/platform";
import type { JsonSchemaObject } from "@cp/capabilities";
import type { CapabilityVersion } from "@cp/capabilities";
import type { ProviderAdapter } from "./adapter.ts";
import type { CredentialResolver } from "@cp/credentials";
import { validateCredentialRequirements } from "@cp/credentials";
import { isNormalizedProviderFailure } from "./errors.ts";

/** The contract suite's test names (stable — persisted in evidence rows). */
export const CONTRACT_TEST_NAMES = [
  "capability.declared",
  "capability.version_exists",
  "input.accepted",
  "output.conforms",
  "error.normalized",
  "unsupported.rejected",
  "credentials.declared",
] as const;

export type ContractTestName = (typeof CONTRACT_TEST_NAMES)[number];

/** Tests that must pass for registered → contract_verified. */
export const CONTRACT_VERIFIED_GATE: readonly ContractTestName[] = [
  "capability.declared",
  "capability.version_exists",
  "credentials.declared",
];

export interface ContractTestOutcome {
  testName: ContractTestName;
  result: "pass" | "fail";
  detail: Record<string, unknown>;
}

/** Input the harness needs per declaration. */
export interface ContractTestDeclarationInput {
  capabilityId: string;        // canonical, e.g. 'demo.echo'
  capabilityVersion: string;
  persistedCredentialRequirements: unknown; // as stored on the declaration
}

export interface ContractTestRunInput {
  adapter: ProviderAdapter;
  declarations: ContractTestDeclarationInput[];
  /** Loads a capability version from the authoritative catalog. */
  getCapabilityVersion: (
    canonicalId: string,
    version: string,
  ) => Promise<CapabilityVersion | null>;
  credentials: CredentialResolver;
  logger?: Logger;
}

export interface ContractTestDeclarationResult {
  declaration: ContractTestDeclarationInput;
  outcomes: ContractTestOutcome[];
  /** All tests passed. */
  allPassed: boolean;
  /** The prerequisite (gate) tests passed — invocation tests become
   * meaningful. Full-suite pass is what advances contract_verified. */
  gatePassed: boolean;
}

export interface ContractTestRunResult {
  environment: "fixture" | "live";
  adapterVersion: string;
  declarationResults: ContractTestDeclarationResult[];
}

/**
 * Run the deterministic contract suite for every declaration. Never throws
 * for test failures — failures are outcomes (evidence), not errors.
 */
export async function runAdapterContractTests(
  input: ContractTestRunInput,
): Promise<ContractTestRunResult> {
  const descriptor = input.adapter.descriptor();
  const results: ContractTestDeclarationResult[] = [];

  for (const declaration of input.declarations) {
    const outcomes: ContractTestOutcome[] = [];
    const adapterDecl = descriptor.capabilities.find(
      (c) => c.capabilityId === declaration.capabilityId,
    );

    // ---- capability.declared ------------------------------------------
    {
      const declared =
        adapterDecl !== undefined &&
        adapterDecl.capabilityVersions.includes(declaration.capabilityVersion);
      outcomes.push({
        testName: "capability.declared",
        result: declared ? "pass" : "fail",
        detail: {
          capability_id: declaration.capabilityId,
          capability_version: declaration.capabilityVersion,
          adapter_declared_versions: adapterDecl?.capabilityVersions ?? [],
        },
      });
    }

    // ---- capability.version_exists ------------------------------------
    let catalogVersion: CapabilityVersion | null = null;
    {
      let exists = false;
      let reason = "";
      try {
        catalogVersion = await input.getCapabilityVersion(
          declaration.capabilityId,
          declaration.capabilityVersion,
        );
        if (catalogVersion === null) {
          reason = "capability version not found in the catalog";
        } else if (catalogVersion.status === "retired") {
          reason = "capability version is retired";
        } else {
          exists = true;
        }
      } catch (err) {
        reason = `catalog lookup failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      outcomes.push({
        testName: "capability.version_exists",
        result: exists ? "pass" : "fail",
        detail: {
          capability_id: declaration.capabilityId,
          capability_version: declaration.capabilityVersion,
          catalog_status: catalogVersion?.status ?? null,
          ...(reason ? { reason } : {}),
        },
      });
    }

    // ---- credentials.declared ------------------------------------------
    {
      const problems = validateCredentialRequirements(
        descriptor.credentialRequirements,
      );
      const persistedProblems = validateCredentialRequirements(
        declaration.persistedCredentialRequirements,
      );
      const persistedMatches =
        JSON.stringify(sortKey(descriptor.credentialRequirements)) ===
        JSON.stringify(sortKey(declaration.persistedCredentialRequirements));
      const pass =
        problems.length === 0 &&
        persistedProblems.length === 0 &&
        persistedMatches;
      outcomes.push({
        testName: "credentials.declared",
        result: pass ? "pass" : "fail",
        detail: {
          requirement_count: descriptor.credentialRequirements.length,
          descriptor_problems: problems,
          persisted_problems: persistedProblems,
          persisted_matches_descriptor: persistedMatches,
        },
      });
    }

    const gatePassed = CONTRACT_VERIFIED_GATE.every((name) =>
      outcomes.find((o) => o.testName === name)?.result === "pass",
    );

    // The remaining tests exercise invocation. They require a valid
    // catalog version (for output-schema comparison) and an adapter
    // declaration (for the sample input). When the gate already failed,
    // record the invocation tests as failed with a precise reason rather
    // than attempting nonsense invocations.
    const sampleInput = adapterDecl?.sampleInput;
    const canInvoke =
      gatePassed && catalogVersion !== null && sampleInput !== undefined;

    // ---- input.accepted ------------------------------------------------
    let invokeSucceeded = false;
    let invokedOutput: unknown = undefined;
    {
      if (!canInvoke) {
        outcomes.push({
          testName: "input.accepted",
          result: "fail",
          detail: { reason: "prerequisites failed (gate/catalog/sample input)" },
        });
      } else {
        try {
          const res = await input.adapter.invoke(
            {
              capabilityId: declaration.capabilityId,
              capabilityVersion: declaration.capabilityVersion,
              input: sampleInput,
            },
            input.credentials,
          );
          invokeSucceeded = true;
          invokedOutput = res.output;
          outcomes.push({
            testName: "input.accepted",
            result: "pass",
            detail: { sample_input_kind: kindOf(sampleInput) },
          });
        } catch (err) {
          outcomes.push({
            testName: "input.accepted",
            result: "fail",
            detail: {
              reason: `adapter rejected its own sample input: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        }
      }
    }

    // ---- output.conforms -----------------------------------------------
    {
      if (!invokeSucceeded || catalogVersion === null) {
        outcomes.push({
          testName: "output.conforms",
          result: "fail",
          detail: { reason: "no successful invocation to validate" },
        });
      } else {
        const outputSchema = catalogVersion.contract.outputSchema;
        const problems = validateTopLevelAgainstSchema(
          invokedOutput,
          outputSchema,
        );
        outcomes.push({
          testName: "output.conforms",
          result: problems.length === 0 ? "pass" : "fail",
          detail:
            problems.length === 0
              ? { output_kind: kindOf(invokedOutput) }
              : { problems },
        });
      }
    }

    // ---- error.normalized ----------------------------------------------
    {
      if (!canInvoke) {
        outcomes.push({
          testName: "error.normalized",
          result: "fail",
          detail: { reason: "prerequisites failed (gate/catalog/sample input)" },
        });
      } else {
        try {
          // Deliberately malformed input: structurally empty. A provider
          // implementation must reject it with a NORMALIZED error (an
          // AppError) — a raw SDK error leaking here fails the test.
          await input.adapter.invoke(
            {
              capabilityId: declaration.capabilityId,
              capabilityVersion: declaration.capabilityVersion,
              input: {},
            },
            input.credentials,
          );
          // Accepting structurally-empty input means the adapter is not
          // normalizing the provider's validation surface.
          outcomes.push({
            testName: "error.normalized",
            result: "fail",
            detail: {
              reason:
                "adapter accepted a structurally-empty input; expected a normalized rejection",
            },
          });
        } catch (err) {
          const normalized = err instanceof AppErrorClass;
          const providerSide =
            isNormalizedProviderFailure(err) ||
            (err instanceof AppErrorClass && err.category === "POLICY_BLOCKED");
          const pass = normalized && providerSide;
          outcomes.push({
            testName: "error.normalized",
            result: pass ? "pass" : "fail",
            detail: pass
              ? {
                  normalized_category: (err as AppError).category,
                  normalized_code: (err as AppError).code,
                }
              : {
                  reason:
                    "adapter leaked a non-normalized error (raw SDK/unknown exception) for malformed input",
                  error_kind: err instanceof Error ? err.constructor.name : typeof err,
                },
          });
        }
      }
    }

    // ---- unsupported.rejected ------------------------------------------
    {
      if (adapterDecl === undefined) {
        outcomes.push({
          testName: "unsupported.rejected",
          result: "fail",
          detail: { reason: "adapter does not declare the capability at all" },
        });
      } else {
        const undeclaredVersion = findUndeclaredVersion(
          adapterDecl.capabilityVersions,
        );
        try {
          await input.adapter.invoke(
            {
              capabilityId: declaration.capabilityId,
              capabilityVersion: undeclaredVersion,
              input: sampleInput ?? {},
            },
            input.credentials,
          );
          outcomes.push({
            testName: "unsupported.rejected",
            result: "fail",
            detail: {
              reason: `adapter invoked undeclared version "${undeclaredVersion}"`,
            },
          });
        } catch (err) {
          const pass =
            err instanceof AppErrorClass &&
            err.code === "provider.capability.unsupported";
          outcomes.push({
            testName: "unsupported.rejected",
            result: pass ? "pass" : "fail",
            detail: pass
              ? { rejected_version: undeclaredVersion }
              : {
                  reason:
                    "undeclared version was not rejected with provider.capability.unsupported",
                  error_code: err instanceof AppErrorClass ? err.code : null,
                },
          });
        }
      }
    }

    const allPassed = outcomes.every((o) => o.result === "pass");
    results.push({ declaration, outcomes, allPassed, gatePassed });
  }

  return {
    environment: descriptor.environment,
    adapterVersion: descriptor.adapterVersion,
    declarationResults: results,
  };
}

// ---- helpers -------------------------------------------------------------

/** Deterministically pick a version string the adapter does NOT declare. */
function findUndeclaredVersion(declared: readonly string[]): string {
  let n = 999_999;
  while (declared.includes(String(n))) n -= 1;
  return String(n);
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Order-insensitive canonical JSON for requirement comparison. */
function sortKey(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKey);
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return entries.map(([k, val]) => [k, sortKey(val)]);
  }
  return v;
}

/**
 * Minimal, honest top-level instance validation against a JSON-Schema-ish
 * contract schema: verifies the root type and, for object roots, that all
 * `required` properties are present with primitive-type conformance.
 * Deep/nested validation, pattern/format keywords, and combinators
 * (allOf/anyOf/oneOf) are intentionally NOT implemented — full instance
 * validation belongs to the execution layer (WORK-014) with a real
 * validator. This is documented as a known limitation.
 */
export function validateTopLevelAgainstSchema(
  value: unknown,
  schema: unknown,
): string[] {
  if (schema === true || schema === undefined || schema === null) return [];
  if (schema === false) return ["schema forbids any value"];
  const s = schema as JsonSchemaObject;
  const problems: string[] = [];
  const type = s.type;
  if (type !== undefined) {
    const kind = kindOf(value);
    const matches =
      (type === "object" && kind === "object") ||
      (type === "array" && kind === "array") ||
      (type === "string" && kind === "string") ||
      (type === "number" && (kind === "number")) ||
      (type === "integer" && kind === "number" && Number.isInteger(value)) ||
      (type === "boolean" && kind === "boolean") ||
      (type === "null" && kind === "null");
    if (!matches) {
      problems.push(`root type must be ${type}, got ${kind}`);
      return problems;
    }
  }
  if (type === "object" || (type === undefined && kindOf(value) === "object")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push("value is not an object");
      return problems;
    }
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj)) {
        problems.push(`required property "${key}" is missing`);
        continue;
      }
      const propSchema = s.properties?.[key];
      if (propSchema && propSchema !== true && typeof propSchema === "object") {
        const propType = (propSchema as JsonSchemaObject).type;
        if (propType !== undefined) {
          const kind = kindOf(obj[key]);
          const ok =
            (propType === "object" && kind === "object") ||
            (propType === "array" && kind === "array") ||
            (propType === "string" && kind === "string") ||
            (propType === "number" && kind === "number") ||
            (propType === "integer" && kind === "number" && Number.isInteger(obj[key])) ||
            (propType === "boolean" && kind === "boolean") ||
            (propType === "null" && kind === "null");
          if (!ok) {
            problems.push(`property "${key}" must be ${propType}, got ${kind}`);
          }
        }
      }
    }
  }
  return problems;
}
