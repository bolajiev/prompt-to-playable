import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { Engine, createEngine } from "../src/engine.js";
import { createState } from "../src/state.js";
import { tick } from "../src/tick.js";

function parseDoc(input: unknown): GameDoc {
  const res = validateGame(input);
  if (!res.ok || !res.data) {
    throw new Error("interact doc failed schema validation");
  }
  return res.data;
}

function baseDoc(entities: unknown[], rules: unknown[] = []): GameDoc {
  return parseDoc({
    version: "1.0.0",
    meta: { title: "Lever Room", archetype: "puzzle-switch" },
    world: { bounds: [20, 10, 20] },
    entities,
    objectives: [],
    rules,
    scratch: {},
  });
}

describe("interact events", () => {
  test("rising edge near interactables emits exactly one interact for the nearest", () => {
    const doc = baseDoc([
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "near-lever", kind: "interactable", position: [1, 1, 0] },
      { id: "far-lever", kind: "interactable", position: [2, 1, 0] },
    ]);

    const engine = createEngine();
    engine.load(doc);

    const pressed = engine.step(16.666, { interact: true });
    const interacts = pressed.events.filter((e) => e.type === "interact");
    expect(interacts).toHaveLength(1);
    expect(interacts[0]).toEqual({
      type: "interact",
      targetId: "near-lever",
      entityId: "player",
    });

    const held = engine.step(16.666, { interact: true });
    expect(held.events.filter((e) => e.type === "interact")).toHaveLength(0);

    engine.step(16.666, { interact: false });

    const pressedAgain = engine.step(16.666, { interact: true });
    expect(
      pressedAgain.events.filter((e) => e.type === "interact")
    ).toHaveLength(1);
  });

  test("detects entities tagged interactable as well as kind interactable", () => {
    const doc = baseDoc([
      { id: "player", kind: "player", position: [0, 1, 0] },
      {
        id: "switch",
        kind: "prop",
        tags: ["interactable"],
        position: [1, 1, 0],
      },
    ]);

    const engine = createEngine();
    engine.load(doc);
    const state = engine.step(16.666, { interact: true });

    const interacts = state.events.filter((e) => e.type === "interact");
    expect(interacts).toHaveLength(1);
    expect(
      interacts[0].type === "interact" ? interacts[0].targetId : undefined
    ).toBe("switch");
  });

  test("does not emit interact when every interactable is out of range", () => {
    const doc = baseDoc([
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "far-lever", kind: "interactable", position: [5, 1, 0] },
    ]);

    const engine = createEngine();
    engine.load(doc);
    const state = engine.step(16.666, { interact: true });

    expect(state.events.filter((e) => e.type === "interact")).toHaveLength(0);
  });

  test("props.interactRange overrides the default range per entity", () => {
    const doc = baseDoc([
      { id: "player", kind: "player", position: [0, 1, 0] },
      {
        id: "reachable",
        kind: "interactable",
        position: [4, 1, 0],
        props: { interactRange: 6 },
      },
      {
        id: "too-close",
        kind: "interactable",
        position: [0.5, 1, 0],
        props: { interactRange: 0.25 },
      },
    ]);

    const engine = createEngine();
    engine.load(doc);
    const state = engine.step(16.666, { interact: true });

    const interacts = state.events.filter((e) => e.type === "interact");
    expect(interacts).toHaveLength(1);
    expect(
      interacts[0].type === "interact" ? interacts[0].targetId : undefined
    ).toBe("reachable");
  });
});

describe("objective transition events", () => {
  test("objectiveProgress is emitted when progress increases and fires rules without double-applying", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Crystal Room", archetype: "collect-a-thon" },
      world: { bounds: [20, 10, 20] },
      entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
      objectives: [{ id: "crystals", type: "collect", count: 3 }],
      rules: [
        {
          id: "advance",
          on: { event: "tick" },
          then: [{ type: "objectiveProgress", objective: "crystals", by: 1 }],
        },
        {
          id: "count-progress",
          on: { event: "objectiveProgress", objective: "crystals" },
          then: [{ type: "incVar", key: "counted", by: 1 }],
        },
      ],
      scratch: { counted: 0 },
    });

    const engine = createEngine();
    engine.load(doc);

    const first = engine.step(16.666);
    expect(first.objectives.find((o) => o.id === "crystals")?.progress).toBe(1);
    expect(first.scratch.counted).toBe(1);
    expect(
      first.events.some(
        (e) =>
          e.type === "objectiveProgress" &&
          e.objectiveId === "crystals" &&
          e.by === 1
      )
    ).toBe(true);

    const second = engine.step(16.666);
    expect(second.objectives.find((o) => o.id === "crystals")?.progress).toBe(2);
    expect(second.scratch.counted).toBe(2);
  });

  test("active -> failed timeLimit emits objectiveFailed and a matching rule can lose", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Timer Room", archetype: "platformer-lite" },
      world: { bounds: [20, 10, 20] },
      entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
      objectives: [{ id: "timer", type: "timeLimit", time: 0.01 }],
      rules: [
        {
          id: "count-failures",
          on: { event: "objectiveFailed" },
          then: [{ type: "incVar", key: "failures", by: 1 }],
        },
        {
          id: "lose-on-fail",
          on: { event: "objectiveFailed", entity: "timer" },
          then: [{ type: "lose" }],
        },
      ],
      scratch: { failures: 0 },
    });

    const next = tick(createState(doc), 1 / 60);

    expect(next.time).toBeCloseTo(1 / 60);
    expect(next.objectives.find((o) => o.id === "timer")?.status).toBe("failed");
    expect(next.scratch.failures).toBe(1);
    expect(next.status).toBe("lost");
    expect(
      next.events.some(
        (e) => e.type === "objectiveFailed" && e.objectiveId === "timer"
      )
    ).toBe(true);
  });
});

describe("terminal step guard", () => {
  test("Engine.step does not advance time or ticks once status is terminal", () => {
    const doc = baseDoc(
      [{ id: "player", kind: "player", position: [0, 1, 0] }],
      [{ id: "win", on: { event: "tick" }, then: [{ type: "win" }] }]
    );

    const engine: Engine = createEngine();
    engine.load(doc);

    const won = engine.step(16.666);
    expect(won.status).toBe("won");
    const time = won.time;
    const ticks = won.ticks;

    const after = engine.step(16.666);
    expect(after).toBe(won);
    expect(after.time).toBe(time);
    expect(after.ticks).toBe(ticks);

    const again = engine.step(16.666, { moveX: 1 });
    expect(again).toBe(won);
    expect(again.time).toBe(time);
    expect(again.ticks).toBe(ticks);
  });
});
