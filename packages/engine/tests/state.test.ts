import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { Engine, createEngine } from "../src/engine.js";
import { createState } from "../src/state.js";
import { tick } from "../src/tick.js";

function loadMinimalDoc(): GameDoc {
  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Tiny Room", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
    objectives: [{ id: "obj1", type: "collect", count: 1 }],
    rules: [],
    scratch: {},
  });
  if (!res.ok || !res.data) {
    throw new Error("minimal doc failed schema validation");
  }
  return res.data;
}

describe("Engine", () => {
  test("loads a doc and step(16.666) advances time", () => {
    const engine = new Engine();
    const initial = engine.load(loadMinimalDoc(), 42);

    expect(initial.time).toBe(0);
    expect(initial.ticks).toBe(0);

    const after = engine.step(16.666);

    expect(after.time).toBeGreaterThan(0);
    expect(after.ticks).toBe(1);
    expect(engine.getState()).toBe(after);
  });

  test("steps multiple frames via accumulated dt", () => {
    const engine = createEngine({ fixedDtMs: 10 });
    engine.load(loadMinimalDoc());

    const after = engine.step(35);

    expect(after.ticks).toBe(3);
    expect(after.time).toBeCloseTo(0.03, 6);
  });

  test("getState throws before load", () => {
    const engine = new Engine();
    expect(() => engine.getState()).toThrow();
  });

  test("cannot step before load", () => {
    const engine = new Engine();
    expect(() => engine.step(16.666)).toThrow();
  });
});

describe("tick", () => {
  test("returns a new state and emits a tick event", () => {
    const state = createState(loadMinimalDoc(), 7);
    const next = tick(state, 1 / 60);

    expect(next).not.toBe(state);
    expect(next.time).toBeCloseTo(1 / 60, 10);
    expect(next.ticks).toBe(1);
    expect(state.time).toBe(0);
    expect(next.events.some((e) => e.type === "tick")).toBe(true);
  });

  test("copies doc data so runtime mutation does not touch the source", () => {
    const doc = loadMinimalDoc();
    const state = createState(doc);
    state.entities[0].position[0] = 999;
    expect(doc.entities[0].position[0]).toBe(0);
  });
});
