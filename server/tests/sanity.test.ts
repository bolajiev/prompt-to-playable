import { describe, expect, test } from "vitest";
import type { GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { sanityCheck } from "../src/sanity.js";

function docWith(overrides: Partial<GameDoc>): GameDoc {
  const base: unknown = {
    version: "1.0.0",
    meta: { title: "Sanity Room", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "gem", kind: "collectible", position: [4, 0, 4] },
    ],
    objectives: [{ id: "obj1", type: "collect", targets: ["gem"], count: 1 }],
    rules: [],
    scratch: {},
  };
  const res = validateGame(base);
  if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
  return { ...res.data, ...overrides };
}

function codes(result: ReturnType<typeof sanityCheck>): string[] {
  return result.errors.map((issue) => issue.code);
}

describe("sanityCheck", () => {
  test("accepts a clean layout", () => {
    const result = sanityCheck(docWith({}));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects an orphan target — objective references a missing entity (unsolvable)", () => {
    const doc = docWith({});
    doc.objectives = [{ id: "obj1", type: "reach", target: "ghost-door" }];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    const orphan = result.errors.filter((issue) => issue.code === "missing-objective-target");
    expect(orphan.length).toBe(1);
    expect(orphan[0]?.path).toBe("objectives[obj1].target");
    expect(orphan[0]?.message).toContain("ghost-door");
  });

  test("rejects orphan targets in the targets array", () => {
    const doc = docWith({});
    doc.objectives = [
      { id: "obj1", type: "collect", targets: ["gem", "missing"], count: 1 },
    ];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-objective-target");
  });

  test("rejects an entity referenced by a rule that does not exist", () => {
    const doc = docWith({});
    doc.rules = [
      {
        id: "r1",
        on: { event: "playerEnter", zone: "zoneA" },
        then: [{ type: "despawn", entity: "ghost" }],
      },
    ];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-rule-reference");
    expect(
      result.errors.some(
        (issue) => issue.path === "rules[r1].then[0].entity" && issue.message.includes("ghost")
      )
    ).toBe(true);
  });

  test("rejects a rule referencing an unknown objective", () => {
    const doc = docWith({});
    doc.rules = [
      {
        id: "r1",
        on: { event: "playerEnter", zone: "zoneA" },
        then: [{ type: "objectiveProgress", objective: "does-not-exist", by: 1 }],
      },
    ];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-rule-reference");
    expect(
      result.errors.some((issue) => issue.message.includes("does-not-exist"))
    ).toBe(true);
  });

  test("reports a missing player entity", () => {
    const doc = docWith({});
    doc.entities = [{ id: "gem", kind: "collectible", position: [4, 0, 4] }];
    const result = sanityCheck(doc);
    expect(codes(result)).toContain("no-player");
    expect(result.ok).toBe(false);
  });

  test("rejects an entity position outside world bounds", () => {
    const doc = docWith({});
    (doc.entities.find((e) => e.id === "gem") as NonNullable<GameDoc["entities"][number]>).position = [30, 0, 4];
    const result = sanityCheck(doc);
    expect(codes(result)).toContain("out-of-bounds");
    expect(result.errors.some((issue) => issue.path.includes("entities[gem].position"))).toBe(true);
  });

  test("rejects patrol waypoints outside world bounds", () => {
    const doc = docWith({});
    (doc.entities.find((e) => e.id === "gem") as NonNullable<GameDoc["entities"][number]>).patrol = [
      [0, 0, 0],
      [0, 0, 99],
    ];
    const result = sanityCheck(doc);
    expect(codes(result)).toContain("out-of-bounds");
  });
});

describe("reachability heuristic (deterministic A* on 2D grid)", () => {
  test("open field from player to reach target passes", () => {
    const doc = docWith({});
    doc.objectives = [{ id: "obj1", type: "reach", target: "gem" }];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(true);
    expect(codes(result)).not.toContain("unreachable-target");
  });

  test("is deterministic for identical inputs", () => {
    const doc = docWith({});
    doc.objectives = [{ id: "obj1", type: "reach", target: "gem" }];
    expect(sanityCheck(doc).errors).toEqual(sanityCheck(doc).errors);
  });

  test("rejects a reach target sealed off by an obstacle wall (clearly unsolvable)", () => {
    const doc = docWith({});
    (doc.entities.find((e) => e.id === "player") as NonNullable<GameDoc["entities"][number]>).position = [-5, 0, 0];
    (doc.entities.find((e) => e.id === "gem") as NonNullable<GameDoc["entities"][number]>).position = [5, 0, 5];
    doc.objectives = [{ id: "obj1", type: "reach", target: "gem" }];
    doc.world.terrain.obstacles = [
      { position: [0, 0, 0], size: [0.5, 4, 40] },
    ];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("unreachable-target");
  });

  test("rejects a collect target buried inside an obstacle", () => {
    const doc = docWith({});
    (doc.entities.find((e) => e.id === "gem") as NonNullable<GameDoc["entities"][number]>).position = [3, 0, 0];
    doc.world.terrain.obstacles = [
      { position: [3, 0, 0], size: [2, 4, 2] },
    ];
    const result = sanityCheck(doc);
    expect(codes(result)).toContain("unreachable-target");
  });

  test("reachability is skipped for objectives without positional targets", () => {
    const doc = docWith({});
    doc.objectives = [{ id: "obj1", type: "collect", count: 3 }];
    expect(sanityCheck(doc).ok).toBe(true);
  });
});