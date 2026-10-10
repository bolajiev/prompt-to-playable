import { describe, expect, test } from "vitest";
import type { GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { validateAndSanity, validateDoc } from "../src/validate.js";

function minimalDoc(): Record<string, unknown> {
  return {
    version: "1.0.0",
    meta: { title: "Tiny Room", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
    objectives: [],
    rules: [],
    scratch: {},
  };
}

function asDoc(value: Record<string, unknown>): GameDoc {
  const res = validateGame(value);
  if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
  return res.data;
}

describe("validateDoc", () => {
  test("accepts a valid doc with structured outcome", () => {
    const result = validateDoc(minimalDoc());
    expect(result.ok).toBe(true);
    expect(result.data?.meta.title).toBe("Tiny Room");
    expect(result.issues).toEqual([]);
  });

  test("rejects a bad doc with structured, human-readable errors", () => {
    const result = validateDoc({ ...minimalDoc(), version: "0.0.1" });
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toMatchObject({ path: "version" });
    expect(typeof result.issues[0]?.message).toBe("string");
  });

  test("reports path with array indices for nested failures", () => {
    const doc = minimalDoc();
    (doc.entities as unknown[])[0] = {
      id: "player",
      kind: "player",
      position: [0, 1],
    };
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path.includes("[0]"))).toBe(true);
  });

  test("rejects unsupported archetype", () => {
    const doc = minimalDoc();
    (doc.meta as { archetype: string }).archetype = "racing";
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path.includes("archetype"))).toBe(true);
  });

  test("rejects missing player entity", () => {
    const doc = minimalDoc();
    doc.entities = [{ id: "gem", kind: "collectible", position: [1, 1, 1] }];
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path.includes("entities"))).toBe(true);
  });

  test("rejects non-object input", () => {
    const result = validateDoc(null);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("validateAndSanity", () => {
  test("passes a doc that is schema-valid and satisfies invariants", () => {
    const report = validateAndSanity(minimalDoc());
    expect(report.ok).toBe(true);
    expect(report.validation.ok).toBe(true);
    expect(report.sanity.ok).toBe(true);
    expect(report.data?.world.bounds).toEqual([20, 10, 20]);
  });

  test("fails a schema-valid doc that violates invariants (orphan target)", () => {
    const doc = asDoc(minimalDoc());
    doc.objectives = [
      { id: "obj1", type: "reach", target: "door" },
    ];
    const report = validateAndSanity(doc);
    expect(report.ok).toBe(false);
    expect(report.validation.ok).toBe(true);
    expect(report.sanity.ok).toBe(false);
    expect(
      report.sanity.errors.some((issue) => issue.code === "missing-objective-target")
    ).toBe(true);
  });
});