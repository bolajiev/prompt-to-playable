import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { evaluateRules } from "../src/rules.js";
import { createState } from "../src/state.js";

function parseDoc(input: unknown): GameDoc {
  const res = validateGame(input);
  if (!res.ok || !res.data) {
    throw new Error("doc failed schema validation");
  }
  return res.data;
}

describe("evaluateRules actions", () => {
  test("playerEnter despawns the crystal and advances the objective", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Crystal Room", archetype: "collect-a-thon" },
      world: { bounds: [20, 10, 20] },
      entities: [
        { id: "player", kind: "player", position: [0, 1, 0] },
        { id: "crystal", kind: "collectible", position: [2, 1, 0] },
        { id: "crystal-zone", kind: "zone", position: [2, 1, 0] },
      ],
      objectives: [{ id: "crystals", type: "collect", count: 3 }],
      rules: [
        {
          id: "r1",
          on: { event: "playerEnter", zone: "crystal-zone" },
          then: [
            { type: "despawn", entity: "crystal" },
            { type: "objectiveProgress", objective: "crystals", by: 1 },
          ],
        },
      ],
      scratch: {},
    });

    const state = createState(doc);
    const snapshot = JSON.stringify({
      entities: state.entities,
      objectives: state.objectives,
    });

    const { state: next, actions } = evaluateRules(state, [
      { type: "playerEnter", zoneId: "crystal-zone", entityId: "player" },
    ]);

    expect(next.entityRuntime.crystal).toBeUndefined();
    expect(next.entities.some((e) => e.id === "crystal")).toBe(false);
    expect(next.objectives.find((o) => o.id === "crystals")?.progress).toBe(1);
    expect(actions.map((a) => a.type)).toContain("despawn");
    expect(actions.map((a) => a.type)).toContain("objectiveProgress");

    expect(next).not.toBe(state);
    expect(
      JSON.stringify({ entities: state.entities, objectives: state.objectives })
    ).toBe(snapshot);
    expect(state.objectives.find((o) => o.id === "crystals")?.progress).toBe(0);
  });

  test("does not fire a rule whose zone does not match the event", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Zone Room", archetype: "collect-a-thon" },
      world: { bounds: [20, 10, 20] },
      entities: [
        { id: "player", kind: "player", position: [0, 1, 0] },
        { id: "crystal", kind: "collectible", position: [2, 1, 0] },
      ],
      objectives: [{ id: "crystals", type: "collect", count: 3 }],
      rules: [
        {
          id: "r1",
          on: { event: "playerEnter", zone: "other-zone" },
          then: [{ type: "despawn", entity: "crystal" }],
        },
      ],
      scratch: {},
    });

    const state = createState(doc);
    const result = evaluateRules(state, [
      { type: "playerEnter", zoneId: "crystal-zone", entityId: "player" },
    ]);

    expect(result.actions).toHaveLength(0);
    expect(result.state).toBe(state);
  });
});

describe("evaluateRules conditions", () => {
  test("only executes when the scratch comparison holds", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Lit Room", archetype: "puzzle-switch" },
      world: { bounds: [20, 10, 20] },
      entities: [{ id: "player", kind: "player", position: [0, 0, 0] }],
      objectives: [],
      rules: [
        {
          id: "lit",
          on: { event: "tick" },
          if: { op: "<", left: { var: "crystals_lit" }, right: 3 },
          then: [{ type: "incVar", key: "crystals_lit", by: 1 }],
        },
      ],
      scratch: { crystals_lit: 0 },
    });

    const state = createState(doc);
    const first = evaluateRules(state, [{ type: "tick" }]);

    expect(first.state.scratch.crystals_lit).toBe(1);
    expect(first.actions).toHaveLength(1);

    const gated: typeof first.state = {
      ...first.state,
      scratch: { ...first.state.scratch, crystals_lit: 3 },
    };
    const second = evaluateRules(gated, [{ type: "tick" }]);

    expect(second.state.scratch.crystals_lit).toBe(3);
    expect(second.actions).toHaveLength(0);
    expect(second.state).toBe(gated);
  });

  test("and/or, has and hasTag conditions compose and drive win", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Boss Room", archetype: "stealth-chase" },
      world: { bounds: [20, 10, 20] },
      entities: [
        { id: "player", kind: "player", position: [0, 0, 0] },
        { id: "enemy", kind: "enemy", position: [5, 0, 0], tags: ["boss"] },
      ],
      objectives: [],
      rules: [
        {
          id: "boss",
          on: { event: "tick" },
          if: {
            op: "and",
            conditions: [
              { op: "has", entity: "enemy" },
              {
                op: "or",
                conditions: [
                  { op: "<", left: { var: "keys" }, right: 1 },
                  { op: "hasTag", tag: "boss" },
                ],
              },
            ],
          },
          then: [{ type: "win" }],
        },
      ],
      scratch: { keys: 0 },
    });

    const state = createState(doc);
    const won = evaluateRules(state, [{ type: "tick" }]);
    expect(won.state.status).toBe("won");

    const withoutEnemy: typeof state = {
      ...state,
      entities: state.entities.filter((e) => e.id !== "enemy"),
      entityRuntime: { player: state.entityRuntime.player },
    };
    const notWon = evaluateRules(withoutEnemy, [{ type: "tick" }]);
    expect(notWon.state.status).toBe("running");
    expect(notWon.actions).toHaveLength(0);
  });
});

describe("evaluateRules action coverage", () => {
  test("interact triggers enemy state, teleport, toggle and scratch updates", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Lever Room", archetype: "puzzle-switch" },
      world: { bounds: [20, 10, 20] },
      entities: [
        { id: "player", kind: "player", position: [0, 0, 0] },
        { id: "lever", kind: "interactable", position: [1, 0, 0], active: false },
        { id: "enemy", kind: "enemy", position: [5, 0, 0], state: "idle" },
      ],
      objectives: [{ id: "flip", type: "activate", count: 1 }],
      rules: [
        {
          id: "r-lever",
          on: { event: "interact", entity: "lever" },
          then: [
            { type: "toggle", target: "lever" },
            { type: "setEnemyState", entity: "enemy", state: "chase" },
            { type: "teleport", entity: "player", position: [3, 0, 0] },
            { type: "setVar", key: "opened", value: true },
            { type: "setObjective", objective: "flip", status: "done" },
          ],
        },
      ],
      scratch: {},
    });

    const state = createState(doc);
    const { state: next, actions } = evaluateRules(state, [
      { type: "interact", targetId: "lever", entityId: "player" },
    ]);

    expect(next.entityRuntime.lever.active).toBe(true);
    expect(next.entityRuntime.enemy.state).toBe("chase");
    expect(next.entityRuntime.player.position).toEqual([3, 0, 0]);
    expect(next.scratch.opened).toBe(true);
    expect(next.objectives.find((o) => o.id === "flip")?.status).toBe("done");
    expect(actions).toHaveLength(5);
  });
});
