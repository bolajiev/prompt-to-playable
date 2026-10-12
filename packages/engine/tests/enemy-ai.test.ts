import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc, type Vec3 } from "@prompt-to-playable/schema";
import { createEngine } from "../src/engine.js";
import type { GameEvent } from "../src/events.js";
import type { InputState } from "../src/input.js";
import { createState } from "../src/state.js";
import { tick } from "../src/tick.js";

const FIXED_DT = 1 / 60;
const ENEMY_HALF_HEIGHT = 0.5;

interface DocOptions {
  position?: Vec3;
  playerPosition?: Vec3;
  patrol?: Vec3[];
  sight?: number;
  speed?: number;
  size?: Vec3;
  state?: "idle" | "patrol" | "chase" | "return";
  rules?: Record<string, unknown>[];
  scratch?: Record<string, string | number | boolean>;
}

function enemyDoc(options: DocOptions = {}): GameDoc {
  const enemy: Record<string, unknown> = {
    id: "enemy",
    kind: "enemy",
    position: options.position ?? [0, ENEMY_HALF_HEIGHT, 0],
  };
  if (options.patrol !== undefined) enemy.patrol = options.patrol;
  if (options.sight !== undefined) enemy.sight = options.sight;
  if (options.speed !== undefined) enemy.speed = options.speed;
  if (options.size !== undefined) enemy.size = options.size;
  if (options.state !== undefined) enemy.state = options.state;

  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Enemy Room", archetype: "stealth-chase" },
    world: { bounds: [40, 10, 40], terrain: { type: "flat", obstacles: [] } },
    entities: [
      {
        id: "player",
        kind: "player",
        position: options.playerPosition ?? [15, 0.9, 15],
      },
      enemy,
    ],
    objectives: [],
    rules: options.rules ?? [],
    scratch: options.scratch ?? {},
  });
  if (!res.ok || !res.data) {
    throw new Error("enemy doc failed schema validation");
  }
  return res.data;
}

function eventsOf(
  state: ReturnType<typeof createState>,
  type: GameEvent["type"]
): GameEvent[] {
  return state.events.filter((e) => e.type === type);
}

function xzGapToPlayer(state: ReturnType<typeof createState>): number {
  const enemy = state.entityRuntime.enemy.position;
  const player = state.entityRuntime.player.position;
  return Math.hypot(player[0] - enemy[0], player[2] - enemy[2]);
}

describe("enemy patrol", () => {
  test("moves back and forth between waypoints, grounded on the floor", () => {
    const doc = enemyDoc({
      position: [0, ENEMY_HALF_HEIGHT, 0],
      patrol: [
        [0, 0, 0],
        [5, 0, 0],
      ],
      size: [1, 1, 1],
    });

    let state = createState(doc);
    let minX = Infinity;
    let maxX = -Infinity;

    for (let i = 0; i < 600; i++) {
      state = tick(state, FIXED_DT);
      const runtime = state.entityRuntime.enemy;
      minX = Math.min(minX, runtime.position[0]);
      maxX = Math.max(maxX, runtime.position[0]);
      expect(runtime.position[1]).toBeCloseTo(ENEMY_HALF_HEIGHT, 6);
      expect(runtime.grounded).toBe(true);
    }

    expect(state.entityRuntime.enemy.state).toBe("patrol");
    expect(maxX).toBeGreaterThan(4.8);
    expect(minX).toBeLessThan(0.2);
  });

  test("enemy without patrol or sight stays idle and settles on the floor", () => {
    const doc = enemyDoc({ position: [2, 3, 2] });

    let state = createState(doc);
    for (let i = 0; i < 120; i++) {
      state = tick(state, FIXED_DT);
    }

    const runtime = state.entityRuntime.enemy;
    expect(runtime.state).toBe("idle");
    expect(runtime.position).toEqual([2, ENEMY_HALF_HEIGHT, 2]);
    expect(runtime.grounded).toBe(true);
  });
});

describe("enemy chase and return", () => {
  test("chases the player when within sight", () => {
    const doc = enemyDoc({
      position: [0, ENEMY_HALF_HEIGHT, 0],
      patrol: [
        [0, 0, 0],
        [10, 0, 0],
      ],
      sight: 6,
      size: [1, 1, 1],
      playerPosition: [4, 0.9, 0],
    });

    let state = createState(doc);
    const startGap = xzGapToPlayer(state);

    for (let i = 0; i < 30; i++) {
      state = tick(state, FIXED_DT);
    }

    const runtime = state.entityRuntime.enemy;
    expect(runtime.state).toBe("chase");
    expect(runtime.position[0]).toBeGreaterThan(0.5);
    expect(xzGapToPlayer(state)).toBeLessThan(startGap);
  });

  test("returns to patrol[0] when the player escapes beyond sight * 1.25", () => {
    const doc = enemyDoc({
      position: [5, ENEMY_HALF_HEIGHT, 0],
      patrol: [
        [0, 0, 0],
        [5, 0, 0],
      ],
      sight: 3,
      size: [1, 1, 1],
      state: "chase",
      playerPosition: [20, 0.9, 20],
    });

    let state = createState(doc);
    state = tick(state, FIXED_DT);

    const afterTick = state.entityRuntime.enemy;
    expect(afterTick.state).toBe("return");
    expect(afterTick.velocity[0]).toBeLessThan(0);

    let sawReturn = false;
    let returnedToPatrol = false;
    for (let i = 0; i < 300; i++) {
      state = tick(state, FIXED_DT);
      const runtime = state.entityRuntime.enemy;
      if (runtime.state === "return") sawReturn = true;
      if (sawReturn && runtime.state === "patrol") {
        expect(runtime.position[0]).toBeLessThan(0.2);
        returnedToPatrol = true;
        break;
      }
    }

    expect(sawReturn).toBe(true);
    expect(returnedToPatrol).toBe(true);
  });
});

describe("enemyContact", () => {
  test("emits exactly one contact on overlap and re-arms after separation", () => {
    const doc = enemyDoc({
      position: [0, ENEMY_HALF_HEIGHT, 0],
      size: [1, 1, 1],
      playerPosition: [0, 0.9, 0],
    });

    let state = createState(doc);

    state = tick(state, FIXED_DT);
    const first = eventsOf(state, "enemyContact");
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({
      type: "enemyContact",
      entityId: "enemy",
      targetId: "player",
    });
    expect(state.entityRuntime.enemy.contactArmed).toBe(false);

    state = tick(state, FIXED_DT);
    expect(eventsOf(state, "enemyContact")).toHaveLength(0);

    for (let i = 0; i < 20; i++) {
      state = tick(state, FIXED_DT, { moveX: 1 });
    }
    expect(state.entityRuntime.enemy.contactArmed).toBe(true);

    const duringReturn: GameEvent[] = [];
    for (let i = 0; i < 20; i++) {
      state = tick(state, FIXED_DT, { moveX: -1 });
      duringReturn.push(...eventsOf(state, "enemyContact"));
    }

    expect(duringReturn).toHaveLength(1);
    expect(state.entityRuntime.enemy.contactArmed).toBe(false);
  });

  test("contact rules match the enemy entity id", () => {
    const doc = enemyDoc({
      position: [0, ENEMY_HALF_HEIGHT, 0],
      size: [1, 1, 1],
      playerPosition: [0, 0.9, 0],
      rules: [
        {
          id: "contact",
          on: { event: "enemyContact", entity: "enemy" },
          then: [{ type: "incVar", key: "contacts", by: 1 }],
        },
      ],
      scratch: { contacts: 0 },
    });

    let state = createState(doc);
    state = tick(state, FIXED_DT);
    expect(state.scratch.contacts).toBe(1);

    state = tick(state, FIXED_DT);
    expect(state.scratch.contacts).toBe(1);
  });
});

describe("enemy determinism", () => {
  test("same seed and input sequence produce identical enemy positions", () => {
    const inputs: InputState[] = [
      { moveX: 0, moveZ: 0, jump: false, interact: false },
      { moveX: 1, moveZ: 0, jump: false, interact: false },
      { moveX: -1, moveZ: 1, jump: false, interact: false },
      { moveX: 0, moveZ: -1, jump: true, interact: false },
    ];

    const run = (): Vec3[] => {
      const engine = createEngine();
      engine.load(
        enemyDoc({
          position: [0, ENEMY_HALF_HEIGHT, 0],
          patrol: [
            [0, 0, 0],
            [6, 0, 0],
          ],
          sight: 5,
          size: [1, 1, 1],
          playerPosition: [2, 0.9, 0],
        }),
        4242
      );

      const positions: Vec3[] = [];
      for (let i = 0; i < 240; i++) {
        engine.step(16.666, inputs[i % inputs.length]);
        positions.push([...engine.getState().entityRuntime.enemy.position] as Vec3);
      }
      return positions;
    };

    const first = run();
    expect(first.some((p) => p[0] !== 0)).toBe(true);
    expect(first).toEqual(run());
  });
});
