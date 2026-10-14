import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import { createEngine } from "../src/engine.js";

function parseDoc(input: unknown): GameDoc {
  const res = validateGame(input);
  if (!res.ok || !res.data) {
    throw new Error("events doc failed schema validation");
  }
  return res.data;
}

function clickDoc(): GameDoc {
  return parseDoc({
    version: "1.0.0",
    meta: { title: "Interactive Panel", archetype: "collect-a-thon", seed: 5 },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "crystal", kind: "interactable", position: [2, 1, 0] },
      { id: "lever", kind: "interactable", position: [-2, 1, 0] },
    ],
    objectives: [],
    rules: [
      {
        id: "click-crystal",
        on: { event: "click", entity: "crystal" },
        then: [
          {
            type: "showPanel",
            title: "Crystal",
            body: "It hums softly.",
            entity: "crystal",
          },
          { type: "setColor", entity: "crystal", color: "#ff00ff" },
          { type: "setVisible", entity: "crystal", visible: false },
        ],
      },
      {
        id: "click-lever",
        on: { event: "click", entity: "lever" },
        then: [
          {
            type: "showPanel",
            title: "Lever",
            body: "Ancient iron.",
            entity: "lever",
          },
        ],
      },
      {
        id: "hover-crystal",
        on: { event: "hoverEnter", entity: "crystal" },
        then: [{ type: "setColor", entity: "crystal", color: "#00ffff" }],
      },
      {
        id: "leave-crystal",
        on: { event: "hoverLeave", entity: "crystal" },
        then: [{ type: "hidePanel", entity: "crystal" }],
      },
    ],
    scratch: {},
  });
}

describe("external events", () => {
  test("queued click fires click rules on the next tick and is consumed once", () => {
    const engine = createEngine();
    engine.load(clickDoc(), 5);

    engine.pushEvent({ type: "click", targetId: "crystal" });
    const first = engine.step(16.666);

    expect(first.ticks).toBe(1);
    expect(first.ui.panels).toHaveLength(1);
    expect(first.ui.panels[0]).toEqual({
      id: "crystal-0",
      title: "Crystal",
      body: "It hums softly.",
      entity: "crystal",
    });
    expect(first.entityRuntime.crystal.color).toBe("#ff00ff");
    expect(first.entityRuntime.crystal.visible).toBe(false);
    expect(
      first.events.some((e) => e.type === "click" && e.targetId === "crystal")
    ).toBe(true);

    const second = engine.step(16.666);
    expect(second.ticks).toBe(2);
    expect(second.ui.panels).toHaveLength(1);
    expect(second.events.some((e) => e.type === "click")).toBe(false);
  });

  test("a click on a different entity does not match trigger.entity", () => {
    const engine = createEngine();
    engine.load(clickDoc(), 5);

    engine.pushEvent({ type: "click", targetId: "player" });
    const state = engine.step(16.666);

    expect(state.ui.panels).toHaveLength(0);
    expect(state.entityRuntime.crystal.color).toBeUndefined();
    expect(state.entityRuntime.crystal.visible).toBe(true);
  });

  test("hoverEnter and hoverLeave match the hovered entity id", () => {
    const engine = createEngine();
    engine.load(clickDoc(), 5);

    engine.pushEvent({ type: "click", targetId: "crystal" });
    engine.step(16.666);

    engine.pushEvent({ type: "hoverEnter", targetId: "crystal" });
    const hovered = engine.step(16.666);
    expect(hovered.entityRuntime.crystal.color).toBe("#00ffff");

    engine.pushEvent({ type: "hoverLeave", targetId: "crystal" });
    const left = engine.step(16.666);
    expect(left.ui.panels).toHaveLength(0);
    expect(
      left.events.some((e) => e.type === "hoverLeave" && e.targetId === "crystal")
    ).toBe(true);
  });

  test("events stay queued until a tick actually runs", () => {
    const engine = createEngine();
    engine.load(clickDoc(), 5);

    engine.pushEvent({ type: "click", targetId: "crystal" });
    const idle = engine.step(5);
    expect(idle.ticks).toBe(0);
    expect(idle.ui.panels).toHaveLength(0);

    const ticked = engine.step(12);
    expect(ticked.ticks).toBe(1);
    expect(ticked.ui.panels).toHaveLength(1);
  });

  test("multiple queued clicks produce panels in queue order", () => {
    const engine = createEngine();
    engine.load(clickDoc(), 5);

    engine.pushEvent({ type: "click", targetId: "crystal" });
    engine.pushEvent({ type: "click", targetId: "lever" });
    engine.pushEvent({ type: "click", targetId: "crystal" });
    const state = engine.step(16.666);

    expect(state.ui.panels.map((p) => p.id)).toEqual([
      "crystal-0",
      "lever-1",
      "crystal-2",
    ]);
    expect(state.ui.nextPanelId).toBe(3);
  });

  test("closePanel removes one panel by id and ignores unknown ids", () => {
    const engine = createEngine();
    engine.load(clickDoc(), 5);

    engine.pushEvent({ type: "click", targetId: "crystal" });
    engine.pushEvent({ type: "click", targetId: "lever" });
    engine.step(16.666);

    engine.closePanel("crystal-0");
    expect(engine.getState().ui.panels.map((p) => p.id)).toEqual(["lever-1"]);

    engine.closePanel("crystal-0");
    engine.closePanel("does-not-exist");
    expect(engine.getState().ui.panels.map((p) => p.id)).toEqual(["lever-1"]);

    engine.closePanel("lever-1");
    expect(engine.getState().ui.panels).toHaveLength(0);
    expect(engine.getState().ui.nextPanelId).toBe(2);
  });

  test("panel ids are deterministic and monotonic across runs", () => {
    const run = (): string => {
      const engine = createEngine();
      engine.load(clickDoc(), 99);
      for (let i = 0; i < 12; i++) {
        engine.pushEvent({ type: "click", targetId: i % 2 === 0 ? "crystal" : "lever" });
        engine.step(16.666);
        if (i === 5) {
          engine.pushEvent({ type: "hoverEnter", targetId: "crystal" });
          engine.step(16.666);
        }
      }
      return JSON.stringify(engine.getState());
    };

    const first = run();
    const second = run();
    expect(first).toBe(second);

    const state = JSON.parse(first) as {
      ui: { panels: { id: string }[] };
    };
    const ids = state.ui.panels.map((p) => p.id);
    expect(ids).toEqual([
      "crystal-0",
      "lever-1",
      "crystal-2",
      "lever-3",
      "crystal-4",
      "lever-5",
      "crystal-6",
      "lever-7",
      "crystal-8",
      "lever-9",
      "crystal-10",
      "lever-11",
    ]);
  });
});
