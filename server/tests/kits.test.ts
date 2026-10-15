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
