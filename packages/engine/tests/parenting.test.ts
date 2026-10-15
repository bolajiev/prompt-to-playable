import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { createEngine } from "../src/engine.js";
import { rotateVec } from "../src/parenting.js";
import { createState } from "../src/state.js";
import { tick } from "../src/tick.js";

function docWith(entities: unknown[], controls: unknown[] = []): GameDoc {
  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Rig", archetype: "explore", mode: "machine" },
    world: { bounds: [40, 20, 40] },
    entities,
    objectives: [],
    rules: [],
    controls,
    scratch: {},
  });
  if (!res.ok || !res.data) {
    throw new Error(
      `fixture failed schema validation: ${JSON.stringify(res.error?.issues)}`
    );
  }
  return res.data;
}

const PLAYER = { id: "player", kind: "player", position: [-10, 1, 0] };

describe("rotateVec", () => {
  test("follows the XYZ euler order used by the renderer", () => {
    expect(rotateVec([0, Math.PI / 2, 0], [1, 0, 0])[2]).toBeCloseTo(-1, 6);
    expect(rotateVec([0, 0, Math.PI / 2], [1, 0, 0])[1]).toBeCloseTo(1, 6);
    expect(rotateVec([Math.PI / 2, 0, 0], [0, 1, 0])[2]).toBeCloseTo(1, 6);
    expect(rotateVec([0, 0, 0], [2, -1, 3])).toEqual([2, -1, 3]);
  });
});

describe("entity parenting", () => {
  test("parented child follows parent translation and rotation", () => {
    const doc = docWith([
      PLAYER,
      {
        id: "arm",
        kind: "prop",
        position: [10, 0, 0],
        rotation: [0, Math.PI / 2, 0],
      },
      {
        id: "hand",
        kind: "prop",
        parent: "arm",
        attach: [1, 0, 0],
        position: [0, 0, 0],
      },
    ]);

    const state = createState(doc);
    const hand = state.entityRuntime.hand;
    expect(hand.position[0]).toBeCloseTo(10, 6);
    expect(hand.position[1]).toBeCloseTo(0, 6);
    expect(hand.position[2]).toBeCloseTo(-1, 6);
    expect(hand.rotation?.[1]).toBeCloseTo(Math.PI / 2, 6);
    expect(hand.localPosition).toEqual([0, 0, 0]);
    expect(hand.localRotation).toEqual([0, 0, 0]);
  });

  test("world rotation adds parent and local euler angles per axis", () => {
    const doc = docWith([
      PLAYER,
      {
        id: "arm",
        kind: "prop",
        position: [0, 0, 0],
        rotation: [0.2, Math.PI / 2, -0.1],
      },
      {
        id: "hand",
        kind: "prop",
        parent: "arm",
        attach: [0.5, 0.5, 0],
        position: [0.25, 0, 0],
        rotation: [0, 0, 0.5],
      },
    ]);

    const state = createState(doc);
    const hand = state.entityRuntime.hand;
    expect(hand.rotation?.[0]).toBeCloseTo(0.2, 6);
    expect(hand.rotation?.[1]).toBeCloseTo(Math.PI / 2, 6);
    expect(hand.rotation?.[2]).toBeCloseTo(0.4, 6);

    // World offset is the rotated sum of attach + local position.
    const offset = rotateVec([0.2, Math.PI / 2, -0.1], [0.75, 0.5, 0]);
    expect(hand.position[0]).toBeCloseTo(offset[0], 6);
    expect(hand.position[1]).toBeCloseTo(offset[1], 6);
    expect(hand.position[2]).toBeCloseTo(offset[2], 6);
  });

  test("two-level chain swings the wrist along an arc around the shoulder", () => {
    const doc = docWith(
      [
        PLAYER,
        { id: "base", kind: "prop", position: [0, 0, 0] },
        {
          id: "shoulder",
          kind: "prop",
          parent: "base",
          attach: [0, 2, 0],
          position: [0, 0, 0],
        },
        {
          id: "elbow",
          kind: "prop",
          parent: "shoulder",
          attach: [0, 2, 0],
          position: [0, 0, 0],
        },
        {
          id: "wrist",
          kind: "prop",
          parent: "elbow",
          attach: [2, 0, 0],
          position: [0, 0, 0],
        },
      ],
      [
        {
          id: "shoulder-lift",
          type: "slider",
          label: "Shoulder lift",
          min: -Math.PI,
          max: Math.PI,
          value: 0,
          bind: { entity: "shoulder", property: "rotation.z", scale: 1 },
        },
      ]
    );

    const engine = createEngine();
    engine.load(doc);

    const rest = engine.getState().entityRuntime.wrist.position;
    expect(rest[0]).toBeCloseTo(2, 6);
    expect(rest[1]).toBeCloseTo(4, 6);
    expect(rest[2]).toBeCloseTo(0, 6);

    engine.setControl("shoulder-lift", Math.PI / 4);
    const state = engine.step(16.666);
    const shoulder = state.entityRuntime.shoulder.position;
    const wrist = state.entityRuntime.wrist.position;

    // Hand-computed: the whole arm rotates 45 degrees around the shoulder.
    expect(wrist[0]).toBeCloseTo(0, 6);
    expect(wrist[1]).toBeCloseTo(2 + 2 * Math.SQRT2, 6);
    expect(wrist[2]).toBeCloseTo(0, 6);

    const radiusRest = Math.hypot(rest[0] - shoulder[0], rest[1] - shoulder[1]);
    const radiusNow = Math.hypot(wrist[0] - shoulder[0], wrist[1] - shoulder[1]);
    expect(radiusNow).toBeCloseTo(radiusRest, 6);
    expect(radiusNow).toBeGreaterThan(2.5);

    const travelled = Math.hypot(
      wrist[0] - rest[0],
      wrist[1] - rest[1],
      wrist[2] - rest[2]
    );
    expect(travelled).toBeGreaterThan(0.5);
  });

  test("bindings drive the local pose without double-counting the parent", () => {
    const doc = docWith(
      [
        PLAYER,
        { id: "base", kind: "prop", position: [0, 0, 0] },
        {
          id: "arm",
          kind: "prop",
          parent: "base",
          attach: [1, 0, 0],
          position: [0, 0, 0],
        },
      ],
      [
        {
          id: "yaw",
          type: "slider",
          label: "Base yaw",
          min: -1,
          max: 1,
          value: 0,
          bind: { entity: "base", property: "rotation.y", scale: 1 },
        },
        {
          id: "bend",
          type: "slider",
          label: "Arm bend",
          min: -1,
          max: 1,
          value: 0,
          bind: { entity: "arm", property: "rotation.z", scale: 1 },
        },
      ]
    );

    const engine = createEngine();
    engine.load(doc);
    engine.setControl("yaw", Math.PI / 2);
    engine.setControl("bend", 0.5);
    engine.step(16.666);
    engine.step(16.666);
    const state = engine.getState();
    const arm = state.entityRuntime.arm;

    expect(arm.rotation?.[0]).toBeCloseTo(0, 6);
    expect(arm.rotation?.[1]).toBeCloseTo(Math.PI / 2, 6);
    expect(arm.rotation?.[2]).toBeCloseTo(0.5, 6);
    // The yaw rotates the attach offset: local +x now points at world -z.
    expect(arm.position[0]).toBeCloseTo(0, 6);
    expect(arm.position[2]).toBeCloseTo(-1, 6);
  });

  test("a parent cycle is ignored deterministically; descendants still resolve", () => {
    const doc = docWith([
      PLAYER,
      { id: "a", kind: "prop", parent: "b", position: [5, 0, 0] },
      { id: "b", kind: "prop", parent: "a", position: [1, 1, 0] },
      {
        id: "c",
        kind: "prop",
        parent: "b",
        attach: [1, 0, 0],
        position: [0, 0, 0],
      },
    ]);

    const first = tick(createState(doc), 1 / 60);
    // Cycle members are treated as roots and never rewritten.
    expect(first.entityRuntime.a.position).toEqual([5, 0, 0]);
    expect(first.entityRuntime.b.position).toEqual([1, 1, 0]);
    // c resolves from b's authored pose as if b were a root.
    expect(first.entityRuntime.c.position).toEqual([2, 1, 0]);
    for (const id of ["a", "b", "c"]) {
      expect(first.entityRuntime[id].position.every(Number.isFinite)).toBe(true);
    }

    const second = tick(first, 1 / 60);
    expect(second.entityRuntime.a.position).toEqual([5, 0, 0]);
    expect(second.entityRuntime.b.position).toEqual([1, 1, 0]);
    expect(second.entityRuntime.c.position).toEqual([2, 1, 0]);
  });

  test("resolution is deterministic across engines", () => {
    const entities = [
      PLAYER,
      { id: "base", kind: "prop", position: [1, 0, 0] },
      {
        id: "shoulder",
        kind: "prop",
        parent: "base",
        attach: [0, 2, 0],
        position: [0, 0, 0],
      },
      {
        id: "wrist",
        kind: "prop",
        parent: "shoulder",
        attach: [2, 0, 0],
        position: [0, 0, 0],
      },
    ];
    const controls = [
      {
        id: "yaw",
        type: "slider",
        label: "Yaw",
        min: -1,
        max: 1,
        value: 0,
        bind: { entity: "base", property: "rotation.y", scale: 1 },
      },
      {
        id: "lift",
        type: "slider",
        label: "Lift",
        min: -1,
        max: 1,
        value: 0,
        bind: { entity: "shoulder", property: "rotation.z", scale: 1 },
      },
    ];

    const left = createEngine();
    const right = createEngine();
    left.load(docWith(entities, controls));
    right.load(docWith(entities, controls));

    for (let step = 0; step < 12; step += 1) {
      const value = Math.sin(step / 3);
      left.setControl("yaw", value);
      right.setControl("yaw", value);
      left.setControl("lift", Math.cos(step / 4));
      right.setControl("lift", Math.cos(step / 4));
      const a = left.step(16.666);
      const b = right.step(16.666);
      expect(JSON.stringify(a.entityRuntime)).toEqual(
        JSON.stringify(b.entityRuntime)
      );
    }
  });

  test("animations drive a parented entity's local pose", () => {
    const doc = docWith(
      [
        PLAYER,
        { id: "base", kind: "prop", position: [0, 0, 0] },
        {
          id: "grip",
          kind: "prop",
          parent: "base",
          attach: [0, 1, 0],
          position: [0, 0, 0],
        },
      ],
      [
        {
          id: "home",
          type: "button",
          label: "HOME",
          bind: {
            onPress: [
              {
                type: "animate",
                entity: "grip",
                kind: "slide",
                to: [0, 2, 0],
                duration: 100,
              },
            ],
          },
        },
      ]
    );

    const engine = createEngine();
    engine.load(doc);
    engine.pressControl("home");
    let state = engine.getState();
    for (let i = 0; i < 12; i += 1) state = engine.step(16.666);

    const grip = state.entityRuntime.grip;
    expect(grip.localPosition?.[1]).toBeCloseTo(2, 6);
    expect(grip.position[1]).toBeCloseTo(3, 6);
    expect(grip.position[0]).toBeCloseTo(0, 6);
  });

  test("unparented documents keep their previous runtime shape", () => {
    const doc = docWith([
      PLAYER,
      {
        id: "crate",
        kind: "prop",
        position: [3, 1, 0],
        rotation: [0, 0, 0.4],
      },
    ]);

    const state = createState(doc);
    const crate = state.entityRuntime.crate;
    expect("localPosition" in crate).toBe(false);
    expect("localRotation" in crate).toBe(false);
    expect(crate.position).toEqual([3, 1, 0]);
    expect(crate.rotation).toEqual([0, 0, 0.4]);

    const after = tick(state, 1 / 60);
    expect(after.entityRuntime.crate.position).toEqual([3, 1, 0]);
    expect("localPosition" in after.entityRuntime.crate).toBe(false);
  });

  test("an unknown parent id leaves the entity at its authored pose", () => {
    const doc = docWith([
      PLAYER,
      {
        id: "orphan",
        kind: "prop",
        parent: "ghost",
        attach: [1, 0, 0],
        position: [2, 1, 0],
      },
    ]);

    const state = tick(createState(doc), 1 / 60);
    expect(state.entityRuntime.orphan.position).toEqual([2, 1, 0]);
  });
});
