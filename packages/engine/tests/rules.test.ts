import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { FIXED_DT_MS, createEngine } from "../src/engine.js";
import { evaluateRules } from "../src/rules.js";
import { createState } from "../src/state.js";
import { tick } from "../src/tick.js";

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

describe("two-phase rule evaluation", () => {
  test("var-gated toggle pair fires exactly one branch per event", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Toggle Room", archetype: "puzzle-switch" },
      world: { bounds: [20, 10, 20] },
      entities: [
        { id: "player", kind: "player", position: [0, 0, 0] },
        { id: "lever", kind: "interactable", position: [1, 0, 0] },
      ],
      objectives: [],
      rules: [
        {
          id: "lever-on",
          on: { event: "interact", entity: "lever" },
          if: { op: "==", left: { var: "leverOn" }, right: 0 },
          then: [
            { type: "setVar", key: "leverOn", value: 1 },
            { type: "incVar", key: "turnOns", by: 1 },
          ],
        },
        {
          id: "lever-off",
          on: { event: "interact", entity: "lever" },
          if: { op: "==", left: { var: "leverOn" }, right: 1 },
          then: [
            { type: "setVar", key: "leverOn", value: 0 },
            { type: "incVar", key: "turnOffs", by: 1 },
          ],
        },
      ],
      scratch: { leverOn: 0, turnOns: 0, turnOffs: 0 },
    });

    const event = {
      type: "interact",
      targetId: "lever",
      entityId: "player",
    } as const;

    const first = evaluateRules(createState(doc), [event]);

    expect(first.actions.map((a) => a.type)).toEqual(["setVar", "incVar"]);
    expect(first.state.scratch).toMatchObject({
      leverOn: 1,
      turnOns: 1,
      turnOffs: 0,
    });

    const second = evaluateRules(first.state, [event]);

    expect(second.actions.map((a) => a.type)).toEqual(["setVar", "incVar"]);
    expect(second.state.scratch).toMatchObject({
      leverOn: 0,
      turnOns: 1,
      turnOffs: 1,
    });
  });

  test("same-pass var chaining no longer happens: conditions read pass-start state", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Gate Room", archetype: "puzzle-switch" },
      world: { bounds: [20, 10, 20] },
      entities: [{ id: "player", kind: "player", position: [0, 0, 0] }],
      objectives: [],
      rules: [
        {
          id: "set-gate",
          on: { event: "tick" },
          then: [{ type: "setVar", key: "gate", value: 1 }],
        },
        {
          id: "read-gate",
          on: { event: "tick" },
          if: { op: "==", left: { var: "gate" }, right: 1 },
          then: [{ type: "incVar", key: "through", by: 1 }],
        },
      ],
      scratch: { gate: 0, through: 0 },
    });

    const first = evaluateRules(createState(doc), [{ type: "tick" }]);

    expect(first.state.scratch.gate).toBe(1);
    expect(first.state.scratch.through).toBe(0);
    expect(first.actions.map((a) => a.type)).toEqual(["setVar"]);

    const second = evaluateRules(first.state, [{ type: "tick" }]);

    expect(second.state.scratch.through).toBe(1);
    expect(second.actions.map((a) => a.type)).toEqual(["setVar", "incVar"]);
  });

  test("objectiveProgress -> var -> objectiveComplete chains across passes", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Counted Room", archetype: "collect-a-thon" },
      world: { bounds: [20, 10, 20] },
      entities: [{ id: "player", kind: "player", position: [0, 0, 0] }],
      objectives: [{ id: "crystals", type: "collect", count: 2 }],
      rules: [
        {
          id: "collect",
          on: { event: "tick" },
          then: [{ type: "objectiveProgress", objective: "crystals", by: 1 }],
        },
        {
          id: "count",
          on: { event: "objectiveProgress", objective: "crystals" },
          then: [{ type: "incVar", key: "counted", by: 1 }],
        },
        {
          id: "win-on-complete",
          on: { event: "objectiveComplete", objective: "crystals" },
          if: { op: ">=", left: { var: "counted" }, right: 1 },
          then: [{ type: "win" }],
        },
      ],
      scratch: { counted: 0 },
    });

    let state = createState(doc, 1);
    state = tick(state, 1 / 60);

    expect(state.objectives.find((o) => o.id === "crystals")?.progress).toBe(1);
    expect(state.scratch.counted).toBe(1);
    expect(state.status).toBe("running");

    state = tick(state, 1 / 60);

    expect(state.objectives.find((o) => o.id === "crystals")?.status).toBe("done");
    expect(state.scratch.counted).toBe(2);
    expect(state.status).toBe("won");
    expect(
      state.events.some(
        (e) => e.type === "objectiveComplete" && e.objectiveId === "crystals"
      )
    ).toBe(true);
  });

  test("a rule matching two events in one pass fires twice (no dedupe)", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Click Counter", archetype: "explore" },
      world: { bounds: [20, 10, 20] },
      entities: [{ id: "player", kind: "player", position: [0, 0, 0] }],
      objectives: [],
      rules: [
        {
          id: "count-clicks",
          on: { event: "click" },
          then: [{ type: "incVar", key: "clicks", by: 1 }],
        },
      ],
      scratch: { clicks: 0 },
    });

    const result = evaluateRules(createState(doc), [
      { type: "click", targetId: "a" },
      { type: "click", targetId: "b" },
    ]);

    expect(result.actions).toHaveLength(2);
    expect(result.state.scratch.clicks).toBe(2);
  });

  test("door slides open, shut and open again across interacts", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Front Door", archetype: "explore", mode: "walkthrough" },
      world: { bounds: [20, 10, 20] },
      entities: [
        { id: "player", kind: "player", position: [0, 1, 0] },
        {
          id: "front-door",
          kind: "interactable",
          position: [1, 1, 0],
          size: [1, 2, 0.2],
          tags: ["door"],
          props: { door: true, interactRange: 3.5 },
        },
      ],
      objectives: [],
      rules: [
        {
          id: "open-front-door",
          on: { event: "interact", entity: "front-door" },
          if: { op: "==", left: { var: "doorOpen" }, right: 0 },
          then: [
            {
              type: "animate",
              entity: "front-door",
              kind: "slide",
              to: [2, 1, 0],
              duration: 900,
            },
            { type: "openDoor", entity: "front-door" },
            { type: "setVar", key: "doorOpen", value: 1 },
          ],
        },
        {
          id: "close-front-door",
          on: { event: "interact", entity: "front-door" },
          if: { op: "==", left: { var: "doorOpen" }, right: 1 },
          then: [
            {
              type: "animate",
              entity: "front-door",
              kind: "slide",
              to: [1, 1, 0],
              duration: 900,
            },
            { type: "setVar", key: "doorOpen", value: 0 },
          ],
        },
      ],
      scratch: { doorOpen: 0 },
    });

    const engine = createEngine();
    engine.load(doc);
    const position = (): number[] => [
      ...engine.getState().entityRuntime["front-door"].position,
    ];
    const press = (): void => {
      engine.step(FIXED_DT_MS, { interact: true });
      engine.step(FIXED_DT_MS, { interact: false });
      for (let step = 0; step < 90; step += 1) engine.step(FIXED_DT_MS);
    };

    const start = position();
    press();
    const opened = position();
    expect(opened[0]).toBeCloseTo(2, 3);
    expect(engine.getState().scratch.doorOpen).toBe(1);

    press();
    const closed = position();
    expect(closed[0]).toBeCloseTo(start[0], 3);
    expect(engine.getState().scratch.doorOpen).toBe(0);

    press();
    const reopened = position();
    expect(reopened[0]).toBeCloseTo(opened[0], 3);
    expect(engine.getState().scratch.doorOpen).toBe(1);
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
