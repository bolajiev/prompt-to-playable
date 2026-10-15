import { describe, expect, test } from "vitest";
import { createEngine } from "@prompt-to-playable/engine";
import { ARCHETYPE_EXAMPLES } from "../src/generator.js";

describe("kit few-shots are playable in the engine", () => {
  test("inspect: clicking a labeled part opens a panel, recolors it and focuses once", () => {
    const engine = createEngine();
    engine.load(ARCHETYPE_EXAMPLES.inspect);

    engine.pushEvent({ type: "click", targetId: "u1" });
    let state = engine.step(16.666);

    const panel = state.ui.panels.find((item) => item.entity === "u1");
    expect(panel).toBeDefined();
    expect(panel?.title).toContain("U1");
    expect(panel?.body).toContain("GPIO");
    expect(state.entityRuntime.u1?.color).toBe("#4cc9f0");
    expect(state.ui.focus).toBe("u1");

    engine.pushEvent({ type: "click", targetId: "u1" });
    state = engine.step(16.666);
    expect(state.ui.focus).toBe("u1");
    expect(state.ui.panels.filter((item) => item.entity === "u1").length).toBe(2);

    engine.pushEvent({ type: "click", targetId: "reset-pad" });
    state = engine.step(16.666);
    expect(state.ui.panels).toHaveLength(0);
    expect(state.ui.focus).toBeUndefined();
    expect(state.scratch.focused).toBe(0);
  });

  test("inspect: the first click on any labeled part focuses that part", () => {
    for (const id of ["u1", "u2", "u3", "pi1", "d3"]) {
      const engine = createEngine();
      engine.load(ARCHETYPE_EXAMPLES.inspect);

      engine.pushEvent({ type: "click", targetId: id });
      const state = engine.step(16.666);
      expect(state.ui.focus, id).toBe(id);
      expect(state.scratch.focused, id).toBe(1);
      expect(
        state.ui.panels.some((panel) => panel.entity === id),
        `${id} panel`
      ).toBe(true);

      engine.pushEvent({ type: "click", targetId: "reset-pad" });
      const reset = engine.step(16.666);
      expect(reset.ui.focus, id).toBeUndefined();
      expect(reset.scratch.focused, id).toBe(0);
    }
  });

  test("inspect: the heartbeat LED starts pulsing on its own", () => {
    const engine = createEngine();
    engine.load(ARCHETYPE_EXAMPLES.inspect);

    const state = engine.step(16.666);
    expect(state.scratch.heartbeatStarted).toBe(1);
    expect(state.entityRuntime.d3?.animations.some((a) => a.kind === "pulse")).toBe(
      true
    );
  });

  test("walkthrough: interacting with the door slides it open", () => {
    const engine = createEngine();
    engine.load(ARCHETYPE_EXAMPLES.walkthrough);
    const before = engine.getState().entityRuntime["front-door"]?.position ?? [0, 0, 0];

    engine.step(16.666, { interact: true });
    let state = engine.step(16.666, { interact: false });
    for (let i = 0; i < 90; i += 1) state = engine.step(16.666);

    const door = state.entityRuntime["front-door"];
    expect(door?.tags).toContain("open");
    expect(door?.position[0]).toBeGreaterThan(before[0] + 1);
  });

  test("machine: sliders drive joints, the grip toggle flips and WAVE animates", () => {
    const engine = createEngine();
    engine.load(ARCHETYPE_EXAMPLES.machine);

    const slider = ARCHETYPE_EXAMPLES.machine.controls?.find(
      (control) => control.id === "shoulder"
    );
    expect(slider?.bind?.entity).toBe("arm-shoulder");
    const min = slider?.min ?? -1;
    const max = slider?.max ?? 1;
    const scale = slider?.bind?.scale ?? 1;

    let previous = Number.NaN;
    for (const value of [min, min + (max - min) / 2, max]) {
      engine.setControl("shoulder", value);
      const state = engine.step(16.666);
      const rotation = state.entityRuntime["arm-shoulder"]?.rotation?.[2];
      expect(Number.isFinite(rotation)).toBe(true);
      expect(rotation).toBeCloseTo(value * scale, 6);
      if (Number.isFinite(previous)) {
        expect((rotation as number) - previous).toBeGreaterThan(0);
      }
      previous = rotation as number;
    }

    // Forward kinematics: sweeping the shoulder from rest carries the whole
    // downstream chain, so the gripper's world position travels along the arc.
    engine.setControl("shoulder", 0);
    const restGrip = [
      ...(engine.step(16.666).entityRuntime["arm-grip"]?.position ?? [0, 0, 0]),
    ];
    engine.setControl("shoulder", max);
    const sweptGrip = [
      ...(engine.step(16.666).entityRuntime["arm-grip"]?.position ?? [0, 0, 0]),
    ];

    const travel = Math.hypot(
      sweptGrip[0] - restGrip[0],
      sweptGrip[1] - restGrip[1],
      sweptGrip[2] - restGrip[2]
    );
    expect(
      travel,
      "sweeping the shoulder swings the gripper with it (forward kinematics)"
    ).toBeGreaterThan(0.5);

    const closed = engine.getState().entityRuntime["arm-grip"]?.rotation?.[2] ?? 0;
    engine.setControl("grip", 1);
    const opened = engine.step(16.666).entityRuntime["arm-grip"]?.rotation?.[2] ?? 0;
    expect(Math.abs(opened - closed)).toBeGreaterThan(0.1);
    engine.setControl("grip", 0);
    const reclosed =
      engine.step(16.666).entityRuntime["arm-grip"]?.rotation?.[2] ?? 0;
    expect(reclosed).toBeCloseTo(closed, 6);

    engine.pressControl("wave");
    const waved = engine.step(16.666);
    expect(
      waved.entityRuntime["arm-grip"]?.animations.some(
        (animation) => animation.kind === "bob"
      )
    ).toBe(true);
    expect(waved.scratch.waved).toBe(1);

    engine.pressControl("home");
    const homed = engine.step(16.666);
    expect(homed.scratch.homed).toBe(1);
  });

  test("machine: clicking a labeled part frames it and opens its panel", () => {
    const engine = createEngine();
    engine.load(ARCHETYPE_EXAMPLES.machine);

    engine.pushEvent({ type: "click", targetId: "arm-grip" });
    const state = engine.step(16.666);
    expect(state.ui.focus).toBe("arm-grip");
    const panel = state.ui.panels.find((item) => item.entity === "arm-grip");
    expect(panel?.title.length).toBeGreaterThan(0);
    expect(panel?.body.length).toBeGreaterThan(0);
  });

  test("drive: throttle straight down the road wins the race", () => {
    const engine = createEngine();
    engine.load(ARCHETYPE_EXAMPLES.drive);
    let state = engine.getState();

    for (let i = 0; i < 6000 && state.status === "running"; i += 1) {
      state = engine.step(16.666, { moveZ: 1 });
    }

    expect(state.status).toBe("won");
    expect(state.scratch.cp).toBe(4);
    expect(state.scratch.lap).toBe(1);
    const objective = state.objectives.find((item) => item.id === "pass-checkpoints");
    expect(objective?.status).toBe("done");
  });
});
