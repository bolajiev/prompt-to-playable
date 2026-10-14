import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc, type Vec3 } from "@prompt-to-playable/schema";
import { createEngine } from "../src/engine.js";
import { NEUTRAL_INPUT } from "../src/input.js";
import { createEntityRuntime, createState } from "../src/state.js";
import { tick } from "../src/tick.js";

function parseDoc(input: unknown): GameDoc {
  const res = validateGame(input);
  if (!res.ok || !res.data) {
    throw new Error("actions doc failed schema validation");
  }
  return res.data;
}

function panelDoc(): GameDoc {
  return parseDoc({
    version: "1.0.0",
    meta: { title: "Panel Room", archetype: "collect-a-thon", seed: 2 },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "crystal", kind: "interactable", position: [2, 1, 0] },
      { id: "lever", kind: "interactable", position: [-2, 1, 0] },
      { id: "bell", kind: "interactable", position: [0, 1, 2] },
    ],
    objectives: [],
    rules: [
      {
        id: "crystal-panel",
        on: { event: "click", entity: "crystal" },
        then: [
          {
            type: "showPanel",
            title: "Crystal",
            body: "Sparkly.",
            entity: "crystal",
          },
          { type: "cameraFocus", entity: "crystal" },
        ],
      },
      {
        id: "lever-panel",
        on: { event: "click", entity: "lever" },
        then: [{ type: "showPanel", title: "Lever", body: "Pull me." }],
      },
      {
        id: "bell",
        on: { event: "click", entity: "bell" },
        then: [
          { type: "hidePanel", entity: "crystal" },
          { type: "setVisible", entity: "bell", visible: false },
          { type: "setColor", entity: "bell", color: "#123456" },
        ],
      },
      {
        id: "hide-all",
        on: { event: "hoverLeave", entity: "crystal" },
        then: [{ type: "hidePanel" }],
      },
    ],
    scratch: {},
  });
}

describe("v5 actions", () => {
  test("spawn initializes the full runtime record via createEntityRuntime", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Spawn Room", archetype: "collect-a-thon" },
      world: { bounds: [20, 10, 20] },
      entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
      objectives: [],
      rules: [
        {
          id: "spawn-ghost",
          on: { event: "tick" },
          then: [
            {
              type: "spawn",
              entity: {
                id: "ghost",
                kind: "prop",
                position: [3, 2, 0],
                tags: ["spooky"],
              },
            },
          ],
        },
      ],
      scratch: {},
    });

    const state = createState(doc, 1);
    const next = tick(state, 1 / 60);
    const ghost = next.entityRuntime.ghost;

    expect(ghost).toBeDefined();
    expect(ghost.position).toEqual([3, 2, 0]);
    expect(ghost.velocity).toEqual([0, 0, 0]);
    expect(ghost.grounded).toBe(false);
    expect(ghost.active).toBe(true);
    expect(ghost.tags).toEqual(["spooky"]);
    expect(ghost.visible).toBe(true);
    expect(ghost.animations).toEqual([]);
    expect(ghost.color).toBeUndefined();
    expect(ghost.speed).toBeUndefined();
    expect(ghost.heading).toBeUndefined();
    expect(next.entities.some((e) => e.id === "ghost")).toBe(true);
  });

  test("createEntityRuntime returns fresh, independent arrays", () => {
    const doc = panelDoc();
    const entity = doc.entities.find((e) => e.id === "crystal");
    expect(entity).toBeDefined();

    const first = createEntityRuntime(entity!);
    const second = createEntityRuntime(entity!);
    first.animations.push({
      kind: "pulse",
      elapsed: 0,
      basePos: [0, 0, 0],
      baseRot: [0, 0, 0],
    });
    first.tags.push("mutated");

    expect(second.animations).toEqual([]);
    expect(second.tags).toEqual([]);
    expect(first.visible).toBe(true);
  });

  test("tick accepts external events directly (fourth argument)", () => {
    const state = createState(panelDoc(), 1);
    const next = tick(state, 1 / 60, NEUTRAL_INPUT, [
      { type: "click", targetId: "crystal" },
    ]);

    expect(next.ui.panels).toHaveLength(1);
    expect(next.ui.panels[0].id).toBe("crystal-0");
    expect(next.ui.focus).toBe("crystal");
  });

  test("cameraFocus sets state.ui.focus without touching entities", () => {
    const engine = createEngine();
    engine.load(panelDoc(), 1);
    engine.pushEvent({ type: "click", targetId: "crystal" });
    const state = engine.step(16.666);

    expect(state.ui.focus).toBe("crystal");
    expect(state.entityRuntime.crystal.active).toBe(true);
    expect(state.entityRuntime.crystal.position).toEqual([2, 1, 0]);

    engine.closePanel("crystal-0");
    const closed = engine.getState();
    expect(closed.ui.panels).toHaveLength(0);
    expect(closed.ui.focus).toBe("crystal");
  });

  test("cameraFocus with no entity clears state.ui.focus", () => {
    const doc = parseDoc({
      version: "1.0.0",
      meta: { title: "Focus Room", archetype: "collect-a-thon", seed: 4 },
      world: { bounds: [20, 10, 20] },
      entities: [
        { id: "player", kind: "player", position: [0, 1, 0] },
        { id: "crystal", kind: "interactable", position: [2, 1, 0] },
        { id: "lever", kind: "interactable", position: [-2, 1, 0] },
      ],
      objectives: [],
      rules: [
        {
          id: "focus",
          on: { event: "click", entity: "crystal" },
          then: [{ type: "cameraFocus", entity: "crystal" }],
        },
        {
          id: "clear",
          on: { event: "click", entity: "lever" },
          then: [{ type: "cameraFocus" }],
        },
      ],
      scratch: {},
    });
    const engine = createEngine();
    engine.load(doc, 1);

    engine.pushEvent({ type: "click", targetId: "crystal" });
    let state = engine.step(16.666);
    expect(state.ui.focus).toBe("crystal");

    engine.pushEvent({ type: "click", targetId: "lever" });
    state = engine.step(16.666);
    expect(state.ui.focus).toBeUndefined();
    expect("focus" in state.ui).toBe(false);

    engine.pushEvent({ type: "click", targetId: "crystal" });
    state = engine.step(16.666);
    expect(state.ui.focus).toBe("crystal");
  });

  test("showPanel without entity uses a deterministic panel-<n> id", () => {
    const engine = createEngine();
    engine.load(panelDoc(), 1);

    engine.pushEvent({ type: "click", targetId: "lever" });
    engine.pushEvent({ type: "click", targetId: "lever" });
    const state = engine.step(16.666);

    expect(state.ui.panels.map((p) => p.id)).toEqual(["panel-0", "panel-1"]);
    expect(state.ui.panels.every((p) => p.entity === undefined)).toBe(true);
  });

  test("hidePanel drops by entity or all, keeping the id counter", () => {
    const engine = createEngine();
    engine.load(panelDoc(), 1);

    engine.pushEvent({ type: "click", targetId: "crystal" });
    engine.pushEvent({ type: "click", targetId: "lever" });
    engine.step(16.666);
    expect(engine.getState().ui.panels).toHaveLength(2);

    engine.pushEvent({ type: "click", targetId: "bell" });
    const byEntity = engine.step(16.666);
    expect(byEntity.ui.panels.map((p) => p.id)).toEqual(["panel-1"]);
    expect(byEntity.entityRuntime.bell.visible).toBe(false);
    expect(byEntity.entityRuntime.bell.color).toBe("#123456");

    engine.pushEvent({ type: "hoverLeave", targetId: "crystal" });
    const all = engine.step(16.666);
    expect(all.ui.panels).toHaveLength(0);
    expect(all.ui.nextPanelId).toBe(2);
  });
});

describe("backward compatibility (docs without new fields)", () => {
  function legacyDoc(): GameDoc {
    return parseDoc({
      version: "1.0.0",
      meta: { title: "Legacy Room", archetype: "collect-a-thon", seed: 3 },
      world: { bounds: [20, 10, 20], terrain: { type: "flat", obstacles: [] } },
      entities: [
        { id: "player", kind: "player", position: [0, 5, 0] },
        { id: "crystal", kind: "collectible", position: [2, 1, 0] },
        { id: "crystal-zone", kind: "zone", position: [2, 1, 0], size: [3, 3, 3] },
      ],
      objectives: [{ id: "crystals", type: "collect", count: 1 }],
      rules: [
        {
          id: "pickup",
          on: { event: "playerEnter", zone: "crystal-zone" },
          then: [
            { type: "despawn", entity: "crystal" },
            { type: "objectiveProgress", objective: "crystals", by: 1 },
          ],
        },
      ],
      scratch: {},
    });
  }

  test("movement, zones and objectives behave exactly as before", () => {
    let state = createState(legacyDoc(), 7);
    for (let i = 0; i < 120; i++) state = tick(state, 1 / 60);

    expect(state.entityRuntime.player.position[1]).toBeCloseTo(0.9, 6);
    expect(state.entityRuntime.player.grounded).toBe(true);

    for (let i = 0; i < 60; i++) state = tick(state, 1 / 60, { moveZ: 1 });
    const position = state.entityRuntime.player.position as Vec3;
    const dz = position[2];
    expect(dz).toBeGreaterThanOrEqual(5.5);
    expect(dz).toBeLessThanOrEqual(6.5);
  });

  test("zone pickup still fires once and completes the objective", () => {
    let state = createState(legacyDoc(), 7);
    let enters = 0;
    for (let i = 0; i < 40; i++) {
      state = tick(state, 1 / 60, { moveX: 1 });
      enters += state.events.filter((e) => e.type === "playerEnter").length;
    }

    expect(enters).toBe(1);
    expect(state.objectives.find((o) => o.id === "crystals")?.status).toBe("done");
    expect(state.entities.some((e) => e.id === "crystal")).toBe(false);
  });

  test("new runtime/ui fields default cleanly on legacy docs", () => {
    const state = createState(legacyDoc(), 7);
    expect(state.ui).toEqual({ panels: [], nextPanelId: 0 });
    for (const runtime of Object.values(state.entityRuntime)) {
      expect(runtime.visible).toBe(true);
      expect(runtime.animations).toEqual([]);
      expect(runtime.color).toBeUndefined();
      expect(runtime.speed).toBeUndefined();
      expect(runtime.heading).toBeUndefined();
    }
  });
});
