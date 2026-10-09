import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { Engine, createEngine } from "../src/engine.js";
import { createState } from "../src/state.js";
import { tick } from "../src/tick.js";

function parseDoc(input: unknown): GameDoc {
  const res = validateGame(input);
  if (!res.ok || !res.data) {
    throw new Error("integration doc failed schema validation");
  }
  return res.data;
}

function puzzleDoc(): GameDoc {
  return parseDoc({
    version: "1.0.0",
    meta: { title: "Crystal Gate", archetype: "collect-a-thon", seed: 1 },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "crystal", kind: "collectible", position: [0, 1, 0] },
      { id: "crystal-zone", kind: "zone", position: [0, 1, 0], size: [3, 3, 3] },
    ],
    objectives: [{ id: "crystals", type: "collect", count: 1 }],
    rules: [
      {
        id: "r1",
        on: { event: "playerEnter", zone: "crystal-zone" },
        then: [
          { type: "despawn", entity: "crystal" },
          { type: "objectiveProgress", objective: "crystals", by: 1 },
        ],
      },
      {
        id: "r2",
        on: { event: "objectiveComplete", objective: "crystals" },
        then: [
          {
            type: "spawn",
            entity: { id: "exit", kind: "exitDoor", position: [8, 1, 0] },
          },
        ],
      },
    ],
    scratch: {},
  });
}

describe("integrated tick", () => {
  test("player enters zone -> rule fires -> objective completes -> completion rule spawns exit", () => {
    const state = createState(puzzleDoc(), 1);

    const next = tick(state, 1 / 60);

    expect(next.events.some((e) => e.type === "playerEnter")).toBe(true);
    expect(next.events.some((e) => e.type === "objectiveComplete")).toBe(true);

    expect(next.entities.some((e) => e.id === "crystal")).toBe(false);
    expect(next.entityRuntime.crystal).toBeUndefined();
    expect(next.objectives.find((o) => o.id === "crystals")?.status).toBe("done");

    expect(next.entities.some((e) => e.id === "exit")).toBe(true);

    expect(next).not.toBe(state);
    expect(state.entities.some((e) => e.id === "crystal")).toBe(true);
    expect(state.objectives.find((o) => o.id === "crystals")?.status).toBe("active");
    expect(state.entities.some((e) => e.id === "exit")).toBe(false);
  });

  test("does not re-emit playerEnter while the player stays in the zone", () => {
    const engine = createEngine();
    engine.load(puzzleDoc(), 1);

    const first = engine.step(16.666);
    const second = engine.step(16.666);

    expect(first.events.filter((e) => e.type === "playerEnter")).toHaveLength(1);
    expect(second.events.filter((e) => e.type === "playerEnter")).toHaveLength(0);
  });

  test("re-evaluates rules after an objective completes (small loop)", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Reach Room", archetype: "platformer-lite" },
      world: { bounds: [20, 10, 20] },
      entities: [{ id: "player", kind: "player", position: [0, 0, 0] }],
      objectives: [{ id: "escape", type: "reach", target: "door" }],
      rules: [
        {
          id: "complete-escape",
          on: { event: "tick" },
          then: [{ type: "setObjective", objective: "escape", status: "done" }],
        },
        {
          id: "win-on-complete",
          on: { event: "objectiveComplete", objective: "escape" },
          then: [{ type: "win" }],
        },
      ],
      scratch: {},
    });

    const state = createState(doc, 1);
    const next = tick(state, 1 / 60);

    expect(next.objectives.find((o) => o.id === "escape")?.status).toBe("done");
    expect(next.status).toBe("won");
    expect(
      next.events.some(
        (e) => e.type === "objectiveComplete" && e.objectiveId === "escape"
      )
    ).toBe(true);
  });

  test("same seed and steps produce identical state (determinism)", () => {
    const build = () => {
      const engine = createEngine();
      engine.load(puzzleDoc(), 12345);
      return engine;
    };

    const a = build();
    const b = build();

    for (let i = 0; i < 30; i++) {
      a.step(16.666);
      b.step(16.666);
    }

    expect(JSON.stringify(a.getState())).toBe(JSON.stringify(b.getState()));

    const s1 = createState(puzzleDoc(), 999);
    const s2 = createState(puzzleDoc(), 999);
    let t1 = s1;
    let t2 = s2;
    for (let i = 0; i < 10; i++) {
      t1 = tick(t1, 1 / 60);
      t2 = tick(t2, 1 / 60);
    }
    expect(JSON.stringify(t1)).toBe(JSON.stringify(t2));
  });
});
