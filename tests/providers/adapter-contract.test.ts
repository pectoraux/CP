// tests/providers/adapter-contract.test.ts — WORK-006 adapter contract
// behavior for the first-party demo.echo fixture adapter (unit-level, no
// infrastructure). Proves (WORK-006 §24 contract tests):
//   - descriptor shape: provider id, integration path, environment=fixture,
//     adapter version, declared capabilities with EXACT versions, sample
//     inputs, credential REQUIREMENTS (metadata only)
//   - verifyConfiguration() self-check without secrets/live calls
//   - invoke(): accepted input → normalized output
//   - error normalization: each simulated provider failure mode maps to
//     the correct CP failure category (PROVIDER_FAILURE / RATE_LIMITED /
//     TIMEOUT / NETWORK_FAILURE), never raw SDK errors
//   - credential access through the secret boundary (CREDENTIAL_FAILURE
//     when the requirement is not connected — distinct from
//     PROVIDER_FAILURE, architecture §31)
//   - unsupported capability/version rejected (contract/version-based
//     compatibility, never name-based — WORK-006 §12)
//   - provider-specific details remain inside the adapter (output
//     normalized; no SDK-shaped leaks)
//   - AdapterRegistry registration/lookup semantics
//   - validateTopLevelAgainstSchema (the honest top-level output validator)
import { describe, expect, it } from "bun:test";
import { AppError } from "@cp/platform";
import { StaticCredentialResolver } from "@cp/credentials";
import {
  createDemoEchoAdapter,
  DEMO_ECHO_PROVIDER_ID,
  DEMO_ECHO_ADAPTER_VERSION,
  AdapterRegistry,
  normalizeProviderError,
  isNormalizedProviderFailure,
  providerError,
  isProviderErrorKind,
  validateTopLevelAgainstSchema,
  isValidProviderId,
  validateProviderId,
  isValidAdapterVersion,
  validateAdapterVersion,
} from "@cp/providers";

function adapter() {
  return createDemoEchoAdapter();
}

function creds() {
  return new StaticCredentialResolver({ api_key: "test-secret-value" });
}

describe("WORK-006 demo.echo adapter contract (deterministic fixture)", () => {
  it("descriptor: fixture environment, platform-operated, exact version declarations, credential REQUIREMENTS only", () => {
    const d = adapter().descriptor();
    expect(d.providerId).toBe(DEMO_ECHO_PROVIDER_ID);
    expect(d.providerId).toBe("demo.echo");
    expect(d.environment).toBe("fixture"); // never live-certified
    expect(d.integrationPath).toBe("platform_operated");
    expect(d.adapterVersion).toBe(DEMO_ECHO_ADAPTER_VERSION);
    expect(d.capabilities.length).toBe(1);
    expect(d.capabilities[0]!.capabilityId).toBe("demo.echo");
    expect(d.capabilities[0]!.capabilityVersions).toEqual(["1"]);
    // Credential REQUIREMENTS are metadata: a kind + a name. No values.
    expect(d.credentialRequirements.length).toBe(1);
    const req = d.credentialRequirements[0]!;
    expect(req.name).toBe("api_key");
    expect(req.kind).toBe("api_key");
    expect("value" in req).toBe(false);
  });

  it("verifyConfiguration(): ok without secrets and without live calls", async () => {
    const check = await adapter().verifyConfiguration();
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
  });

  it("invoke(): accepted sample input → normalized output", async () => {
    const res = await adapter().invoke(
      { capabilityId: "demo.echo", capabilityVersion: "1", input: { message: "hello cp" } },
      creds(),
    );
    const out = res.output as { echoed: string; echo_id: string; echoed_at: string };
    expect(out.echoed).toBe("hello cp");
    expect(out.echo_id).toMatch(/^echo_/);
    expect(typeof out.echoed_at).toBe("string");
    // Provider request id is non-secret trace metadata.
    expect(res.providerRequestId).toMatch(/^req_/);
  });

  it("error normalization: provider_failure → PROVIDER_FAILURE", async () => {
    let err: unknown;
    try {
      await adapter().invoke(
        { capabilityId: "demo.echo", capabilityVersion: "1", input: { message: "x", fail_with: "provider_failure" } },
        creds(),
      );
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AppError);
    const ae = err as AppError;
    expect(ae.category).toBe("PROVIDER_FAILURE");
    expect(ae.code).toBe("provider.error.fixture_failure");
    expect(ae.retryable).toBe(false);
  });

  it("error normalization: rate_limited → RATE_LIMITED (retryable)", async () => {
    let err: unknown;
    try {
      await adapter().invoke(
        { capabilityId: "demo.echo", capabilityVersion: "1", input: { message: "x", fail_with: "rate_limited" } },
        creds(),
      );
    } catch (e) { err = e; }
    expect((err as AppError).category).toBe("RATE_LIMITED");
    expect((err as AppError).retryable).toBe(true);
  });

  it("error normalization: timeout → TIMEOUT", async () => {
    let err: unknown;
    try {
      await adapter().invoke(
        { capabilityId: "demo.echo", capabilityVersion: "1", input: { message: "x", fail_with: "timeout" } },
        creds(),
      );
    } catch (e) { err = e; }
    expect((err as AppError).category).toBe("TIMEOUT");
  });

  it("error normalization: network_failure → NETWORK_FAILURE", async () => {
    let err: unknown;
    try {
      await adapter().invoke(
        { capabilityId: "demo.echo", capabilityVersion: "1", input: { message: "x", fail_with: "network_failure" } },
        creds(),
      );
    } catch (e) { err = e; }
    expect((err as AppError).category).toBe("NETWORK_FAILURE");
  });

  it("credential access through the secret boundary: unconnected credential → CREDENTIAL_FAILURE, never PROVIDER_FAILURE", async () => {
    let err: unknown;
    try {
      await adapter().invoke(
        { capabilityId: "demo.echo", capabilityVersion: "1", input: { message: "x" } },
        new StaticCredentialResolver({}), // nothing connected
      );
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).category).toBe("CREDENTIAL_FAILURE");
  });

  it("unsupported capability rejected (name-based compatibility is forbidden)", async () => {
    let err: unknown;
    try {
      await adapter().invoke(
        { capabilityId: "other.capability", capabilityVersion: "1", input: { message: "x" } },
        creds(),
      );
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AppError);
    const ae = err as AppError;
    expect(ae.category).toBe("POLICY_BLOCKED");
    expect(ae.code).toBe("provider.capability.unsupported");
    expect((ae.details as { reason: string }).reason).toBe("capability_not_declared");
  });

  it("unsupported capability VERSION rejected (exact version match required)", async () => {
    let err: unknown;
    try {
      await adapter().invoke(
        { capabilityId: "demo.echo", capabilityVersion: "2", input: { message: "x" } },
        creds(),
      );
    } catch (e) { err = e; }
    const ae = err as AppError;
    expect(ae.code).toBe("provider.capability.unsupported");
    expect((ae.details as { reason: string }).reason).toBe("capability_version_not_declared");
    expect((ae.details as { supported_versions: string[] }).supported_versions).toEqual(["1"]);
  });

  it("malformed input → normalized provider failure (no raw SDK error leaks)", async () => {
    let err: unknown;
    try {
      await adapter().invoke(
        { capabilityId: "demo.echo", capabilityVersion: "1", input: {} },
        creds(),
      );
    } catch (e) { err = e; }
    expect(isNormalizedProviderFailure(err)).toBe(true);
    expect((err as AppError).category).toBe("PROVIDER_FAILURE");
  });
});

describe("WORK-006 adapter registry", () => {
  it("registers and looks up by canonical provider id; duplicate registration rejected", () => {
    const registry = new AdapterRegistry();
    registry.register(createDemoEchoAdapter());
    expect(registry.has("demo.echo")).toBe(true);
    expect(registry.get("demo.echo")!.descriptor().adapterVersion).toBe("1.0.0");
    expect(registry.has("stripe")).toBe(false);
    expect(() => registry.register(createDemoEchoAdapter())).toThrow(/duplicate adapter/);
    expect(registry.list().length).toBe(1);
  });
});

describe("WORK-006 error normalization helpers", () => {
  it("providerError() builds AppErrors with the right category/code prefix", () => {
    const e = providerError("rate_limited", "quota.exceeded", "provider quota exceeded", { retryable: true });
    expect(e.category).toBe("RATE_LIMITED");
    expect(e.code).toBe("provider.quota.exceeded");
    expect((e.details as { provider_error_kind: string }).provider_error_kind).toBe("rate_limited");
  });

  it("normalizeProviderError(): raw SDK-shaped errors are classified, never passed through", () => {
    const raw = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
    const e = normalizeProviderError(raw, { providerId: "demo.echo", operation: "invoke" });
    expect(e).toBeInstanceOf(AppError);
    expect(e.category).toBe("NETWORK_FAILURE");
    expect(e.message).toContain("demo.echo");
    expect(e.retryable).toBe(true);

    const http429 = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(normalizeProviderError(http429, { providerId: "p", operation: "op" }).category).toBe("RATE_LIMITED");

    const http500 = Object.assign(new Error("Internal Server Error"), { status: 500 });
    expect(normalizeProviderError(http500, { providerId: "p", operation: "op" }).category).toBe("PROVIDER_FAILURE");

    const rawTimeout = Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" });
    expect(normalizeProviderError(rawTimeout, { providerId: "p", operation: "op" }).category).toBe("TIMEOUT");

    // Already-normalized AppErrors pass through untouched.
    const existing = providerError("timeout", "x.y", "already normalized");
    expect(normalizeProviderError(existing, { providerId: "p", operation: "op" })).toBe(existing);
  });

  it("isNormalizedProviderFailure() distinguishes provider-side failures from policy failures", () => {
    expect(isNormalizedProviderFailure(providerError("provider_failure", "a.b", "x"))).toBe(true);
    expect(isNormalizedProviderFailure(new AppError({ category: "POLICY_BLOCKED", code: "x", message: "x" }))).toBe(false);
    expect(isNormalizedProviderFailure(new Error("raw"))).toBe(false);
    expect(isProviderErrorKind("timeout")).toBe(true);
    expect(isProviderErrorKind("nope")).toBe(false);
  });
});

describe("WORK-006 identifier validation", () => {
  it("accepts canonical provider ids; rejects malformed/uppercase/whitespace", () => {
    expect(isValidProviderId("paystack")).toBe(true);
    expect(isValidProviderId("provider.openai")).toBe(true);
    expect(isValidProviderId("demo.echo")).toBe(true);
    expect(validateProviderId("paystack")).toBe("paystack");
    expect(isValidProviderId("Paystack")).toBe(false);
    expect(isValidProviderId(" paystack")).toBe(false);
    expect(isValidProviderId("paystack.")).toBe(false);
    expect(isValidProviderId(".paystack")).toBe(false);
    expect(isValidProviderId("1paystack")).toBe(false);
    expect(isValidProviderId("pay stack")).toBe(false);
    expect(isValidProviderId("")).toBe(false);
    expect(() => validateProviderId("Paystack")).toThrow(/lowercase/);
    expect(() => validateProviderId("pay stack")).toThrow(/whitespace/);
    expect(isValidProviderId("a.b.c")).toBe(true);
  });

  it("adapter versions must be MAJOR.MINOR.PATCH", () => {
    expect(isValidAdapterVersion("1.0.0")).toBe(true);
    expect(isValidAdapterVersion("1.2.3")).toBe(true);
    expect(isValidAdapterVersion("1.0")).toBe(false);
    expect(isValidAdapterVersion("v1.0.0")).toBe(false);
    expect(isValidAdapterVersion("1.0.0-beta")).toBe(false);
    expect(() => validateAdapterVersion("1.0")).toThrow(/MAJOR.MINOR.PATCH/);
  });
});

describe("WORK-006 validateTopLevelAgainstSchema (honest top-level validator)", () => {
  const schema = {
    type: "object",
    properties: {
      echoed: { type: "string" },
      echo_id: { type: "string" },
      echoed_at: { type: "string" },
    },
    required: ["echoed", "echo_id"],
  };

  it("accepts conforming outputs", () => {
    expect(
      validateTopLevelAgainstSchema(
        { echoed: "x", echo_id: "echo_1", echoed_at: "now" },
        schema,
      ),
    ).toEqual([]);
  });

  it("rejects wrong root type", () => {
    expect(validateTopLevelAgainstSchema("nope", schema)).toEqual([
      'root type must be object, got string',
    ]);
  });

  it("rejects missing required properties and wrong property types", () => {
    const problems = validateTopLevelAgainstSchema({ echoed: 42 }, schema);
    expect(problems.some((p) => p.includes('"echo_id" is missing'))).toBe(true);
    expect(problems.some((p) => p.includes('"echoed" must be string'))).toBe(true);
  });

  it("true schema allows anything; false schema forbids everything", () => {
    expect(validateTopLevelAgainstSchema({ anything: 1 }, true)).toEqual([]);
    expect(validateTopLevelAgainstSchema(null, false).length).toBe(1);
  });
});
