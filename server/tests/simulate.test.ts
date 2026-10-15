import { describe, expect, test } from "vitest";
import { createEngine } from "@prompt-to-playable/engine";
import type { GameDoc, Vec3 } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import {
  SIMULATE_TICK_BUDGET,
  nonFiniteRuntime,
  simulateDoc,
} from "../src/simulate.js";

function mustDoc(raw: unknown): GameDoc {
  const res = validateGame(raw);
  if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
  return res.data;
}

function collectDoc(): GameDoc {
  return mustDoc({
    version: "1.0.0",
    meta: { title: "Sim Collect", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [-10, 1, 0] },
      { id: "gem", kind: "collectible", position: [6, 1, 4] },
      { id: "gem-zone", kind: "zone", position: [6, 1, 4], size: [3, 2, 3] },
    ],
    objectives: [
      { id: "collect-gem", type: "collect", targets: ["gem"], count: 1 },
    ],
    rules: [
      {
        id: "pickup",
        on: { event: "playerEnter", zone: "gem-zone" },
        then: [{ type: "objectiveProgress", objective: "collect-gem", by: 1 }],
      },
      {
        id: "win",
        on: { event: "objectiveComplete", objective: "collect-gem" },
        then: [{ type: "win" }],
      },
    ],
    scratch: {},
  });
}

function machineDoc(): GameDoc {
  return mustDoc({
    version: "1.0.0",
    meta: { title: "Sim Arm", archetype: "explore", mode: "machine" },
    world: { bounds: [16, 10, 16], lighting: "indoor" },
    entities: [
      { id: "player", kind: "player", position: [-10, 1, 0] },
      { id: "base", kind: "prop", position: [0, 1, 0] },
      {
        id: "arm",
        kind: "prop",
        parent: "base",
        attach: [0, 1, 0],
        position: [0, 0, 0],
      },
      {
        id: "jaw",
        kind: "prop",
        parent: "arm",
        attach: [1, 0, 0],
        position: [0, 0, 0],
      },
    ],
    objectives: [],
    rules: [],
    controls: [
      {
        id: "lift",
        type: "slider",
        label: "Lift",
        min: -1,
        max: 1,
        value: 0,
        bind: { entity: "arm", property: "rotation.z", scale: 1.2 },
      },
      {
        id: "grip",
        type: "toggle",
        label: "Grip",
        value: 0,
        bind: { entity: "jaw", property: "visible" },
      },
      {
        id: "home",
        type: "button",
        label: "Home",
        bind: {
          onPress: [
            {
              type: "animate",
              entity: "arm",
              kind: "slide",
              to: [0, 0, 0],
              duration: 100,
            },
          ],
        },
      },
    ],
    scratch: {},
  });
}

describe("simulateDoc — game", () => {
  test("a scripted pursuit wins the collect objective and reports the tick count", () => {
    const result = simulateDoc(collectDoc());

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    const win = result.checks.find((check) => check.name === "win-path");
    expect(win?.ok).toBe(true);
    expect(win?.detail).toMatch(/^won at tick \d+$/);
    const ticks = Number(/(\d+)/.exec(win?.detail ?? "")?.[1]);
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThanOrEqual(SIMULATE_TICK_BUDGET);
    const stability = result.checks.find((check) => check.name === "ticks");
    expect(stability?.detail).toContain("no NaN");
  });

  test("fails when a reached target never completes its objective (count exceeds targets)", () => {
    const doc = collectDoc();
    const objective = doc.objectives[0];
    if (!objective) throw new Error("fixture has no objective");
    doc.objectives = [{ ...objective, count: 2 }];

    const result = simulateDoc(doc);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("game did not finish");
    expect(result.failures.join("\n")).toContain("collect-gem 1/2");
    const win = result.checks.find((check) => check.name === "win-path");
    expect(win?.ok).toBe(false);
  });

  test("a pursuit the scripted bot cannot finish is reported, not failed (platformer limit)", () => {
    const doc = collectDoc();
    doc.world.terrain.obstacles = [{ position: [6, 1.5, 4], size: [4, 3, 4] }];

    const result = simulateDoc(doc);

    const win = result.checks.find((check) => check.name === "win-path");
    expect(win?.ok, win?.detail).toBe(true);
    expect(win?.detail).toContain("pursuit stalled at gem");
    expect(win?.detail).toContain("win not confirmed");
  });

  test("accepts an explicit lose path the pursuit triggers", () => {
    const doc = collectDoc();
    doc.rules = [
      {
        id: "trap",
        on: { event: "playerEnter", zone: "gem-zone" },
        then: [{ type: "lose", message: "Trapped!" }],
      },
      {
        id: "win",
        on: { event: "objectiveComplete", objective: "collect-gem" },
        then: [{ type: "win" }],
      },
    ];

    const result = simulateDoc(doc);

    expect(result.ok).toBe(true);
    const win = result.checks.find((check) => check.name === "win-path");
    expect(win?.detail).toContain("explicit lose path honored");
  });
});

describe("simulateDoc — machine", () => {
  test("slider sweeps, toggle flips and button presses all pass on a healthy arm", () => {
    const result = simulateDoc(machineDoc());

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    const names = result.checks.map((check) => check.name);
    expect(names).toEqual([
      "load",
      "ticks",
      "slider 'lift'",
      "toggle 'grip'",
      "button 'home'",
    ]);
    expect(result.checks.find((check) => check.name === "slider 'lift'")?.detail).toContain(
      "rotation.z"
    );
  });

  test("a toggle without a bound property fails the toggle check", () => {
    const doc = machineDoc();
    doc.controls?.push({ id: "dead", type: "toggle", label: "Dead" });

    const result = simulateDoc(doc);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("toggle 'dead': has no bound property");
  });

  test("a slider whose binding never moves fails the sweep check", () => {
    const doc = machineDoc();
    if (doc.controls?.[0]) doc.controls[0].bind = { entity: "arm", property: "rotation.z", scale: 0 };

    const result = simulateDoc(doc);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("does not move");
  });
});

describe("simulateDoc — light kits", () => {
  function walkthroughDoc(): GameDoc {
    return mustDoc({
      version: "1.0.0",
      meta: { title: "Sim House", archetype: "explore", mode: "walkthrough" },
      world: { bounds: [18, 8, 18], lighting: "indoor" },
      entities: [
        { id: "player", kind: "player", position: [0, 1, 0] },
        { id: "door", kind: "interactable", position: [0, 1.5, 4] },
      ],
      objectives: [],
      rules: [
        {
          id: "open",
          on: { event: "interact", entity: "door" },
          then: [{ type: "openDoor", entity: "door" }],
        },
      ],
      scratch: {},
    });
  }

  function inspectDoc(): GameDoc {
    return mustDoc({
      version: "1.0.0",
      meta: { title: "Sim Board", archetype: "explore", mode: "inspect" },
      world: { bounds: [16, 10, 16], lighting: "indoor" },
      entities: [
        { id: "player", kind: "player", position: [0, 3, 8] },
        {
          id: "board",
          kind: "prop",
          position: [0, 1.6, 0],
          parts: [{ shape: "box", size: [6, 0.3, 4] }],
          label: { text: "Main board" },
        },
      ],
      objectives: [],
      rules: [
        {
          id: "inspect-board",
          on: { event: "click", entity: "board" },
          then: [{ type: "showPanel", title: "Board", body: "The main board." }],
        },
      ],
      scratch: {},
    });
  }

  test("walkthrough: the player can move", () => {
    const result = simulateDoc(walkthroughDoc());
    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === "movement")?.ok).toBe(true);
  });

  test("inspect: requires a click rule on an existing entity", () => {
    expect(simulateDoc(inspectDoc()).ok).toBe(true);

    const broken = inspectDoc();
    broken.rules = [];
    const result = simulateDoc(broken);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("no click rule targets an existing entity");
  });

  test("explore: rejects zones", () => {
    const doc = mustDoc({
      version: "1.0.0",
      meta: { title: "Sim Clearing", archetype: "explore" },
      world: { bounds: [24, 10, 24], lighting: "dusk" },
      entities: [
        { id: "player", kind: "player", position: [0, 1, 0] },
        { id: "campfire", kind: "prop", position: [4, 0.5, 3] },
      ],
      objectives: [],
      rules: [],
      scratch: {},
    });
    expect(simulateDoc(doc).ok).toBe(true);

    const zoned = mustDoc({
      ...JSON.parse(JSON.stringify(doc)),
      entities: [
        { id: "player", kind: "player", position: [0, 1, 0] },
        { id: "campfire", kind: "prop", position: [4, 0.5, 3] },
        { id: "glow", kind: "zone", position: [4, 1, 3], size: [6, 3, 6] },
      ],
    });
    const result = simulateDoc(zoned);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("no-zones");
  });

  test("drive: two seconds of throttle reach a finite positive speed", () => {
    const doc = mustDoc({
      version: "1.0.0",
      meta: { title: "Sim Race", archetype: "collect-a-thon", mode: "drive" },
      world: { bounds: [40, 10, 40] },
      entities: [
        {
          id: "player",
          kind: "player",
          position: [0, 1, -18],
          props: { vehicle: true, maxSpeed: 16 },
        },
      ],
      objectives: [],
      rules: [],
      scratch: {},
    });
    const result = simulateDoc(doc);
    const throttle = result.checks.find((check) => check.name === "throttle");
    expect(throttle?.ok).toBe(true);
    expect(throttle?.detail).toMatch(/^speed \d+\.\d+ after 2s throttle$/);
  });
});

describe("simulateDoc — NaN guard", () => {
  test("nonFiniteRuntime reports non-finite positions and rotations", () => {
    const engine = createEngine();
    engine.load(collectDoc());
    const state = engine.getState();
    const player = state.entities.find((entity) => entity.kind === "player");
    expect(player).toBeDefined();
    if (!player) return;

    const runtime = state.entityRuntime[player.id];
    const broken = {
      ...state,
      entityRuntime: {
        ...state.entityRuntime,
        [player.id]: {
          ...runtime,
          position: [Number.NaN, 1, 0] as Vec3,
          rotation: [0, Number.POSITIVE_INFINITY, 0] as Vec3,
        },
      },
    };

    const issues = nonFiniteRuntime(broken);
    expect(issues).toContain(`${player.id}.position`);
    expect(issues).toContain(`${player.id}.rotation`);
    expect(nonFiniteRuntime(state)).toEqual([]);
  });
});
