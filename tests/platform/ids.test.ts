// tests/platform/ids.test.ts — unit tests for identifier generation.
import { describe, expect, it } from "bun:test";
import {
  ulid,
  isUlid,
  newRequestId,
  newExecutionId,
  newJobId,
  newOperationId,
  newCorrelationId,
} from "@cp/platform";

describe("ids / ulid", () => {
  it("produces a 26-char Crockford-base32 ULID", () => {
    const id = ulid();
    expect(id.length).toBe(26);
    expect(isUlid(id)).toBe(true);
  });

  it("never produces collisions across many generations", () => {
    const set = new Set<string>();
    for (let i = 0; i < 20_000; i++) set.add(ulid());
    expect(set.size).toBe(20_000);
  });

  it("is monotonically sortable by timestamp", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(b > a).toBe(true);
  });

  it("rejects malformed ULIDs", () => {
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("")).toBe(false);
    // I/L/O/U are forbidden in Crockford base32
    expect(isUlid("I" + "0".repeat(25))).toBe(false);
  });

  it("prefixed identifiers carry their semantic prefix", () => {
    expect(newRequestId()).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newExecutionId()).toMatch(/^exec_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newJobId()).toMatch(/^job_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newOperationId()).toMatch(/^op_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newCorrelationId()).toMatch(/^corr_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
