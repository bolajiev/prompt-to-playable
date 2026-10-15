import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { controlColor } from "../src/controls.js";
import { createEngine, Engine } from "../src/engine.js";
import { NEUTRAL_INPUT } from "../src/input.js";
import { createState } from "../src/state.js";
import { tick } from "../src/tick.js";

function parseDoc(input: unknown): GameDoc {
  const res = validateGame(input);
  if (!res.ok || !res.data) {
    throw new Error(`controls doc failed schema validation: ${res.error}`);
  }
  return res.data;
}

function machineDoc(): GameDoc {
  return parseDoc({
    version: "1.0.0",
    meta: { title: "Desk Arm", archetype: "explore", mode: "machine", seed: 5 },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [8, 1, 8] },
      { id: "link", kind: "prop", position: [0, 2, 0], rotation: [0.1, 0, 0] },
    ],
    objectives: [],
    rules: [
      {
        id: "wave-count",
        on: { event: "controlPressed", entity: "wave" },
        then: [{ type: "incVar", key: "waved", by: 1 }],
      },
      {
        id: "power-gate",
        on: { event: "tick" },
        if: { op: ">", left: { var: "power" }, right: 0.4 },
        then: [{ type: "setVar", key: "powered", value: true }],
      },
    ],
    controls: [
      {
        id: "swing",
        type: "slider",
        label: "Swing",
        min: -1,
        max: 1,
        value: 0.25,
        bind: { entity: "link", property: "rotation.z", scale: 1.2, offset: 0.5 },
      },
      {
        id: "lift",
        type: "slider",
        label: "Lift",
        value: 0,
        bind: { entity: "link", property: "position.y", scale: 2, offset: 1 },
      },
      {
        id: "show",
        type: "toggle",
        label: "Show",
        value: 1,
        bind: { entity: "link", property: "visible" },
      },
      {
        id: "power",
        type: "slider",
        label: "Power",
        value: 0.5,
        bind: { var: "power" },
      },
      {
        id: "glow",
        type: "slider",
        label: "Glow",
        value: 1,
        bind: { entity: "link", property: "emissive", scale: 0.5 },
      },
      {
        id: "hue",
        type: "slider",
        label: "Hue",
        value: 120,
        bind: { entity: "link", property: "color" },
      },
      {
        id: "home",
        type: "button",
        label: "HOME",
        bind: {
          entity: "link",
          property: "rotation.x",
          onPress: [{ type: "setVar", key: "homed", value: true }],
        },
      },
      { id: "wave", type: "button", label: "WAVE", bind: {} },
    ],
    scratch: {},
  });
}

function legacyDoc(withControls = false): GameDoc {
  const doc: Record<string, unknown> = {
    version: "1.0.0",
    meta: { title: "Legacy", archetype: "collect-a-thon", seed: 9 },
    world: { bounds: [20, 10, 20] },
    entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
    objectives: [],
    rules: [],
    scratch: {},
  };
  if (withControls) doc.controls = [];
  return parseDoc(doc);
}

describe("control defaults and APIs", () => {
  test("ui.controls initializes from control.value ?? 0", () => {
    const state = createState(machineDoc(), 1);
    expect(state.ui.controls).toEqual({
      swing: 0.25,
      lift: 0,
      show: 1,
      power: 0.5,
      glow: 1,
      hue: 120,
      home: 0,
      wave: 0,
    });
  });

  test("a tick never mutates a previous state snapshot", () => {
    const state = createState(machineDoc(), 1);
    const snapshot = JSON.stringify(state.ui.controls);
    const next = tick(state, 1 / 60);
    expect(JSON.stringify(state.ui.controls)).toBe(snapshot);
    expect(next.ui.controls.swing).toBe(0.25);
  });

  test("setControl updates the live value and ignores unknown ids/bad values", () => {
    const engine = createEngine();
    expect(() => engine.setControl("swing", 1)).not.toThrow();

    engine.load(machineDoc());
    engine.setControl("swing", 0.9);
    expect(engine.getState().ui.controls.swing).toBe(0.9);

    engine.setControl("missing", 1);
    engine.setControl("swing", Number.NaN);
    expect(engine.getState().ui.controls.swing).toBe(0.9);
    expect(engine.getState().ui.controls.missing).toBeUndefined();
  });

  test("pressControl ignores unknown ids and requires a load", () => {
    const engine = new Engine();
    expect(() => engine.pressControl("wave")).not.toThrow();

    engine.load(machineDoc());
    engine.pressControl("missing");
    expect(engine.getState().ui.controls.wave).toBe(0);
  });
});

describe("control bindings", () => {
  test("slider drives rotation from the authored base without accumulating", () => {
    const engine = createEngine();
    engine.load(machineDoc());
    let state = engine.step(16.666);

    // base.z = 0, value 0.25 -> 0.25 * 1.2 + 0.5 = 0.8; other axes kept.
    expect(state.entityRuntime.link.rotation?.[0]).toBeCloseTo(0.1, 10);
    expect(state.entityRuntime.link.rotation?.[2]).toBeCloseTo(0.8, 10);

    state = engine.step(16.666);
    expect(state.entityRuntime.link.rotation?.[2]).toBeCloseTo(0.8, 10);

    engine.setControl("swing", 0.75);
    state = engine.step(16.666);
    expect(state.entityRuntime.link.rotation?.[2]).toBeCloseTo(1.4, 10);

    // Changing the value never folds the driven rotation back into the base.
    state = engine.step(16.666);
    expect(state.entityRuntime.link.rotation?.[2]).toBeCloseTo(1.4, 10);
  });

  test("slider drives position on the bound axis and keeps the others", () => {
    const engine = createEngine();
    engine.load(machineDoc());
    let state = engine.step(16.666);
    // base.y = 2, value 0 -> 2 + 0 * 2 + 1 = 3
    expect(state.entityRuntime.link.position).toEqual([0, 3, 0]);

    engine.setControl("lift", 1);
    state = engine.step(16.666);
    expect(state.entityRuntime.link.position).toEqual([0, 5, 0]);
  });

  test("toggle drives visible with the value > 0.5 threshold", () => {
    const engine = createEngine();
    engine.load(machineDoc());
    let state = engine.step(16.666);
    expect(state.entityRuntime.link.visible).toBe(true);

    engine.setControl("show", 0.5);
    state = engine.step(16.666);
    expect(state.entityRuntime.link.visible).toBe(false);

    engine.setControl("show", 1);
    state = engine.step(16.666);
    expect(state.entityRuntime.link.visible).toBe(true);
  });

  test("bind.var mirrors the live value into scratch and rules can read it", () => {
    const engine = createEngine();
    engine.load(machineDoc());
    let state = engine.step(16.666);

    expect(state.scratch.power).toBe(0.5);
    expect(state.scratch.powered).toBe(true);

    engine.setControl("power", 0.2);
    state = engine.step(16.666);
    expect(state.scratch.power).toBe(0.2);
    // The tick rule already latched; scratch keeps the latest live value.
    expect(state.scratch.powered).toBe(true);
  });

  test("binding math survives a reload of the same document", () => {
    const engine = createEngine();
    const doc = machineDoc();
    engine.load(doc);
    engine.setControl("swing", 1);
    let state = engine.step(16.666);
    expect(state.entityRuntime.link.rotation?.[2]).toBeCloseTo(1.7, 10);

    engine.load(doc);
    state = engine.step(16.666);
    expect(state.ui.controls.swing).toBe(0.25);
    expect(state.entityRuntime.link.rotation?.[2]).toBeCloseTo(0.8, 10);
  });
});

describe("control color and emissive bindings", () => {
  test("color maps the scaled value to a deterministic hue", () => {
    const engine = createEngine();
    engine.load(machineDoc());
    let state = engine.step(16.666);
    expect(state.entityRuntime.link.color).toBe(controlColor(120));
    expect(controlColor(-30)).toBe("hsl(330 85% 60%)");

    engine.setControl("hue", 0);
    state = engine.step(16.666);
    expect(state.entityRuntime.link.color).toBe("hsl(0 85% 60%)");
  });

  test("emissive writes a non-negative numeric factor", () => {
    const engine = createEngine();
    engine.load(machineDoc());
    let state = engine.step(16.666);
    expect(state.entityRuntime.link.emissive).toBeCloseTo(0.5, 10);

    engine.setControl("glow", -2);
    state = engine.step(16.666);
    expect(state.entityRuntime.link.emissive).toBe(0);
  });
});

describe("buttons", () => {
  test("pressControl emits controlPressed, runs onPress actions, pulses to 0", () => {
    const engine = createEngine();
    engine.load(machineDoc());

    engine.pressControl("home");
    expect(engine.getState().ui.controls.home).toBe(1);

    const state = engine.step(16.666);
    expect(
      state.events.some(
        (event) => event.type === "controlPressed" && event.controlId === "home"
      )
    ).toBe(true);
    expect(state.scratch.homed).toBe(true);
    expect(state.ui.controls.home).toBe(0);
    // Button property binds are ignored: the authored rotation is untouched.
    expect(state.entityRuntime.link.rotation?.[0]).toBeCloseTo(0.1, 10);

    // The next tick does not re-run the press.
    const next = engine.step(16.666);
    expect(
      next.events.some((event) => event.type === "controlPressed")
    ).toBe(false);
  });

  test("doc rules react to controlPressed through trigger.entity (controlId)", () => {
    const engine = createEngine();
    engine.load(machineDoc());
    engine.pressControl("wave");
    engine.pressControl("wave");
    const state = engine.step(16.666);

    expect(state.scratch.waved).toBe(2);
    expect(state.ui.controls.wave).toBe(0);
  });

  test("tick() accepts controlPressed events directly and runs onPress", () => {
    const state = createState(machineDoc(), 1);
    const next = tick(state, 1 / 60, NEUTRAL_INPUT, [
      { type: "controlPressed", controlId: "home" },
    ]);
    expect(next.scratch.homed).toBe(true);
    expect(
      next.events.filter((event) => event.type === "controlPressed")
    ).toHaveLength(1);
  });

  test("sliders are not pulsed by presses (only buttons reset)", () => {
    const engine = createEngine();
    engine.load(machineDoc());
    engine.pressControl("swing");
    const state = engine.step(16.666);
    expect(state.ui.controls.swing).toBe(1);
  });
});

describe("determinism and backward compatibility", () => {
  test("identical control input sequences produce identical states", () => {
    const run = () => {
      const engine = createEngine();
      engine.load(machineDoc());
      engine.setControl("swing", 0.9);
      engine.step(16.666);
      engine.pressControl("home");
      engine.setControl("lift", 0.4);
      engine.step(33.333);
      engine.pressControl("wave");
      engine.step(16.666);
      return engine.getState();
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  test("docs without controls are unchanged and report no controls", () => {
    const state = createState(legacyDoc(), 7);
    expect(state.ui.controls).toEqual({});
    expect(state.controlBases.player).toEqual({
      position: [0, 1, 0],
      rotation: [0, 0, 0],
    });

    const withoutField: GameDoc = legacyDoc();
    const withEmpty: GameDoc = legacyDoc(true);
    let a = createState(withoutField, 3);
    let b = createState(withEmpty, 3);
    for (let i = 0; i < 30; i++) {
      a = tick(a, 1 / 60, { moveX: 1 });
      b = tick(b, 1 / 60, { moveX: 1 });
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("load() resets live values, bases and queued presses", () => {
    const engine = createEngine();
    const doc = machineDoc();
    engine.load(doc);
    engine.setControl("swing", 1);
    engine.step(16.666);
    engine.pressControl("home");

    engine.load(doc);
    const state = engine.getState();
    expect(state.ui.controls.swing).toBe(0.25);
    expect(state.controlBases.link.rotation).toEqual([0.1, 0, 0]);

    const after = engine.step(16.666);
    expect(after.events.some((event) => event.type === "controlPressed")).toBe(
      false
    );
    expect(after.scratch.homed).toBeUndefined();
  });
});
