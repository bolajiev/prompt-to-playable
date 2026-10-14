import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { createEngine, type Engine } from "../src/engine.js";

const FIXED = 16.666;
const DT = FIXED / 1000;

function parseDoc(input: unknown): GameDoc {
  const res = validateGame(input);
  if (!res.ok || !res.data) {
    throw new Error("animation doc failed schema validation");
  }
  return res.data;
}

interface Extra {
  entities?: unknown[];
  objectives?: unknown[];
  rules?: unknown[];
}

function animationDoc(action: unknown, extra: Extra = {}): GameDoc {
  return parseDoc({
    version: "1.0.0",
    meta: { title: "Animation Lab", archetype: "collect-a-thon", seed: 4 },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "gem", kind: "prop", position: [0, 1, 0] },
      ...(extra.entities ?? []),
    ],
    objectives: extra.objectives ?? [],
    rules: [
      { id: "animate-gem", on: { event: "click", entity: "gem" }, then: [action] },
      ...(extra.rules ?? []),
    ],
    scratch: {},
  });
}

function startEngine(action: unknown, extra: Extra = {}): Engine {
  const engine = createEngine();
  engine.load(animationDoc(action, extra), 4);
  engine.pushEvent({ type: "click", targetId: "gem" });
  engine.step(FIXED);
  return engine;
}

function advance(engine: Engine, ticks: number): void {
  for (let i = 0; i < ticks; i++) engine.step(FIXED);
}

describe("animations", () => {
  test("spin accumulates rotation around the axis", () => {
    const engine = startEngine({
      type: "animate",
      entity: "gem",
      kind: "spin",
      axis: [0, 1, 0],
      speed: 2,
    });
    advance(engine, 60);

    const runtime = engine.getState().entityRuntime.gem;
    const animation = runtime.animations[0];
    expect(runtime.animations).toHaveLength(1);
    expect(animation.kind).toBe("spin");
    expect(animation.elapsed).toBeCloseTo(60 * DT, 6);
    expect(runtime.rotation?.[1]).toBeCloseTo(2 * 60 * DT, 4);
    expect(runtime.rotation?.[0]).toBeCloseTo(0, 9);
    expect(runtime.position).toEqual([0, 1, 0]);

    advance(engine, 60);
    expect(engine.getState().entityRuntime.gem.rotation?.[1]).toBeCloseTo(
      2 * 120 * DT,
      3
    );
  });

  test("spin defaults to the Y axis when none is given", () => {
    const engine = startEngine({
      type: "animate",
      entity: "gem",
      kind: "spin",
      speed: 1,
    });
    advance(engine, 30);

    const runtime = engine.getState().entityRuntime.gem;
    expect(runtime.rotation?.[1]).toBeCloseTo(30 * DT, 6);
    expect(runtime.rotation?.[0]).toBeCloseTo(0, 9);
  });

  test("bob stays inside its amplitude band and leaves XZ untouched", () => {
    const engine = startEngine({
      type: "animate",
      entity: "gem",
      kind: "bob",
      amplitude: 0.5,
      speed: 1,
    });

    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 240; i++) {
      engine.step(FIXED);
      const runtime = engine.getState().entityRuntime.gem;
      minY = Math.min(minY, runtime.position[1]);
      maxY = Math.max(maxY, runtime.position[1]);
      expect(runtime.position[1]).toBeGreaterThanOrEqual(1 - 0.5 - 1e-9);
      expect(runtime.position[1]).toBeLessThanOrEqual(1 + 0.5 + 1e-9);
      expect(runtime.position[0]).toBe(0);
      expect(runtime.position[2]).toBe(0);
    }

    expect(minY).toBeLessThan(0.7);
    expect(maxY).toBeGreaterThan(1.3);
  });

  test("slide lerps then snaps exactly on target and drops the entry", () => {
    const engine = startEngine({
      type: "animate",
      entity: "gem",
      kind: "slide",
      to: [4, 1, 0],
      duration: 500,
    });

    advance(engine, 15);
    const midway = engine.getState().entityRuntime.gem;
    expect(midway.position[0]).toBeGreaterThan(0);
    expect(midway.position[0]).toBeLessThan(4);
    expect(midway.animations).toHaveLength(1);

    advance(engine, 16);
    const arrived = engine.getState().entityRuntime.gem;
    expect(arrived.position).toEqual([4, 1, 0]);
    expect(arrived.animations).toHaveLength(0);

    advance(engine, 100);
    const resting = engine.getState().entityRuntime.gem;
    expect(resting.position).toEqual([4, 1, 0]);
    expect(resting.animations).toHaveLength(0);
  });

  test("orbit stays on its circle around basePos", () => {
    const engine = startEngine({
      type: "animate",
      entity: "gem",
      kind: "orbit",
      amplitude: 2,
      speed: 0.25,
    });

    let moved = false;
    for (let i = 0; i < 120; i++) {
      engine.step(FIXED);
      const runtime = engine.getState().entityRuntime.gem;
      expect(Math.hypot(runtime.position[0], runtime.position[2])).toBeCloseTo(2, 6);
      expect(runtime.position[1]).toBe(1);
      if (Math.abs(runtime.position[0] - 2) > 1e-6) moved = true;
    }
    expect(moved).toBe(true);
  });

  test("pulse keeps its entry and exposes a bounded 0..1 factor", () => {
    const engine = startEngine({
      type: "animate",
      entity: "gem",
      kind: "pulse",
      speed: 2,
    });
    advance(engine, 5);

    const first = engine.getState().entityRuntime.gem.animations[0];
    const firstPulse = first.pulse as number;
    expect(first.kind).toBe("pulse");
    expect(firstPulse).toBeGreaterThanOrEqual(0);
    expect(firstPulse).toBeLessThanOrEqual(1);

    advance(engine, 25);
    const later = engine.getState().entityRuntime.gem.animations[0];
    expect(later.pulse).toBeGreaterThanOrEqual(0);
    expect(later.pulse).toBeLessThanOrEqual(1);
    expect(later.pulse).not.toBe(firstPulse);

    advance(engine, 300);
    expect(engine.getState().entityRuntime.gem.animations).toHaveLength(1);
  });

  test("re-animating the same kind replaces the entry and resets the base", () => {
    const doc = animationDoc(
      {
        type: "animate",
        entity: "gem",
        kind: "bob",
        amplitude: 0.5,
        speed: 1,
      },
      {
        rules: [
          {
            id: "rebob",
            on: { event: "click", entity: "player" },
            then: [
              {
                type: "animate",
                entity: "gem",
                kind: "bob",
                amplitude: 0.2,
                speed: 1,
              },
            ],
          },
        ],
      }
    );

    const engine = createEngine();
    engine.load(doc, 4);
    engine.pushEvent({ type: "click", targetId: "gem" });
    engine.step(FIXED);
    expect(engine.getState().entityRuntime.gem.animations).toHaveLength(1);

    advance(engine, 31);
    expect(engine.getState().entityRuntime.gem.position[1]).not.toBe(1);

    engine.pushEvent({ type: "click", targetId: "player" });
    engine.step(FIXED);
    const after = engine.getState().entityRuntime.gem;

    expect(after.animations).toHaveLength(1);
    expect(after.animations[0].kind).toBe("bob");
    expect(after.animations[0].amplitude).toBe(0.2);
    expect(after.animations[0].elapsed).toBe(0);
    expect(after.animations[0].basePos[1]).toBe(after.position[1]);
    expect(after.animations[0].basePos[1]).not.toBe(1);
  });

  test("two engines with the same seed, actions and ticks stay identical", () => {
    const action = {
      type: "animate",
      entity: "gem",
      kind: "orbit",
      amplitude: 1.5,
      speed: 0.75,
    };
    const run = (): string => {
      const engine = startEngine(action);
      advance(engine, 150);
      return JSON.stringify(engine.getState());
    };

    expect(run()).toBe(run());
  });

  test("a sliding zone really moves: playerEnter fires at the new position", () => {
    const engine = startEngine(
      { type: "animate", entity: "gate", kind: "slide", to: [0, 1, 0], duration: 50 },
      {
        entities: [
          { id: "gate", kind: "zone", position: [8, 1, 0], size: [2, 2, 2] },
        ],
        objectives: [{ id: "reach", type: "reach", count: 1 }],
        rules: [
          {
            id: "gate-enter",
            on: { event: "playerEnter", zone: "gate" },
            then: [{ type: "objectiveProgress", objective: "reach", by: 1 }],
          },
        ],
      }
    );

    expect(engine.getState().objectives[0]?.progress).toBe(0);

    let sawEnter = false;
    for (let i = 0; i < 220; i++) {
      engine.step(FIXED);
      if (
        engine
          .getState()
          .events.some((e) => e.type === "playerEnter" && e.zoneId === "gate")
      ) {
        sawEnter = true;
      }
    }

    const state = engine.getState();
    expect(state.entityRuntime.gate.position).toEqual([0, 1, 0]);
    expect(state.entityRuntime.gate.animations).toHaveLength(0);
    expect(state.objectives.find((o) => o.id === "reach")?.status).toBe("done");
    expect(sawEnter).toBe(true);
  });
});
