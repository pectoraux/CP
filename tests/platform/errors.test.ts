// tests/platform/errors.test.ts — failure classification (architecture §31).
import { describe, expect, it } from "bun:test";
import { AppError, FAILURE_CATEGORIES } from "@cp/platform";

describe("AppError / failure model", () => {
  it("exposes the §31 failure categories", () => {
    expect(FAILURE_CATEGORIES).toContain("PROVIDER_FAILURE");
    expect(FAILURE_CATEGORIES).toContain("POLICY_BLOCKED");
    expect(FAILURE_CATEGORIES).toContain("TIMEOUT");
    expect(FAILURE_CATEGORIES).toContain("INELIGIBLE");
    expect(FAILURE_CATEGORIES).toContain("EXPERIMENT_FAILURE");
    expect(FAILURE_CATEGORIES.length).toBe(11);
  });

  it("classifies a provider failure distinctly from a policy block", () => {
    const provider = new AppError({
      category: "PROVIDER_FAILURE",
      code: "provider.5xx",
      message: "provider returned 500",
      retryable: true,
    });
    const policy = new AppError({
      category: "POLICY_BLOCKED",
      code: "policy.region_blocked",
      message: "region not allowed",
    });
    expect(provider.category).toBe("PROVIDER_FAILURE");
    expect(policy.category).toBe("POLICY_BLOCKED");
    expect(provider.retryable).toBe(true);
    expect(policy.retryable).toBe(false);
    // a provider failure must NOT be represented as a policy failure
    expect(provider.category).not.toBe(policy.category);
  });

  it("preserves cause and details", () => {
    const cause = new Error("underlying");
    const err = new AppError({
      category: "TIMEOUT",
      code: "exec.timeout",
      message: "timed out",
      cause,
      details: { budget_ms: 1000 },
    });
    expect(err.message).toBe("timed out");
    expect(err.details.budget_ms).toBe(1000);
    expect(err.causeValue).toBe(cause);
  });

  it("serializes to a structured object", () => {
    const err = new AppError({
      category: "RATE_LIMITED",
      code: "provider.rate_limited",
      message: "429",
    });
    const json = err.toJSON();
    expect(json.category).toBe("RATE_LIMITED");
    expect(json.code).toBe("provider.rate_limited");
  });
});
