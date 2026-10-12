import { describe, expect, test } from "vitest";
import {
  validateGame,
  type GameDoc,
  type Vec3,
} from "@prompt-to-playable/schema";
import type { AABB } from "@prompt-to-playable/shared";
import {
  aabbFromBox,
  collectSolids,
  resolveXZ,
  resolveY,
} from "../src/collision.js";
import { createState } from "../src/state.js";
import { tick } from "../src/tick.js";

const FIXED_DT = 1 / 60;
const PLAYER_SIZE: Vec3 = [0.6, 1.8, 0.6];
const HALF_HEIGHT = 0.9;

interface DocOptions {
  bounds?: Vec3;
  obstacles?: { position: Vec3; size: Vec3 }[];
  entities?: Record<string, unknown>[];
}

function collisionDoc(options: DocOptions = {}): GameDoc {
  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Collision Room", archetype: "platformer-lite" },
    world: {
      bounds: options.bounds ?? [20, 10, 20],
      terrain: { type: "flat", obstacles: options.obstacles ?? [] },
    },
    entities: options.entities ?? [
      { id: "player", kind: "player", position: [0, HALF_HEIGHT, 0] },
    ],
    objectives: [],
    rules: [],
    scratch: {},
  });
  if (!res.ok || !res.data) {
    throw new Error("collision doc failed schema validation");
  }
  return res.data;
}

function playerRuntime(state: ReturnType<typeof createState>) {
  return state.entityRuntime.player;
}

describe("aabbFromBox", () => {
  test("converts center and size to min/max", () => {
    expect(aabbFromBox({ position: [1, 2, 3], size: [2, 4, 6] })).toEqual({
      min: [0, 0, 0],
      max: [2, 4, 6],
    });
  });
});

describe("collectSolids", () => {
  test("includes terrain obstacles and active solid/platform entities", () => {
    const state = createState(
      collisionDoc({
        obstacles: [{ position: [0, 0.5, 0], size: [1, 1, 1] }],
        entities: [
          { id: "player", kind: "player", position: [0, HALF_HEIGHT, 0] },
          {
            id: "platform",
            kind: "platform",
            position: [3, 0.5, 0],
            size: [2, 1, 2],
          },
          {
            id: "crate",
            kind: "prop",
            position: [-3, 0.5, 0],
            size: [1, 1, 1],
            solid: true,
          },
          { id: "decor", kind: "prop", position: [6, 0.5, 0], size: [1, 1, 1] },
          {
            id: "ghost",
            kind: "platform",
            position: [8, 0.5, 0],
            size: [1, 1, 1],
            active: false,
          },
          { id: "blob", kind: "platform", position: [10, 0.5, 0] },
        ],
      })
    );

    const solids = collectSolids(state);

    expect(solids).toHaveLength(4);
    expect(solids[0]).toEqual({ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] });
    expect(solids[1]).toEqual({ min: [2, 0, -1], max: [4, 1, 1] });
    expect(solids[2]).toEqual({ min: [-3.5, 0, -0.5], max: [-2.5, 1, 0.5] });
    expect(solids[3]).toEqual({ min: [9.5, 0, -0.5], max: [10.5, 1, 0.5] });
  });

  test("uses runtime position and runtime active flag", () => {
    const state = createState(
      collisionDoc({
        entities: [
          { id: "player", kind: "player", position: [0, HALF_HEIGHT, 0] },
          {
            id: "crate",
            kind: "prop",
            position: [0, 0.5, 0],
            size: [1, 1, 1],
            solid: true,
          },
        ],
      })
    );
    state.entityRuntime.crate.position = [5, 0.5, 0];

    let solids = collectSolids(state);
    expect(solids).toHaveLength(1);
    expect(solids[0]).toEqual({ min: [4.5, 0, -0.5], max: [5.5, 1, 0.5] });

    state.entityRuntime.crate.active = false;
    solids = collectSolids(state);
    expect(solids).toHaveLength(0);
  });
});

describe("resolveXZ", () => {
  const wall: AABB = { min: [1, 0, -2], max: [2, 2, 2] };

  test("pushes out along the moving axis and zeroes that velocity", () => {
    const pos: Vec3 = [1.2, HALF_HEIGHT, 0];
    const vel: Vec3 = [6, 0, 3];

    const res = resolveXZ(pos, vel, PLAYER_SIZE, [wall]);

    expect(res.pos[0]).toBeCloseTo(1 - PLAYER_SIZE[0] / 2, 6);
    expect(res.pos[2]).toBeCloseTo(0, 6);
    expect(res.vel[0]).toBe(0);
    expect(res.vel[2]).toBe(3);
  });

  test("does not push when only touching a face", () => {
    const pos: Vec3 = [1 - PLAYER_SIZE[0] / 2, HALF_HEIGHT, 0];
    const vel: Vec3 = [6, 0, 0];

    const res = resolveXZ(pos, vel, PLAYER_SIZE, [wall]);

    expect(res.pos).toEqual(pos);
    expect(res.vel).toEqual(vel);
  });

  test("returns fresh arrays and never mutates inputs", () => {
    const pos: Vec3 = [1.2, HALF_HEIGHT, 0];
    const vel: Vec3 = [6, 0, 3];

    const res = resolveXZ(pos, vel, PLAYER_SIZE, [wall]);

    expect(res.pos).not.toBe(pos);
    expect(res.vel).not.toBe(vel);
    expect(pos).toEqual([1.2, HALF_HEIGHT, 0]);
    expect(vel).toEqual([6, 0, 3]);
  });
});

describe("resolveY", () => {
  const platform: AABB = { min: [-1, 0, -1], max: [1, 1, 1] };

  test("lands on top with downward velocity and reports grounded", () => {
    const res = resolveY(
      [0, 0.85, 0],
      [0, -2, 0],
      PLAYER_SIZE,
      [platform]
    );

    expect(res.pos[1]).toBeCloseTo(platform.max[1] + HALF_HEIGHT, 6);
    expect(res.vel[1]).toBe(0);
    expect(res.grounded).toBe(true);
  });

  test("stops upward velocity under a solid bottom", () => {
    const ceiling: AABB = { min: [-2, 2.5, -2], max: [2, 3.5, 2] };

    const res = resolveY([0, 2.2, 0], [0, 3, 0], PLAYER_SIZE, [ceiling]);

    expect(res.pos[1]).toBeCloseTo(ceiling.min[1] - HALF_HEIGHT, 6);
    expect(res.vel[1]).toBe(0);
    expect(res.grounded).toBe(false);
  });

  test("leaves free-falling motion untouched", () => {
    const res = resolveY(
      [0, 5, 0],
      [0, -2, 0],
      PLAYER_SIZE,
      [platform]
    );

    expect(res.pos).toEqual([0, 5, 0]);
    expect(res.vel).toEqual([0, -2, 0]);
    expect(res.grounded).toBe(false);
  });
});

describe("player vs obstacle wall", () => {
  test("walking into a wall stops X but slides on Z", () => {
    const doc = collisionDoc({
      obstacles: [{ position: [2, 1, 0], size: [1, 2, 20] }],
      entities: [
        { id: "player", kind: "player", position: [0, HALF_HEIGHT, 0] },
      ],
    });

    let state = createState(doc);
    for (let i = 0; i < 60; i++) {
      state = tick(state, FIXED_DT, { moveX: 1, moveZ: 1 });
    }

    const runtime = playerRuntime(state);
    expect(runtime.position[0]).toBeCloseTo(1.5 - PLAYER_SIZE[0] / 2, 6);
    expect(runtime.position[2]).toBeGreaterThan(5.5);
    expect(runtime.velocity[0]).toBe(0);
    expect(runtime.velocity[2]).toBeCloseTo(6, 6);
    expect(runtime.position[1]).toBeCloseTo(HALF_HEIGHT, 6);
    expect(runtime.grounded).toBe(true);
  });
});

describe("player vs platform", () => {
  test("falling onto a platform top rests at top + halfHeight and stays grounded", () => {
    const doc = collisionDoc({
      entities: [
        { id: "player", kind: "player", position: [0, 3, 0] },
        {
          id: "platform",
          kind: "platform",
          position: [0, 1, 0],
          size: [4, 0.5, 4],
        },
      ],
    });

    const top = 1 + 0.5 / 2;
    let state = createState(doc);
    for (let i = 0; i < 120; i++) {
      state = tick(state, FIXED_DT);
    }

    const runtime = playerRuntime(state);
    expect(runtime.position[1]).toBeCloseTo(top + HALF_HEIGHT, 6);
    expect(runtime.grounded).toBe(true);
    expect(runtime.velocity[1]).toBe(0);

    for (let i = 0; i < 60; i++) {
      state = tick(state, FIXED_DT);
    }
    expect(playerRuntime(state).position[1]).toBeCloseTo(
      top + HALF_HEIGHT,
      6
    );
  });

  test("walking off a platform falls back to the floor", () => {
    const doc = collisionDoc({
      entities: [
        { id: "player", kind: "player", position: [0, 2.15, 0] },
        {
          id: "platform",
          kind: "platform",
          position: [0, 1, 0],
          size: [4, 0.5, 4],
        },
      ],
    });

    let state = createState(doc);
    state = tick(state, FIXED_DT);
    state = tick(state, FIXED_DT);
    expect(playerRuntime(state).grounded).toBe(true);

    for (let i = 0; i < 30; i++) {
      state = tick(state, FIXED_DT, { moveX: 1 });
    }
    for (let i = 0; i < 60; i++) {
      state = tick(state, FIXED_DT);
    }

    const runtime = playerRuntime(state);
    expect(runtime.position[0]).toBeGreaterThan(2.3);
    expect(runtime.position[1]).toBeCloseTo(HALF_HEIGHT, 6);
    expect(runtime.grounded).toBe(true);
  });
});

describe("player jump collision", () => {
  test("jumping onto an obstacle top lands the player on it", () => {
    const doc = collisionDoc({
      obstacles: [{ position: [2, 0.5, 0], size: [2, 1, 2] }],
      entities: [
        { id: "player", kind: "player", position: [0, HALF_HEIGHT, 0] },
      ],
    });

    let state = createState(doc);
    state = tick(state, FIXED_DT);
    state = tick(state, FIXED_DT);
    expect(playerRuntime(state).grounded).toBe(true);

    state = tick(state, FIXED_DT, { moveX: 1, jump: true });
    for (let i = 0; i < 14; i++) {
      state = tick(state, FIXED_DT, { moveX: 1 });
    }
    for (let i = 0; i < 90; i++) {
      state = tick(state, FIXED_DT);
    }

    const runtime = playerRuntime(state);
    expect(runtime.position[1]).toBeCloseTo(1 + HALF_HEIGHT, 6);
    expect(runtime.position[0]).toBeGreaterThan(1);
    expect(runtime.position[0]).toBeLessThan(3);
    expect(runtime.grounded).toBe(true);
  });

  test("standing under a low ceiling stops upward velocity", () => {
    const doc = collisionDoc({
      obstacles: [{ position: [0, 3, 0], size: [4, 1, 4] }],
      entities: [
        { id: "player", kind: "player", position: [0, HALF_HEIGHT, 0] },
      ],
    });

    let state = createState(doc);
    state = tick(state, FIXED_DT);
    state = tick(state, FIXED_DT);
    expect(playerRuntime(state).grounded).toBe(true);

    state = tick(state, FIXED_DT, { jump: true });

    let bumped = false;
    for (let i = 0; i < 60; i++) {
      state = tick(state, FIXED_DT);
      const runtime = playerRuntime(state);
      if (runtime.velocity[1] === 0 && !runtime.grounded) {
        bumped = true;
        break;
      }
    }

    expect(bumped).toBe(true);
    const runtime = playerRuntime(state);
    expect(runtime.position[1]).toBeCloseTo(2.5 - HALF_HEIGHT, 6);
    expect(runtime.position[1] + HALF_HEIGHT).toBeLessThanOrEqual(2.5 + 1e-9);
    expect(runtime.grounded).toBe(false);

    for (let i = 0; i < 90; i++) {
      state = tick(state, FIXED_DT);
    }
    expect(playerRuntime(state).position[1]).toBeCloseTo(HALF_HEIGHT, 6);
    expect(playerRuntime(state).grounded).toBe(true);
  });
});
