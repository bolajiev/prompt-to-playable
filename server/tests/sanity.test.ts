import { describe, expect, test } from "vitest";
import type { GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { hasWinPath, requiresWinPath, sanityCheck } from "../src/sanity.js";

function docWith(overrides: Partial<GameDoc>): GameDoc {
  const base: unknown = {
    version: "1.0.0",
    meta: { title: "Sanity Room", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "gem", kind: "collectible", position: [4, 0, 4] },
    ],
    objectives: [{ id: "obj1", type: "collect", targets: ["gem"], count: 1 }],
    rules: [],
    scratch: {},
  };
  const res = validateGame(base);
  if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
  return { ...res.data, ...overrides };
}

function codes(result: ReturnType<typeof sanityCheck>): string[] {
  return result.errors.map((issue) => issue.code);
}

describe("sanityCheck", () => {
  test("accepts a clean layout", () => {
    const result = sanityCheck(docWith({}));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects an orphan target — objective references a missing entity (unsolvable)", () => {
    const doc = docWith({});
    doc.objectives = [{ id: "obj1", type: "reach", target: "ghost-door" }];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    const orphan = result.errors.filter((issue) => issue.code === "missing-objective-target");
    expect(orphan.length).toBe(1);
    expect(orphan[0]?.path).toBe("objectives[obj1].target");
    expect(orphan[0]?.message).toContain("ghost-door");
  });

  test("rejects orphan targets in the targets array", () => {
    const doc = docWith({});
    doc.objectives = [
      { id: "obj1", type: "collect", targets: ["gem", "missing"], count: 1 },
    ];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-objective-target");
  });

  test("rejects an entity referenced by a rule that does not exist", () => {
    const doc = docWith({});
    doc.rules = [
      {
        id: "r1",
        on: { event: "playerEnter", zone: "zoneA" },
        then: [{ type: "despawn", entity: "ghost" }],
      },
    ];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-rule-reference");
    expect(
      result.errors.some(
        (issue) => issue.path === "rules[r1].then[0].entity" && issue.message.includes("ghost")
      )
    ).toBe(true);
  });

  test("rejects a rule referencing an unknown objective", () => {
    const doc = docWith({});
    doc.rules = [
      {
        id: "r1",
        on: { event: "playerEnter", zone: "zoneA" },
        then: [{ type: "objectiveProgress", objective: "does-not-exist", by: 1 }],
      },
    ];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-rule-reference");
    expect(
      result.errors.some((issue) => issue.message.includes("does-not-exist"))
    ).toBe(true);
  });

  test("reports a missing player entity", () => {
    const doc = docWith({});
    doc.entities = [{ id: "gem", kind: "collectible", position: [4, 0, 4] }];
    const result = sanityCheck(doc);
    expect(codes(result)).toContain("no-player");
    expect(result.ok).toBe(false);
  });

  test("rejects an entity position outside world bounds", () => {
    const doc = docWith({});
    (doc.entities.find((e) => e.id === "gem") as NonNullable<GameDoc["entities"][number]>).position = [30, 0, 4];
    const result = sanityCheck(doc);
    expect(codes(result)).toContain("out-of-bounds");
    expect(result.errors.some((issue) => issue.path.includes("entities[gem].position"))).toBe(true);
  });

  test("rejects patrol waypoints outside world bounds", () => {
    const doc = docWith({});
    (doc.entities.find((e) => e.id === "gem") as NonNullable<GameDoc["entities"][number]>).patrol = [
      [0, 0, 0],
      [0, 0, 99],
    ];
    const result = sanityCheck(doc);
    expect(codes(result)).toContain("out-of-bounds");
  });
});

describe("reachability heuristic (deterministic A* on 2D grid)", () => {
  test("open field from player to reach target passes", () => {
    const doc = docWith({});
    doc.objectives = [{ id: "obj1", type: "reach", target: "gem" }];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(true);
    expect(codes(result)).not.toContain("unreachable-target");
  });

  test("is deterministic for identical inputs", () => {
    const doc = docWith({});
    doc.objectives = [{ id: "obj1", type: "reach", target: "gem" }];
    expect(sanityCheck(doc).errors).toEqual(sanityCheck(doc).errors);
  });

  test("rejects a reach target sealed off by an obstacle wall (clearly unsolvable)", () => {
    const doc = docWith({});
    (doc.entities.find((e) => e.id === "player") as NonNullable<GameDoc["entities"][number]>).position = [-5, 0, 0];
    (doc.entities.find((e) => e.id === "gem") as NonNullable<GameDoc["entities"][number]>).position = [5, 0, 5];
    doc.objectives = [{ id: "obj1", type: "reach", target: "gem" }];
    doc.world.terrain.obstacles = [
      { position: [0, 0, 0], size: [0.5, 4, 40] },
    ];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("unreachable-target");
  });

  test("rejects a collect target buried inside an obstacle", () => {
    const doc = docWith({});
    (doc.entities.find((e) => e.id === "gem") as NonNullable<GameDoc["entities"][number]>).position = [3, 0, 0];
    doc.world.terrain.obstacles = [
      { position: [3, 0, 0], size: [2, 4, 2] },
    ];
    const result = sanityCheck(doc);
    expect(codes(result)).toContain("unreachable-target");
  });

  test("reachability is skipped for objectives without positional targets", () => {
    const doc = docWith({});
    doc.objectives = [{ id: "obj1", type: "collect", count: 3 }];
    expect(sanityCheck(doc).ok).toBe(true);
  });
});

function exploreDoc(overrides: Partial<GameDoc> = {}): GameDoc {
  const base: unknown = {
    version: "1.0.0",
    meta: { title: "Quiet Scene", archetype: "explore" },
    world: { bounds: [24, 10, 24], lighting: "dusk" },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "campfire", kind: "prop", position: [4, 0.5, 3] },
    ],
    objectives: [],
    rules: [],
    scratch: {},
  };
  const res = validateGame(base);
  if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
  return { ...res.data, ...overrides };
}

describe("sanityCheck — explore scenes", () => {
  test("accepts an explore doc with no objectives and no rules", () => {
    const result = sanityCheck(exploreDoc());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("still reports a missing player entity", () => {
    const doc = exploreDoc();
    doc.entities = [{ id: "campfire", kind: "prop", position: [4, 0.5, 3] }];
    expect(codes(sanityCheck(doc))).toContain("no-player");
  });

  test("still reports out-of-bounds entities", () => {
    const doc = exploreDoc();
    (doc.entities.find((e) => e.id === "campfire") as NonNullable<GameDoc["entities"][number]>).position = [
      40, 0.5, 3,
    ];
    expect(codes(sanityCheck(doc))).toContain("out-of-bounds");
  });

  test("still reports orphan rule references", () => {
    const doc = exploreDoc();
    doc.rules = [
      {
        id: "r1",
        on: { event: "interact", entity: "ghost" },
        then: [{ type: "showMessage", text: "hi" }],
      },
    ];
    const result = sanityCheck(doc);
    expect(codes(result)).toContain("missing-rule-reference");
    expect(result.ok).toBe(false);
  });

  test("win path is required for games but not for explore", () => {
    const scene = exploreDoc();
    expect(hasWinPath(scene)).toBe(false);
    expect(requiresWinPath(scene)).toBe(false);

    const game = docWith({});
    expect(hasWinPath(game)).toBe(false);
    expect(requiresWinPath(game)).toBe(true);

    const winnable = docWith({});
    winnable.rules = [
      {
        id: "r1",
        on: { event: "objectiveComplete", objective: "obj1" },
        then: [{ type: "win" }],
      },
    ];
    expect(hasWinPath(winnable)).toBe(true);
  });
});

function kitFixture(raw: Record<string, unknown>): GameDoc {
  const res = validateGame(raw);
  if (!res.ok || !res.data) throw new Error("kit fixture fails schema validation");
  return res.data;
}

function inspectFixture(): GameDoc {
  return kitFixture({
    version: "1.0.0",
    meta: { title: "Inspect Board", archetype: "explore", mode: "inspect" },
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
      {
        id: "chip",
        kind: "prop",
        position: [1, 2, 0],
        parts: [{ shape: "box", size: [1, 0.4, 1] }],
      },
    ],
    objectives: [],
    rules: [
      {
        id: "inspect-board",
        on: { event: "click", entity: "board" },
        then: [
          { type: "showPanel", title: "Board", body: "The main board." },
          { type: "setColor", entity: "board", color: "cyan" },
        ],
      },
    ],
    scratch: {},
  });
}

function walkthroughFixture(): GameDoc {
  return kitFixture({
    version: "1.0.0",
    meta: { title: "Walk House", archetype: "explore", mode: "walkthrough" },
    world: { bounds: [18, 8, 18], lighting: "indoor" },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 3] },
      { id: "door", kind: "interactable", position: [0, 1.5, 5], props: { door: true } },
    ],
    objectives: [],
    rules: [
      {
        id: "open-door",
        on: { event: "interact", entity: "door" },
        then: [
          { type: "animate", entity: "door", kind: "slide", to: [2, 1.5, 5] },
          { type: "openDoor", entity: "door" },
        ],
      },
    ],
    scratch: {},
  });
}

function driveFixture(): GameDoc {
  return kitFixture({
    version: "1.0.0",
    meta: { title: "Kit Race", archetype: "collect-a-thon", mode: "drive" },
    world: { bounds: [40, 10, 40] },
    entities: [
      {
        id: "player",
        kind: "player",
        position: [0, 1, -18],
        props: { vehicle: true, maxSpeed: 16 },
      },
      {
        id: "cp-1",
        kind: "zone",
        position: [0, 1, -8],
        size: [7, 3, 7],
        props: { checkpointIndex: 0 },
      },
      {
        id: "cp-2",
        kind: "zone",
        position: [0, 1, 0],
        size: [7, 3, 7],
        props: { checkpointIndex: 1 },
      },
      {
        id: "cp-3",
        kind: "zone",
        position: [0, 1, 8],
        size: [7, 3, 7],
        props: { checkpointIndex: 2 },
      },
    ],
    objectives: [
      {
        id: "pass-checkpoints",
        type: "collect",
        targets: ["cp-1", "cp-2", "cp-3"],
        count: 3,
      },
    ],
    rules: [
      {
        id: "gate-1",
        on: { event: "playerEnter", zone: "cp-1" },
        then: [
          { type: "incVar", key: "cp" },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
        ],
      },
      {
        id: "gate-2",
        on: { event: "playerEnter", zone: "cp-2" },
        if: { op: "==", left: { var: "cp" }, right: 1 },
        then: [
          { type: "incVar", key: "cp" },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
        ],
      },
      {
        id: "gate-3",
        on: { event: "playerEnter", zone: "cp-3" },
        if: { op: "==", left: { var: "cp" }, right: 2 },
        then: [
          { type: "incVar", key: "cp" },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
        ],
      },
      {
        id: "race-won",
        on: { event: "objectiveComplete", objective: "pass-checkpoints" },
        then: [{ type: "win", message: "Checkered flag!" }],
      },
    ],
    scratch: { cp: 0 },
  });
}

describe("sanityCheck — inspect kit", () => {
  test("accepts a labeled assembly with a click rule and needs no win path", () => {
    const doc = inspectFixture();
    expect(sanityCheck(doc).ok).toBe(true);
    expect(requiresWinPath(doc)).toBe(false);
  });

  test("rejects an inspect scene without parts or labels", () => {
    const doc = inspectFixture();
    for (const entity of doc.entities) {
      entity.parts = undefined;
      entity.label = undefined;
    }
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-inspect-content");
  });

  test("rejects an inspect scene without a click rule", () => {
    const doc = inspectFixture();
    doc.rules = [];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-click-rule");
  });

  test("still reports out-of-bounds and orphan refs for inspect scenes", () => {
    const doc = inspectFixture();
    (doc.entities.find((e) => e.id === "board") as NonNullable<GameDoc["entities"][number]>).position = [
      99, 1.6, 0,
    ];
    doc.rules = [
      {
        id: "ghost-click",
        on: { event: "click", entity: "ghost" },
        then: [{ type: "hidePanel" }],
      },
    ];
    const result = sanityCheck(doc);
    expect(codes(result)).toContain("out-of-bounds");
    expect(codes(result)).toContain("missing-rule-reference");
  });
});

describe("sanityCheck — walkthrough kit", () => {
  test("accepts a player plus an interactable and needs no win path", () => {
    const doc = walkthroughFixture();
    expect(sanityCheck(doc).ok).toBe(true);
    expect(requiresWinPath(doc)).toBe(false);
  });

  test("rejects a walkthrough without any interactable", () => {
    const doc = walkthroughFixture();
    doc.entities = doc.entities.filter((entity) => entity.id !== "door");
    doc.rules = [];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-interactable");
  });

  test("rejects a walkthrough without a player", () => {
    const doc = walkthroughFixture();
    doc.entities = doc.entities.filter((entity) => entity.kind !== "player");
    expect(codes(sanityCheck(doc))).toContain("no-player");
  });
});

describe("sanityCheck — drive kit", () => {
  test("accepts an ordered checkpoint race with a vehicle and a win path", () => {
    const doc = driveFixture();
    expect(sanityCheck(doc).ok).toBe(true);
    expect(requiresWinPath(doc)).toBe(true);
    expect(hasWinPath(doc)).toBe(true);
  });

  test("rejects a drive scene whose player is not a vehicle", () => {
    const doc = driveFixture();
    const player = doc.entities.find((entity) => entity.kind === "player");
    if (player) player.props = { maxSpeed: 16 };
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("not-a-vehicle");
  });

  test("rejects a drive scene with fewer than three checkpoints", () => {
    const doc = driveFixture();
    doc.entities = doc.entities.filter((entity) => entity.id !== "cp-3");
    doc.objectives = [
      {
        id: "pass-checkpoints",
        type: "collect",
        targets: ["cp-1", "cp-2"],
        count: 2,
      },
    ];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-checkpoints");
  });

  test("rejects non-contiguous checkpoint indexes", () => {
    const doc = driveFixture();
    const last = doc.entities.find((entity) => entity.id === "cp-3");
    if (last) last.props = { checkpointIndex: 3 };
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("invalid-checkpoint-index");
  });

  test("rejects a drive scene without a win path", () => {
    const doc = driveFixture();
    doc.rules = doc.rules.filter(
      (rule) => !rule.then.some((action) => action.type === "win")
    );
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-win-path");
    expect(requiresWinPath(doc)).toBe(true);
  });

  test("explicit drive mode beats the free-roam explore archetype", () => {
    const doc = driveFixture();
    doc.meta.archetype = "explore";
    const result = sanityCheck(doc);
    expect(codes(result)).not.toContain("missing-checkpoints");
    expect(requiresWinPath(doc)).toBe(true);
  });
});

function machineFixture(): GameDoc {
  return kitFixture({
    version: "1.0.0",
    meta: { title: "Desk Arm", archetype: "explore", mode: "machine" },
    world: { bounds: [16, 10, 16], lighting: "indoor" },
    entities: [
      { id: "player", kind: "player", position: [-12, 1, 0] },
      {
        id: "arm-link",
        kind: "prop",
        position: [0, 1.2, 0],
        size: [1.7, 1.1, 1.7],
        parts: [
          {
            shape: "capsule",
            offset: [1, 0, 0],
            size: [0.3, 2, 0.3],
            rotation: [0, 0, 1.5708],
          },
        ],
        label: { text: "SHOULDER", flat: true, offset: [1, 0.6, 0], size: 0.45 },
      },
    ],
    objectives: [],
    rules: [
      {
        id: "inspect-link",
        on: { event: "click", entity: "arm-link" },
        then: [
          { type: "cameraFocus", entity: "arm-link" },
          {
            type: "showPanel",
            title: "SHOULDER",
            body: "Lift servo.",
            entity: "arm-link",
          },
        ],
      },
    ],
    controls: [
      {
        id: "shoulder",
        type: "slider",
        label: "Shoulder lift",
        min: -1,
        max: 1,
        value: 0,
        bind: { entity: "arm-link", property: "rotation.z", scale: 1.2 },
      },
      {
        id: "grip",
        type: "toggle",
        label: "Grip open",
        value: 0,
        bind: { entity: "arm-link", property: "rotation.z", scale: 0.5, var: "grip" },
      },
      {
        id: "home",
        type: "button",
        label: "HOME",
        bind: {
          onPress: [
            { type: "animate", entity: "arm-link", kind: "slide", to: [0, 1.2, 0] },
            { type: "setVar", key: "homed", value: 1 },
          ],
        },
      },
    ],
    scratch: { homed: 0 },
  });
}

describe("sanityCheck — machine kit", () => {
  test("accepts a bound slider driven arm and needs no win path", () => {
    const doc = machineFixture();
    expect(sanityCheck(doc).ok).toBe(true);
    expect(requiresWinPath(doc)).toBe(false);
    expect(hasWinPath(doc)).toBe(false);
  });

  test("rejects a machine without any slider bound to an entity property", () => {
    const doc = machineFixture();
    for (const control of doc.controls ?? []) {
      if (control.type === "slider") control.bind = { var: "shoulder" };
    }
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-machine-control");
  });

  test("rejects a control bound to an unknown entity", () => {
    const doc = machineFixture();
    if (doc.controls?.[0]) doc.controls[0].bind = { entity: "ghost", property: "rotation.z" };
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("invalid-control-bind");
    expect(
      result.errors.some(
        (issue) =>
          issue.path === "controls[shoulder].bind.entity" &&
          issue.message.includes("ghost")
      )
    ).toBe(true);
  });

  test("rejects a button whose onPress references an unknown entity", () => {
    const doc = machineFixture();
    if (doc.controls?.[2]) {
      doc.controls[2].bind = {
        onPress: [{ type: "animate", entity: "ghost-jaw", kind: "bob" }],
      };
    }
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("invalid-control-bind");
    expect(result.errors.some((issue) => issue.message.includes("ghost-jaw"))).toBe(
      true
    );
  });

  test("still reports a missing player and out-of-bounds joints", () => {
    const doc = machineFixture();
    doc.entities = doc.entities.filter((entity) => entity.kind !== "player");
    expect(codes(sanityCheck(doc))).toContain("no-player");

    const bounded = machineFixture();
    const link = bounded.entities.find((entity) => entity.id === "arm-link");
    if (link) link.position = [40, 1.2, 0];
    expect(codes(sanityCheck(bounded))).toContain("out-of-bounds");
  });
});

describe("sanityCheck — new interaction action refs", () => {
  test("reports unknown entities for setVisible, setColor, animate and panels", () => {
    const doc = docWith({});
    doc.rules = [
      {
        id: "r1",
        on: { event: "tick" },
        then: [{ type: "animate", entity: "ghost-a", kind: "spin" }],
      },
      {
        id: "r2",
        on: { event: "tick" },
        then: [{ type: "setVisible", entity: "ghost-b", visible: false }],
      },
      {
        id: "r3",
        on: { event: "tick" },
        then: [{ type: "setColor", entity: "ghost-c", color: "cyan" }],
      },
      {
        id: "r4",
        on: { event: "tick" },
        then: [{ type: "showPanel", title: "T", body: "B", entity: "ghost-d" }],
      },
      {
        id: "r5",
        on: { event: "tick" },
        then: [{ type: "cameraFocus", entity: "ghost-e" }],
      },
    ];
    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    const missing = result.errors.filter(
      (issue) => issue.code === "missing-rule-reference"
    );
    expect(missing).toHaveLength(5);
    for (const ghost of ["ghost-a", "ghost-b", "ghost-c", "ghost-d", "ghost-e"]) {
      expect(result.errors.some((issue) => issue.message.includes(ghost))).toBe(true);
    }
  });

  test("accepts entity-less panel and focus actions", () => {
    const doc = docWith({});
    doc.rules = [
      {
        id: "r1",
        on: { event: "tick" },
        then: [
          { type: "showPanel", title: "Info", body: "No entity." },
          { type: "hidePanel" },
          { type: "cameraFocus" },
        ],
      },
    ];
    expect(sanityCheck(doc).ok).toBe(true);
  });
});
describe("entity parenting sanity", () => {
  test("rejects an entity whose parent does not exist", () => {
    const doc = docWith({});
    doc.entities.push({
      id: "grip",
      kind: "prop",
      parent: "ghost-arm",
      position: [0, 0, 0],
    } as (typeof doc.entities)[number]);

    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-parent");
    expect(
      result.errors.some(
        (issue) =>
          issue.path === "entities[grip].parent" &&
          issue.message.includes("ghost-arm")
      )
    ).toBe(true);
  });

  test("rejects a self-parented entity as a cycle", () => {
    const doc = docWith({});
    doc.entities.push({
      id: "loop",
      kind: "prop",
      parent: "loop",
      position: [0, 0, 0],
    } as (typeof doc.entities)[number]);

    const result = sanityCheck(doc);
    expect(codes(result)).toContain("parent-cycle");
  });

  test("rejects a multi-entity parent cycle", () => {
    const doc = docWith({});
    doc.entities.push(
      { id: "a", kind: "prop", parent: "b", position: [0, 0, 0] } as (typeof doc.entities)[number],
      { id: "b", kind: "prop", parent: "a", position: [0, 0, 0] } as (typeof doc.entities)[number]
    );

    const result = sanityCheck(doc);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("parent-cycle");
  });

  test("accepts a clean parent chain", () => {
    const doc = docWith({});
    doc.entities.push(
      { id: "base", kind: "prop", position: [0, 0, 0] } as (typeof doc.entities)[number],
      {
        id: "link",
        kind: "prop",
        parent: "base",
        attach: [0, 1, 0],
        position: [0, 0, 0],
      } as (typeof doc.entities)[number],
      {
        id: "grip",
        kind: "prop",
        parent: "link",
        attach: [1, 0, 0],
        position: [0, 0, 0],
      } as (typeof doc.entities)[number]
    );

    expect(sanityCheck(doc).ok).toBe(true);
  });
});
