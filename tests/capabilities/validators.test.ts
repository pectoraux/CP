// tests/capabilities/validators.test.ts — Pure unit tests for the canonical
// identifier, contract, and graph logic (WORK-005 §5, §6, §7, §9, §17). No
// database, no mocks — these prove the deterministic validation rules.
import { describe, expect, it } from "bun:test";
import {
  isValidCapabilityId,
  validateCapabilityId,
  isValidVersion,
  validateVersion,
  validateJsonSchemaShape,
  isSideEffect,
  isCapabilityStatus,
  LIFECYCLE_TRANSITIONS,
  SIDE_EFFECTS,
  detectCycle,
  reachableFrom,
  topologicalOrder,
  nodeKey,
} from "@cp/capabilities";
import { AppError } from "@cp/platform";

// ---- Canonical identifier validation (§5) ----------------------------

describe("canonical capability id validation (§5)", () => {
  it("accepts well-formed namespace.action ids", () => {
    for (const id of [
      "payment.accept",
      "ai.generate",
      "identity.verify",
      "message.send",
      "compute.run",
      "storage.put",
      "search.query",
      "document.extract",
      "a.b",
      "ns1.act2",
    ]) {
      expect(isValidCapabilityId(id), `${id} should be valid`).toBe(true);
    }
  });

  it("rejects uppercase (no silent canonicalization)", () => {
    expect(isValidCapabilityId("Payment.Accept")).toBe(false);
    expect(isValidCapabilityId("payment.Accept")).toBe(false);
    expect(isValidCapabilityId("PAYMENT.ACCEPT")).toBe(false);
  });

  it("rejects whitespace", () => {
    expect(isValidCapabilityId("payment .accept")).toBe(false);
    expect(isValidCapabilityId(" payment.accept")).toBe(false);
    expect(isValidCapabilityId("payment.accept\n")).toBe(false);
  });

  it("rejects malformed separators / empty segments / multi-dot", () => {
    expect(isValidCapabilityId("paymentaccept")).toBe(false);
    expect(isValidCapabilityId(".accept")).toBe(false);
    expect(isValidCapabilityId("payment.")).toBe(false);
    expect(isValidCapabilityId("payment.card.accept")).toBe(false);
    expect(isValidCapabilityId("payment..accept")).toBe(false);
    expect(isValidCapabilityId("payment._accept")).toBe(false);
    expect(isValidCapabilityId("payment-accept")).toBe(false);
    expect(isValidCapabilityId("1payment.accept")).toBe(false);
    expect(isValidCapabilityId("payment.1accept")).toBe(false);
  });

  it("validateCapabilityId throws a structured POLICY_BLOCKED on malformed input", () => {
    let threw = false;
    try {
      validateCapabilityId("Payment.Accept");
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).category).toBe("POLICY_BLOCKED");
      expect((err as AppError).code).toBe("capability.id.invalid");
      expect((err as AppError).details?.reason).toBe("uppercase");
    }
    expect(threw).toBe(true);
  });

  it("returns the id unchanged for valid input", () => {
    expect(validateCapabilityId("payment.accept")).toBe("payment.accept");
  });
});

// ---- Version validation (§8) -----------------------------------------

describe("version validation (§8)", () => {
  it("accepts positive integer strings", () => {
    for (const v of ["1", "2", "3", "10", "100"]) {
      expect(isValidVersion(v), `${v} should be valid`).toBe(true);
    }
  });
  it("rejects non-numeric, empty, leading zeros, decimals", () => {
    expect(isValidVersion("")).toBe(false);
    expect(isValidVersion("1.0")).toBe(false);
    expect(isValidVersion("v1")).toBe(false);
    expect(isValidVersion("01")).toBe(false);
    expect(isValidVersion("00")).toBe(false);
    expect(isValidVersion("-1")).toBe(false);
  });
  it("validateVersion throws structured error on malformed", () => {
    let threw = false;
    try {
      validateVersion("01");
    } catch (err) {
      threw = true;
      expect((err as AppError).code).toBe("capability.version.invalid");
      expect((err as AppError).details?.reason).toBe("leading_zero");
    }
    expect(threw).toBe(true);
  });
});

// ---- Side-effect classification + lifecycle (§6, §11) ------------------

describe("side-effect + lifecycle vocabulary (§6, §11)", () => {
  it("exposes the §6 side-effect set", () => {
    expect(SIDE_EFFECTS).toContain("pure");
    expect(SIDE_EFFECTS).toContain("read_only");
    expect(SIDE_EFFECTS).toContain("idempotent_write");
    expect(SIDE_EFFECTS).toContain("non_idempotent_write");
    expect(SIDE_EFFECTS).toContain("transactional");
    expect(SIDE_EFFECTS).toContain("best_effort");
    expect(isSideEffect("idempotent_write")).toBe(true);
    expect(isSideEffect("stripe_charge")).toBe(false);
  });
  it("lifecycle transitions are explicit (draft→active→deprecated→retired, retired terminal)", () => {
    expect(LIFECYCLE_TRANSITIONS.get("draft")).toEqual(["active"]);
    expect(LIFECYCLE_TRANSITIONS.get("active")).toContain("deprecated");
    expect(LIFECYCLE_TRANSITIONS.get("active")).toContain("retired");
    expect(LIFECYCLE_TRANSITIONS.get("deprecated")).toContain("retired");
    expect(LIFECYCLE_TRANSITIONS.get("retired")).toEqual([]);
    expect(LIFECYCLE_TRANSITIONS.get("draft")?.includes("retired")).toBe(false);
    expect(LIFECYCLE_TRANSITIONS.get("draft")?.includes("deprecated")).toBe(false);
    expect(isCapabilityStatus("draft")).toBe(true);
    expect(isCapabilityStatus("published")).toBe(false);
  });
});

// ---- JSON-Schema structural validation (§7) --------------------------

describe("contract schema validation (§7)", () => {
  it("accepts a well-formed object schema", () => {
    const schema = {
      type: "object",
      properties: {
        recipient: { type: "string" },
        body: { type: "string" },
      },
      required: ["recipient", "body"],
    };
    expect(() => validateJsonSchemaShape(schema, "input_schema")).not.toThrow();
  });
  it("accepts a boolean schema (true/false)", () => {
    expect(() => validateJsonSchemaShape(true, "x")).not.toThrow();
    expect(() => validateJsonSchemaShape(false, "x")).not.toThrow();
  });
  it("accepts an array schema with items", () => {
    expect(() =>
      validateJsonSchemaShape(
        { type: "array", items: { type: "string" } },
        "x",
      ),
    ).not.toThrow();
  });
  it("rejects a non-object/non-boolean schema (malformed)", () => {
    let threw = false;
    try {
      validateJsonSchemaShape("not a schema", "input_schema");
    } catch (err) {
      threw = true;
      expect((err as AppError).code).toBe("capability.contract.malformed");
    }
    expect(threw).toBe(true);
  });
  it("rejects an array as the top-level schema", () => {
    expect(() => validateJsonSchemaShape([], "x")).toThrow();
  });
  it("rejects an unknown type", () => {
    expect(() =>
      validateJsonSchemaShape({ type: "stripe_charge" }, "x"),
    ).toThrow();
  });
  it("rejects a non-array required field", () => {
    expect(() =>
      validateJsonSchemaShape({ required: "x" }, "x"),
    ).toThrow();
  });
  it("rejects an empty enum", () => {
    expect(() => validateJsonSchemaShape({ enum: [] }, "x")).toThrow();
  });
  it("rejects deeply nested schemas beyond the depth limit", () => {
    let node: unknown = { type: "string" };
    for (let i = 0; i < 32; i++) {
      node = { type: "object", properties: { x: node } };
    }
    expect(() => validateJsonSchemaShape(node, "x")).toThrow();
  });
  it("validates nested malformed properties", () => {
    expect(() =>
      validateJsonSchemaShape(
        { type: "object", properties: { x: { type: "bogus" } } },
        "x",
      ),
    ).toThrow();
  });
});

// ---- Dependency graph (§9, §17) --------------------------------------

describe("dependency graph cycle detection + traversal (§9, §17)", () => {
  const A1 = nodeKey("cap_a", "1");
  const A2 = nodeKey("cap_a", "2");
  const B1 = nodeKey("cap_b", "1");
  const C1 = nodeKey("cap_c", "1");

  it("no cycle when adding A1→B1 with no existing edges", () => {
    const r = detectCycle([], A1, B1);
    expect(r.hasCycle).toBe(false);
  });
  it("detects a self-dependency (A1→A1)", () => {
    const r = detectCycle([], A1, A1);
    expect(r.hasCycle).toBe(true);
  });
  it("detects a two-node cycle (existing A1→B1, candidate B1→A1)", () => {
    // detectCycle(existing, start, candidateTarget): DFS from
    // candidateTarget; if reaches start → cycle.
    const r = detectCycle([{ from: A1, to: B1 }], B1, A1);
    expect(r.hasCycle).toBe(true);
  });
  it("detects a multi-node cycle (existing A1→B1, B1→C1; candidate C1→A1)", () => {
    const r = detectCycle(
      [{ from: A1, to: B1 }, { from: B1, to: C1 }],
      C1,
      A1,
    );
    expect(r.hasCycle).toBe(true);
  });
  it("no cycle for a DAG with a candidate to a fresh node", () => {
    const existing = [
      { from: A1, to: B1 },
      { from: A1, to: C1 },
      { from: B1, to: C1 },
    ];
    const D1 = nodeKey("cap_d", "1");
    const r = detectCycle(existing, A1, D1);
    expect(r.hasCycle).toBe(false);
  });
  it("reachableFrom returns the transitive set, excluding start", () => {
    const edges = [
      { from: A1, to: B1 },
      { from: B1, to: C1 },
    ];
    const r = reachableFrom(edges, A1);
    expect(r).toContain(B1);
    expect(r).toContain(C1);
    expect(r).not.toContain(A1);
  });
  it("topologicalOrder is deterministic (roots first, sorted ties)", () => {
    const edges = [
      { from: A1, to: B1 },
      { from: A1, to: C1 },
      { from: B1, to: C1 },
    ];
    const { order } = topologicalOrder(edges);
    const aIdx = order.indexOf(A1);
    const bIdx = order.indexOf(B1);
    const cIdx = order.indexOf(C1);
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });
  it("topologicalOrder terminates on a cyclic graph (no infinite loop)", () => {
    const edges = [
      { from: A1, to: B1 },
      { from: B1, to: A1 },
    ];
    const { order } = topologicalOrder(edges);
    expect(order.length).toBe(2);
  });
  void A2;
});
