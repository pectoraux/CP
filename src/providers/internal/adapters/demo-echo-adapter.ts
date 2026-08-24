// /providers/internal/adapters/demo-echo-adapter.ts
// The first-party REFERENCE adapter (WORK-006 §8, §23).
//
// This adapter demonstrates the complete first-party integration path:
//
//   provider docs/API → CP adapter → normalized provider contract
//        → contract tests → certification evidence → availability
//
// against a DETERMINISTIC FIXTURE (environment: "fixture"). No external
// provider credentials are legitimately available in this environment,
// and the frozen WORK-006 explicitly scopes out individual production
// provider integrations — so this adapter:
//   - is a real ProviderAdapter implementation with a real normalized
//     contract, real credential requirements, real error normalization
//   - implements the deterministic `demo.echo` provider, which echoes a
//     validated input back through the capability's output contract
//   - simulates provider-side failures on demand so contract tests can
//     PROVE error normalization (WORK-006 §15)
//   - is explicitly labeled environment: "fixture" — evidence produced
//     through it is fixture/contract-test evidence, NEVER live
//     certification evidence (WORK-006 §14)
//
// This file is provider-adapter internals: per lock §7 it is the ONLY
// place provider-specific code may live (this adapter has no external SDK
// dependency — it is self-contained by design so the reference path is
// fully deterministic).
//
// Fixture protocol (deterministic, documented here as the "provider API"):
//   input { message: string, fail_with?: "provider_failure" |
//           "rate_limited" | "timeout" | "network_failure" } →
//   output { echoed: string, echo_id: string, echoed_at: string }
// The fail_with field is the fixture's simulated provider-error surface.

import {
  providerError,
  normalizeProviderError,
} from "../errors.ts";
import {
  validateProviderId,
  validateAdapterVersion,
} from "../identifiers.ts";
import type {
  AdapterCapabilityDeclaration,
  AdapterConfigurationCheck,
  AdapterInvocationRequest,
  AdapterInvocationResult,
  ProviderAdapter,
  ProviderAdapterDescriptor,
} from "../adapter.ts";
import type {
  CredentialRequirement,
  CredentialResolver,
} from "@cp/credentials";
import { AppError, ulid } from "@cp/platform";

export const DEMO_ECHO_PROVIDER_ID = "demo.echo";
export const DEMO_ECHO_ADAPTER_VERSION = "1.0.0";

/** The fixture's documented error surface (see file header). */
export type DemoEchoFailureMode =
  | "provider_failure"
  | "rate_limited"
  | "timeout"
  | "network_failure";

const FAILURE_MODES: readonly DemoEchoFailureMode[] = [
  "provider_failure",
  "rate_limited",
  "timeout",
  "network_failure",
];

export interface DemoEchoInput {
  message: string;
  fail_with?: DemoEchoFailureMode;
}

export interface DemoEchoOutput {
  echoed: string;
  echo_id: string;
  echoed_at: string;
}

/**
 * Build the deterministic demo.echo adapter. `opts.failProbability`
 * defaults to 0 (fully deterministic). The adapter requires an `api_key`
 * credential (resolved at invocation time through the secret-access
 * boundary — never stored here).
 */
export function createDemoEchoAdapter(
  opts: { failProbability?: number } = {},
): ProviderAdapter {
  const failProbability = opts.failProbability ?? 0;
  if (failProbability < 0 || failProbability > 1) {
    throw new Error("demo.echo adapter: failProbability must be within [0, 1]");
  }

  const credentialRequirements: CredentialRequirement[] = [
    {
      name: "api_key",
      kind: "api_key",
      description:
        "Demo provider API key (fixture — resolved through the secret-access boundary, never stored in provider rows)",
      optional: false,
    },
  ];

  const capabilities: AdapterCapabilityDeclaration[] = [
    {
      capabilityId: "demo.echo",
      capabilityVersions: ["1"],
      sampleInput: { message: "hello, control plane" },
      notes:
        "Echoes the validated message back with a fixture echo id; simulates provider failures via input.fail_with",
    },
  ];

  const descriptor: ProviderAdapterDescriptor = {
    providerId: validateProviderId(DEMO_ECHO_PROVIDER_ID),
    name: "Echo Demo Provider",
    description:
      "Deterministic reference provider proving the WORK-006 adapter framework (first-party integration path). Fixture environment — contract-tested, never live-certified.",
    integrationPath: "platform_operated",
    environment: "fixture",
    adapterVersion: validateAdapterVersion(DEMO_ECHO_ADAPTER_VERSION),
    documentationUrl: "https://example.com/docs/demo-echo",
    credentialRequirements,
    capabilities,
  };

  return {
    descriptor(): ProviderAdapterDescriptor {
      return descriptor;
    },

    async verifyConfiguration(): Promise<AdapterConfigurationCheck> {
      // Configuration self-check WITHOUT secrets and WITHOUT live calls:
      // every declaration must carry at least one version and a sample
      // input, and an authenticated provider must declare credentials.
      const problems: string[] = [];
      for (const cap of descriptor.capabilities) {
        if (cap.capabilityVersions.length === 0) {
          problems.push(`capability ${cap.capabilityId} declares no versions`);
        }
        if (cap.sampleInput === undefined) {
          problems.push(`capability ${cap.capabilityId} has no sample input`);
        }
      }
      if (descriptor.credentialRequirements.length === 0) {
        problems.push("adapter declares no credential requirements");
      }
      return { ok: problems.length === 0, problems };
    },

    async invoke(
      request: AdapterInvocationRequest,
      credentials: CredentialResolver,
    ): Promise<AdapterInvocationResult> {
      // (1) Declared-capability gate: exact capability+version match only.
      //     Compatibility is contract/version based, never name-based.
      const declaration = descriptor.capabilities.find(
        (c) => c.capabilityId === request.capabilityId,
      );
      if (!declaration) {
        throw new AppError({
          category: "POLICY_BLOCKED",
          code: "provider.capability.unsupported",
          message: `provider "${descriptor.providerId}" does not implement capability "${request.capabilityId}"`,
          retryable: false,
          details: {
            reason: "capability_not_declared",
            provider_id: descriptor.providerId,
            capability_id: request.capabilityId,
          },
        });
      }
      if (!declaration.capabilityVersions.includes(request.capabilityVersion)) {
        throw new AppError({
          category: "POLICY_BLOCKED",
          code: "provider.capability.unsupported",
          message: `provider "${descriptor.providerId}" implements ${request.capabilityId} at version(s) ${declaration.capabilityVersions.join(", ")} — not "${request.capabilityVersion}"`,
          retryable: false,
          details: {
            reason: "capability_version_not_declared",
            provider_id: descriptor.providerId,
            capability_id: request.capabilityId,
            requested_version: request.capabilityVersion,
            supported_versions: declaration.capabilityVersions,
          },
        });
      }

      // (2) Input shape check (fixture-level; full JSON-Schema validation
      //     happens upstream in the capability layer).
      const input = request.input as Partial<DemoEchoInput> | null;
      if (
        input === null ||
        typeof input !== "object" ||
        typeof input.message !== "string" ||
        input.message.length === 0
      ) {
        throw providerError("provider_failure", "error.invalid_input", "input.message (non-empty string) is required", {
          retryable: false,
          detail: { provider_id: descriptor.providerId },
        });
      }
      if (
        input.fail_with !== undefined &&
        !FAILURE_MODES.includes(input.fail_with as DemoEchoFailureMode)
      ) {
        throw providerError("provider_failure", "error.invalid_failure_mode", `input.fail_with must be one of ${FAILURE_MODES.join("|")}`, {
          retryable: false,
        });
      }

      // (3) Credential access through the secret boundary. The resolved
      //     value is used (shape-checked) but NEVER stored, logged, or
      //     returned. CREDENTIAL_FAILURE stays distinct from
      //     PROVIDER_FAILURE (architecture §31).
      try {
        const resolved = await credentials.resolve("api_key");
        if (typeof resolved.value !== "string" || resolved.value.length === 0) {
          throw new Error("empty credential value");
        }
      } catch (err) {
        throw normalizeProviderError(err, {
          providerId: descriptor.providerId,
          operation: "credential_resolution",
        });
      }

      // (4) Simulated provider-side failures — the contract tests use
      //     these to PROVE error normalization.
      const failMode =
        input.fail_with ??
        (failProbability > 0 && Math.random() < failProbability
          ? "provider_failure"
          : undefined);
      if (failMode === "provider_failure") {
        throw providerError("provider_failure", "error.fixture_failure", "demo provider rejected the request (fixture)", {
          retryable: false,
          detail: { provider_id: descriptor.providerId, http_status: 400 },
        });
      }
      if (failMode === "rate_limited") {
        throw providerError("rate_limited", "error.fixture_rate_limited", "demo provider rate limited the request (fixture)", {
          retryable: true,
          detail: { provider_id: descriptor.providerId, http_status: 429 },
        });
      }
      if (failMode === "timeout") {
        throw providerError("timeout", "error.fixture_timeout", "demo provider timed out (fixture)", {
          retryable: true,
          detail: { provider_id: descriptor.providerId },
        });
      }
      if (failMode === "network_failure") {
        throw providerError("network_failure", "error.fixture_network", "demo provider was unreachable (fixture)", {
          retryable: true,
          detail: { provider_id: descriptor.providerId },
        });
      }

      // (5) Normalized output conforming to the capability output contract.
      const output: DemoEchoOutput = {
        echoed: input.message,
        echo_id: `echo_${ulid()}`,
        echoed_at: new Date().toISOString(),
      };
      return {
        output,
        providerRequestId: `req_${ulid()}`,
        metadata: {
          provider_id: descriptor.providerId,
          adapter_version: descriptor.adapterVersion,
          environment: descriptor.environment,
        },
      };
    },
  };
}
