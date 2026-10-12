import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc, type Vec3 } from "@prompt-to-playable/schema";
import { createEngine } from "../src/engine.js";
import {
  NEUTRAL_INPUT,
  sanitizeInput,
  type InputState,
} from "../src/input.js";
import { createState } from "../src/state.js";
import { tick } from "../src/tick.js";

const DEFAULT_HALF_HEIGHT = 0.9;
const FIXED_DT = 1 / 60;

function movementDoc(options: { speed?: number } = {}): GameDoc {
  const player: Record<string, unknown> = {
    id: "player",
    kind: "player",
    position: [0, 5, 0],
  };
  if (options.speed !== undefined) player.speed = options.speed;

  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Movement Room", archetype: "platformer-lite" },
    world: { bounds: [20, 10, 20], terrain: { type: "flat", obstacles: [] } },
    entities: [player],
    objectives: [],
    rules: [],
    scratch: {},
  });
  if (!res.ok || !res.data) {
    throw new Error("movement doc failed schema validation");
  }
  return res.data;
}

function playerPosition(doc: GameDoc): Vec3 {
  return doc.entities[0].position;
}

describe("player movement", () => {
  test("neutral input settles the player on the floor and sets grounded", () => {
    const state = createState(movementDoc());
    let next = state;
    for (let i = 0; i < 120; i++) {
      next = tick(next, FIXED_DT);
    }

    const runtime = next.entityRuntime.player;
    expect(runtime.position[1]).toBeCloseTo(DEFAULT_HALF_HEIGHT, 6);
    expect(runtime.grounded).toBe(true);
    expect(runtime.velocity[1]).toBe(0);

    expect(state.entityRuntime.player.position[1]).toBe(5);
    expect(playerPosition(state.doc)[1]).toBe(5);
  });

  test("holding moveZ moves the player by ~speed per second", () => {
    let next = createState(movementDoc({ speed: 6 }));
    for (let i = 0; i < 60; i++) {
      next = tick(next, FIXED_DT, { moveZ: 1 });
    }

    const dz = next.entityRuntime.player.position[2];
    expect(dz).toBeGreaterThanOrEqual(5.5);
    expect(dz).toBeLessThanOrEqual(6.5);
    expect(next.entityRuntime.player.position[0]).toBeCloseTo(0, 6);
  });

  test("jump lifts the player off the floor only while grounded", () => {
    let next = createState(movementDoc());
    for (let i = 0; i < 120; i++) {
      next = tick(next, FIXED_DT);
    }
    expect(next.entityRuntime.player.grounded).toBe(true);

    next = tick(next, FIXED_DT, { jump: true });
    const rt = next.entityRuntime.player;
    expect(rt.position[1]).toBeGreaterThan(DEFAULT_HALF_HEIGHT);
    expect(rt.grounded).toBe(false);
    expect(rt.velocity[1]).toBeCloseTo(8, 6);

    const again = tick(next, FIXED_DT, { jump: true });
    expect(again.entityRuntime.player.grounded).toBe(false);
    expect(again.entityRuntime.player.velocity[1]).toBeCloseTo(
      8 - 9.8 * FIXED_DT,
      6
    );
  });
});

describe("sanitizeInput", () => {
  test("clamps analog axes and coerces non-boolean flags", () => {
    const sanitized = sanitizeInput({
      moveX: 5,
      moveZ: -3,
      jump: "yes" as unknown as boolean,
      interact: 1 as unknown as boolean,
    });

    expect(sanitized.moveX).toBe(1);
    expect(sanitized.moveZ).toBe(-1);
    expect(sanitized.jump).toBe(false);
    expect(sanitized.interact).toBe(false);
  });

  test("neutral defaults for missing or non-finite values", () => {
    expect(sanitizeInput()).toEqual(NEUTRAL_INPUT);
    expect(sanitizeInput({ moveX: Number.NaN, moveZ: Number.POSITIVE_INFINITY })).toEqual(
      NEUTRAL_INPUT
    );
  });
});

describe("input state", () => {
  test("stores sanitized input and shifts previous input", () => {
    const state = createState(movementDoc());
    expect(state.input).toEqual(NEUTRAL_INPUT);
    expect(state.prevInput).toEqual(NEUTRAL_INPUT);

    const first = tick(state, FIXED_DT, { moveZ: 1, jump: true });

    expect(first.input.moveZ).toBe(1);
    expect(first.input.jump).toBe(true);
    expect(first.prevInput).toEqual(NEUTRAL_INPUT);
    expect(state.input.moveZ).toBe(0);

    const second = tick(first, FIXED_DT, { moveX: -1 });

    expect(second.input.moveX).toBe(-1);
    expect(second.input.moveZ).toBe(0);
    expect(second.prevInput).toEqual(first.input);
    expect(second.prevInput.moveZ).toBe(1);
  });
});

describe("determinism with input", () => {
  test("same seed and identical input sequence produce identical positions", () => {
    const inputs: InputState[] = [
      { moveX: 0, moveZ: 0, jump: false, interact: false },
      { moveX: 1, moveZ: 0, jump: false, interact: false },
      { moveX: 1, moveZ: 1, jump: true, interact: false },
      { moveX: -1, moveZ: 0.25, jump: false, interact: true },
      { moveX: 0, moveZ: -1, jump: true, interact: false },
    ];

    const run = (): Vec3[] => {
      const engine = createEngine();
      engine.load(movementDoc({ speed: 6 }), 777);
      const positions: Vec3[] = [];
      for (let i = 0; i < 90; i++) {
        const input = inputs[i % inputs.length];
        engine.step(16.666, input);
        const runtime = engine.getState().entityRuntime.player;
        positions.push([...runtime.position] as Vec3);
      }
      return positions;
    };

    expect(run()).toEqual(run());
  });
});
