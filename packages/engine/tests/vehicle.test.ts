import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { createEngine, resolveMode } from "../src/engine.js";

const FIXED = 16.666;

interface Extra {
  entities?: unknown[];
  objectives?: unknown[];
  rules?: unknown[];
}

function parseDoc(input: unknown): GameDoc {
  const res = validateGame(input);
  if (!res.ok || !res.data) {
    throw new Error("vehicle doc failed schema validation");
  }
  return res.data;
}

function driveDoc(extra: Extra = {}): GameDoc {
  return parseDoc({
    version: "1.0.0",
    meta: {
      title: "Kart Run",
      archetype: "platformer-lite",
      mode: "drive",
      seed: 7,
    },
    world: { bounds: [40, 10, 40], terrain: { type: "flat", obstacles: [] } },
    entities: [
      {
        id: "player",
        kind: "player",
        position: [0, 1, 0],
        props: { vehicle: true },
      },
      ...(extra.entities ?? []),
    ],
    objectives: extra.objectives ?? [],
    rules: extra.rules ?? [],
    scratch: {},
  });
}

function drive(
  doc: GameDoc,
  ticks: number,
  input: { moveZ?: number; moveX?: number; jump?: boolean } = { moveZ: 1 }
) {
  const engine = createEngine();
  engine.load(doc, 7);
  for (let i = 0; i < ticks; i++) engine.step(FIXED, input);
  return engine;
}

describe("resolveMode", () => {
  test("explicit meta.mode wins over the archetype fallback", () => {
    expect(resolveMode(driveDoc())).toBe("drive");
    expect(
      resolveMode(
        parseDoc({
          version: "1.0.0",
          meta: { title: "Board", archetype: "collect-a-thon", mode: "inspect" },
          world: { bounds: [10, 10, 10] },
          entities: [{ id: "player", kind: "player", position: [0, 0, 0] }],
          scratch: {},
        })
      )
    ).toBe("inspect");
  });

  test("falls back to explore for the explore archetype and game otherwise", () => {
    const explore = parseDoc({
      version: "1.0.0",
      meta: { title: "Clearing", archetype: "explore" },
      world: { bounds: [10, 10, 10] },
      entities: [{ id: "player", kind: "player", position: [0, 0, 0] }],
      scratch: {},
    });
    const game = parseDoc({
      version: "1.0.0",
      meta: { title: "Arena", archetype: "stealth-chase" },
      world: { bounds: [10, 10, 10] },
      entities: [{ id: "player", kind: "player", position: [0, 0, 0] }],
      scratch: {},
    });

    expect(resolveMode(explore)).toBe("explore");
    expect(resolveMode(game)).toBe("game");
  });
});

describe("vehicle mode", () => {
  test("accelerates along +Z with throttle, settles on the floor", () => {
    const engine = drive(driveDoc(), 120, { moveZ: 1 });
    const runtime = engine.getState().entityRuntime.player;

    expect(runtime.speed).toBeGreaterThan(3);
    expect(runtime.speed).toBeLessThanOrEqual(14);
    expect(runtime.position[2]).toBeGreaterThan(3);
    expect(Math.abs(runtime.position[0])).toBeLessThan(1e-9);
    expect(runtime.position[1]).toBeCloseTo(0.9, 9);
    expect(runtime.grounded).toBe(true);
    expect(runtime.heading).toBe(0);
  });

  test("reverses at the −0.4 * maxSpeed cap", () => {
    const engine = drive(driveDoc(), 180, { moveZ: -1 });
    const runtime = engine.getState().entityRuntime.player;

    expect(runtime.speed).toBeLessThan(0);
    expect(runtime.speed).toBeGreaterThanOrEqual(-0.4 * 14);
    expect(runtime.position[2]).toBeLessThan(-1);
  });

  test("props.maxSpeed caps the forward speed", () => {
    const doc = driveDoc();
    doc.entities[0] = {
      ...doc.entities[0],
      props: { vehicle: true, maxSpeed: 3 },
    };
    const engine = drive(doc, 200, { moveZ: 1 });
    const runtime = engine.getState().entityRuntime.player;

    expect(runtime.speed).toBe(3);
    expect(runtime.position[2]).toBeGreaterThan(3);
  });

  test("steering turns heading and curves the path", () => {
    const engine = drive(driveDoc(), 90, { moveZ: 1, moveX: 1 });
    const runtime = engine.getState().entityRuntime.player;

    expect(runtime.heading).toBeGreaterThan(0.3);
    expect(runtime.position[0]).toBeGreaterThan(0.5);
    expect(runtime.position[2]).toBeGreaterThan(0);
  });

  test("a parked vehicle cannot turn in place", () => {
    const engine = drive(driveDoc(), 120, { moveZ: 0, moveX: 1 });
    const runtime = engine.getState().entityRuntime.player;

    expect(runtime.heading).toBe(0);
    expect(runtime.position[0]).toBeCloseTo(0, 9);
    expect(runtime.position[2]).toBeCloseTo(0, 9);
  });

  test("stops dead on a solid wall instead of passing through or sliding off", () => {
    const doc = driveDoc({
      entities: [
        {
          id: "wall",
          kind: "prop",
          solid: true,
          position: [0, 1, 4],
          size: [8, 3, 0.5],
        },
      ],
    });
    const engine = drive(doc, 300, { moveZ: 1 });
    const runtime = engine.getState().entityRuntime.player;

    const face = 4 - 0.5 / 2 - 0.6 / 2;
    expect(runtime.position[2]).toBeCloseTo(face, 6);
    expect(runtime.position[0]).toBeCloseTo(0, 9);
    expect(runtime.speed).toBe(0);
    expect(runtime.grounded).toBe(true);
  });

  test("world bounds clamp the vehicle", () => {
    const engine = drive(driveDoc(), 600, { moveZ: 1 });
    const runtime = engine.getState().entityRuntime.player;

    expect(runtime.position[2]).toBeCloseTo(40 / 2 - 0.6 / 2, 9);
  });

  test("jump input is ignored: no airborne state", () => {
    const engine = drive(driveDoc(), 120, { moveZ: 1, jump: true });
    const runtime = engine.getState().entityRuntime.player;

    expect(runtime.grounded).toBe(true);
    expect(runtime.position[1]).toBeCloseTo(0.9, 9);
    expect(runtime.velocity[1]).toBe(0);
  });

  test("props.vehicle enables driving without meta.mode", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Prop Car", archetype: "collect-a-thon" },
      world: { bounds: [40, 10, 40] },
      entities: [
        {
          id: "player",
          kind: "player",
          position: [0, 1, 0],
          props: { vehicle: true },
        },
      ],
      objectives: [],
      rules: [],
      scratch: {},
    });
    const engine = drive(doc, 90, { moveZ: 1 });
    const runtime = engine.getState().entityRuntime.player;

    expect(runtime.speed).toBeGreaterThan(2);
    expect(runtime.position[2]).toBeGreaterThan(2);
  });

  test("reaches a checkpoint zone and completes the objective", () => {
    const engine = drive(
      driveDoc({
        entities: [
          {
            id: "cp-0",
            kind: "zone",
            position: [0, 0, 8],
            size: [4, 4, 4],
            props: { checkpointIndex: 0 },
          },
        ],
        objectives: [{ id: "lap", type: "reach", count: 1 }],
        rules: [
          {
            id: "cp-check",
            on: { event: "playerEnter", zone: "cp-0" },
            then: [{ type: "objectiveProgress", objective: "lap", by: 1 }],
          },
        ],
      }),
      300,
      { moveZ: 1 }
    );

    const state = engine.getState();
    expect(state.entityRuntime.player.position[2]).toBeGreaterThan(6);
    expect(state.objectives.find((o) => o.id === "lap")?.status).toBe("done");
  });

  test("drive mode is deterministic for identical input sequences", () => {
    const run = (): string => {
      const engine = createEngine();
      engine.load(driveDoc(), 11);
      for (let i = 0; i < 240; i++) {
        engine.step(FIXED, {
          moveZ: i < 120 ? 1 : -1,
          moveX: i % 60 < 30 ? 1 : -1,
        });
      }
      return JSON.stringify(engine.getState());
    };

    expect(run()).toBe(run());
  });
});
