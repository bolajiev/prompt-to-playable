import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { createState } from "../src/state.js";
import { tick } from "../src/tick.js";

function parseDoc(input: unknown): GameDoc {
  const res = validateGame(input);
  if (!res.ok || !res.data) {
    throw new Error("zone doc failed schema validation");
  }
  return res.data;
}

function collectDoc(
  playerPosition: [number, number, number],
  zonePosition: [number, number, number],
  zoneSize: [number, number, number]
): GameDoc {
  return parseDoc({
    version: "1.0.0",
    meta: { title: "Small Zone", archetype: "collect-a-thon", seed: 1 },
    world: { bounds: [30, 10, 30] },
    entities: [
      { id: "player", kind: "player", position: playerPosition },
      { id: "crystal", kind: "collectible", position: [5, 0, 5] },
      { id: "zone", kind: "zone", position: zonePosition, size: zoneSize },
    ],
    objectives: [{ id: "collect", type: "collect", count: 1 }],
    rules: [
      {
        id: "pickup",
        on: { event: "playerEnter", zone: "zone" },
        then: [
          { type: "despawn", entity: "crystal" },
          { type: "objectiveProgress", objective: "collect", by: 1 },
        ],
      },
    ],
    scratch: {},
  });
}

describe("zone triggers", () => {
  test("a 1x1x1 floor zone triggers when the player stands on it", () => {
    const state = createState(collectDoc([5, 0, 5], [5, 0, 5], [1, 1, 1]), 1);
    const next = tick(state, 1 / 60);

    expect(
      next.events.some((e) => e.type === "playerEnter" && e.zoneId === "zone")
    ).toBe(true);
    expect(next.objectives[0]?.progress).toBe(1);
  });

  test("a zone entirely above the grounded player does not trigger", () => {
    const state = createState(collectDoc([5, 0, 5], [5, 3, 5], [1, 1, 1]), 1);
    const next = tick(state, 1 / 60);

    expect(next.events.some((e) => e.type === "playerEnter")).toBe(false);
    expect(next.objectives[0]?.progress).toBe(0);
  });

  test("zone overlap uses the player body extents, not the 2x2x2 zone fallback", () => {
    const near = tick(
      createState(collectDoc([5.7, 0, 5], [5, 0, 5], [1, 1, 1]), 1),
      1 / 60
    );
    expect(near.entityRuntime.player.position[1]).toBeCloseTo(0.9);
    expect(
      near.events.some((e) => e.type === "playerEnter" && e.zoneId === "zone")
    ).toBe(true);

    const far = tick(
      createState(collectDoc([6.2, 0, 5], [5, 0, 5], [1, 1, 1]), 1),
      1 / 60
    );
    expect(far.entityRuntime.player.position[1]).toBeCloseTo(0.9);
    expect(far.events.some((e) => e.type === "playerEnter")).toBe(false);
    expect(far.objectives[0]?.progress).toBe(0);
  });

  test("does not re-emit while the player stays on the small zone", () => {
    const state = createState(collectDoc([5, 0, 5], [5, 0, 5], [1, 1, 1]), 1);
    const first = tick(state, 1 / 60);
    const second = tick(first, 1 / 60);

    expect(first.events.filter((e) => e.type === "playerEnter")).toHaveLength(1);
    expect(second.events.filter((e) => e.type === "playerEnter")).toHaveLength(0);
  });
});
