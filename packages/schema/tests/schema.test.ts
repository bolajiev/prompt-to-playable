import { describe, expect, test } from "vitest";
import { isGame, validateGame } from "../src/validators.js";
import { GameSchema, SCHEMA_VERSION } from "../src/schema.js";

function minimalDoc() {
  return {
    version: SCHEMA_VERSION,
    meta: { title: "Tiny Room", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
    objectives: [{ id: "obj1", type: "collect", count: 1 }],
    rules: [],
    scratch: {},
  };
}

describe("GameSchema", () => {
  test("minimal valid doc passes isGame", () => {
    expect(isGame(minimalDoc())).toBe(true);
  });

  test("validateGame returns ok with parsed data (defaults applied)", () => {
    const res = validateGame(minimalDoc());
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.data?.meta.archetype).toBe("collect-a-thon");
    expect(res.data?.world.lighting).toBe("day");
    expect(res.data?.rules).toEqual([]);
    expect(res.data?.entities[0]?.active).toBe(true);
  });

  test("missing player entity fails", () => {
    const doc = minimalDoc();
    doc.entities = [{ id: "crystal", kind: "collectible", position: [1, 1, 1] }] as typeof doc.entities;
    expect(isGame(doc)).toBe(false);
    const res = validateGame(doc);
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  test("bad archetype fails", () => {
    const doc = minimalDoc();
    (doc.meta as { archetype: string }).archetype = "racing";
    expect(isGame(doc)).toBe(false);
  });

  test("bad version fails", () => {
    const doc = minimalDoc();
    (doc as { version: string }).version = "0.0.1";
    expect(isGame(doc)).toBe(false);
  });

  test("missing title fails", () => {
    const doc = minimalDoc();
    (doc.meta as { title?: string }).title = undefined;
    expect(isGame(doc)).toBe(false);
  });

  test("rules constrained to allowed events and actions", () => {
    const doc = minimalDoc();
    doc.objectives = [{ id: "obj1", type: "collect", count: 1 }] as typeof doc.objectives;
    (doc as { rules: unknown[] }).rules = [
      {
        id: "r1",
        on: { event: "playerEnter", zone: "z1" },
        then: [{ type: "objectiveProgress", objective: "obj1", by: 1 }],
      },
    ];
    expect(isGame(doc)).toBe(true);
  });

  test("unknown event is rejected", () => {
    const doc = minimalDoc();
    (doc as { rules: unknown[] }).rules = [
      { id: "r1", on: { event: "explode" }, then: [{ type: "win" }] },
    ];
    expect(isGame(doc)).toBe(false);
  });

  test("unknown action is rejected", () => {
    const doc = minimalDoc();
    (doc as { rules: unknown[] }).rules = [
      { id: "r1", on: { event: "playerEnter" }, then: [{ type: "launchNuke" }] },
    ];
    expect(isGame(doc)).toBe(false);
  });

  test("condition (scratch comparison) parses", () => {
    const doc = minimalDoc();
    (doc as { rules: unknown[] }).rules = [
      {
        id: "r1",
        on: { event: "interact" },
        if: {
          op: "<",
          left: { var: "crystals_lit" },
          right: 3,
        },
        then: [{ type: "incVar", key: "crystals_lit", by: 1 }],
      },
    ];
    expect(isGame(doc)).toBe(true);
  });

  test("bare SafeParse reports success without validators layer", () => {
    expect(GameSchema.safeParse(minimalDoc()).success).toBe(true);
  });
});
