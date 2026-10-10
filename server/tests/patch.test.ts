import { describe, expect, test } from "vitest";
import type { GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import {
  PatchError,
  applyPatch,
  parsePointer,
  validatePatch,
} from "../src/patch.js";
import type { JsonPatch } from "../src/patch.js";

function validDoc(): GameDoc {
  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Patch Room", archetype: "puzzle-switch" },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "gem", kind: "collectible", position: [3, 1, 0] },
    ],
    objectives: [],
    rules: [],
    scratch: {},
  });
  if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
  return res.data;
}

describe("parsePointer", () => {
  test("returns an empty token list for the whole document", () => {
    expect(parsePointer("")).toEqual([]);
  });

  test("splits and unescapes RFC 6901 tokens", () => {
    expect(parsePointer("/meta/title")).toEqual(["meta", "title"]);
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(parsePointer("/entities/0/position/1")).toEqual([
      "entities",
      "0",
      "position",
      "1",
    ]);
  });

  test("rejects pointers that are not strings or do not start with '/'", () => {
    expect(() => parsePointer("meta/title")).toThrow(PatchError);
    expect(() => parsePointer("/bad~2escape")).toThrow(PatchError);
    expect(() => parsePointer(42 as unknown as string)).toThrow(PatchError);
  });
});

describe("validatePatch", () => {
  test("accepts a well-formed array of supported operations", () => {
    const patch: unknown = [
      { op: "replace", path: "/meta/title", value: "New" },
      { op: "remove", path: "/scratch/x" },
      { op: "add", path: "/entities/-", value: { id: "e", kind: "prop", position: [0, 0, 0] } },
    ];
    const result = validatePatch(patch);
    expect(result.ok).toBe(true);
    expect(result.patch).toEqual(patch);
    expect(result.issues).toEqual([]);
  });

  test("rejects non-arrays and unknown operations", () => {
    expect(validatePatch({ op: "replace" }).ok).toBe(false);
    const result = validatePatch([{ op: "frobnicate", path: "/meta/title", value: 1 }]);
    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toContain("unsupported op");
  });

  test("requires a valid string path and a value for add/replace", () => {
    const result = validatePatch([
      { op: "replace" },
      { op: "add", path: "/meta/extra" },
      { op: "remove", path: "/scratch/x" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toContain("string 'path'");
    expect(result.issues.join("\n")).toContain("must include a 'value'");
  });
});

describe("applyPatch", () => {
  test("replaces a nested scalar (meta.title)", () => {
    const doc = validDoc();
    const patched = applyPatch(doc, [
      { op: "replace", path: "/meta/title", value: "Patched Title" },
    ]);
    expect(patched.meta.title).toBe("Patched Title");
    expect(patched.meta.archetype).toBe("puzzle-switch");
  });

  test("does not mutate the input document", () => {
    const doc = validDoc();
    const snapshot = JSON.parse(JSON.stringify(doc));
    applyPatch(doc, [{ op: "replace", path: "/meta/title", value: "Changed" }]);
    expect(doc).toEqual(snapshot);
  });

  test("adds and removes array elements", () => {
    const doc = validDoc();
    const added = applyPatch(doc, [
      {
        op: "add",
        path: "/entities/-",
        value: { id: "extra", kind: "prop", position: [1, 1, 1] },
      },
    ]);
    expect(added.entities).toHaveLength(3);
    expect(added.entities[2]?.id).toBe("extra");

    const removed = applyPatch(added, [{ op: "remove", path: "/entities/2" }]);
    expect(removed.entities).toHaveLength(2);
    expect(removed.entities.map((e) => e.id)).toEqual(["player", "gem"]);
  });

  test("adds a new object key and replaces an existing one", () => {
    const doc = validDoc();
    const patched = applyPatch(doc, [
      { op: "add", path: "/scratch/score", value: 5 },
      { op: "replace", path: "/scratch/score", value: 9 },
      { op: "add", path: "/meta/genre", value: "puzzle" },
    ]);
    expect(patched.scratch.score).toBe(9);
    expect(patched.meta.genre).toBe("puzzle");
  });

  test("throws PatchError when replacing or removing a missing path", () => {
    const doc = validDoc();
    expect(() =>
      applyPatch(doc, [{ op: "replace", path: "/meta/missing", value: 1 }])
    ).toThrow(PatchError);
    expect(() =>
      applyPatch(doc, [{ op: "remove", path: "/scratch/nope" }])
    ).toThrow(PatchError);
  });

  test("throws PatchError for out-of-range array indexes", () => {
    const doc = validDoc();
    expect(() => applyPatch(doc, [{ op: "remove", path: "/entities/9" }])).toThrow(
      /out of range/
    );
    expect(() =>
      applyPatch(doc, [{ op: "replace", path: "/entities/1/position/0", value: 1 }])
    ).not.toThrow();
  });

  test("rejects an invalid patch shape before applying", () => {
    const doc = validDoc();
    expect(() =>
      applyPatch(doc, [{ op: "move", path: "/meta/title" }] as unknown as JsonPatch)
    ).toThrow(PatchError);
  });

  test("blocks prototype pollution attempts", () => {
    const doc = validDoc();
    expect(() =>
      applyPatch(doc, [
        { op: "add", path: "/__proto__/polluted", value: true },
      ])
    ).toThrow(/not allowed/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
