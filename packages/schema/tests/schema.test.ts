import { describe, expect, test } from "vitest";
import { isGame, validateGame } from "../src/validators.js";
import { GameSchema, SCHEMA_VERSION } from "../src/schema.js";

function minimalDoc() {
  return {
    version: SCHEMA_VERSION,
    meta: { title: "Tiny Room", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
    objectives: [{ id: "obj1", type: "collect", count: 1 }],
    rules: [],
    scratch: {},
  };
}

describe("GameSchema", () => {
  test("minimal valid doc passes isGame", () => {
    expect(isGame(minimalDoc())).toBe(true);
  });

  test("validateGame returns ok with parsed data (defaults applied)", () => {
    const res = validateGame(minimalDoc());
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.data?.meta.archetype).toBe("collect-a-thon");
    expect(res.data?.world.lighting).toBe("day");
    expect(res.data?.rules).toEqual([]);
    expect(res.data?.entities[0]?.active).toBe(true);
  });

  test("missing player entity fails", () => {
    const doc = minimalDoc();
    doc.entities = [{ id: "crystal", kind: "collectible", position: [1, 1, 1] }] as typeof doc.entities;
    expect(isGame(doc)).toBe(false);
    const res = validateGame(doc);
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  test("bad archetype fails", () => {
    const doc = minimalDoc();
    (doc.meta as { archetype: string }).archetype = "racing";
    expect(isGame(doc)).toBe(false);
  });

  test("bad version fails", () => {
    const doc = minimalDoc();
    (doc as { version: string }).version = "0.0.1";
    expect(isGame(doc)).toBe(false);
  });

  test("missing title fails", () => {
    const doc = minimalDoc();
    (doc.meta as { title?: string }).title = undefined;
    expect(isGame(doc)).toBe(false);
  });

  test("rules constrained to allowed events and actions", () => {
    const doc = minimalDoc();
    doc.objectives = [{ id: "obj1", type: "collect", count: 1 }] as typeof doc.objectives;
    (doc as { rules: unknown[] }).rules = [
      {
        id: "r1",
        on: { event: "playerEnter", zone: "z1" },
        then: [{ type: "objectiveProgress", objective: "obj1", by: 1 }],
      },
    ];
    expect(isGame(doc)).toBe(true);
  });

  test("unknown event is rejected", () => {
    const doc = minimalDoc();
    (doc as { rules: unknown[] }).rules = [
      { id: "r1", on: { event: "explode" }, then: [{ type: "win" }] },
    ];
    expect(isGame(doc)).toBe(false);
  });

  test("unknown action is rejected", () => {
    const doc = minimalDoc();
    (doc as { rules: unknown[] }).rules = [
      { id: "r1", on: { event: "playerEnter" }, then: [{ type: "launchNuke" }] },
    ];
    expect(isGame(doc)).toBe(false);
  });

  test("condition (scratch comparison) parses", () => {
    const doc = minimalDoc();
    (doc as { rules: unknown[] }).rules = [
      {
        id: "r1",
        on: { event: "interact" },
        if: {
          op: "<",
          left: { var: "crystals_lit" },
          right: 3,
        },
        then: [{ type: "incVar", key: "crystals_lit", by: 1 }],
      },
    ];
    expect(isGame(doc)).toBe(true);
  });

  test("bare SafeParse reports success without validators layer", () => {
    expect(GameSchema.safeParse(minimalDoc()).success).toBe(true);
  });
});

function v11Doc() {
  const doc = minimalDoc() as unknown as {
    meta: Record<string, unknown>;
    entities: Array<Record<string, unknown>>;
    rules: unknown[];
  };
  doc.meta.mode = "inspect";
  doc.entities.push({
    id: "board",
    kind: "prop",
    position: [0, 0.5, 0],
    parts: [
      {
        shape: "box",
        offset: [0, 0.1, 0],
        size: [2, 0.2, 3],
        rotation: [0, 0.5, 0],
        color: "#33aa55",
        material: {
          metalness: 0.6,
          roughness: 0.4,
          emissive: "#001100",
          opacity: 0.9,
          texture: "circuit",
        },
      },
      { shape: "cylinder" },
    ],
    label: { text: "PCB", offset: [0, 1, 0], size: 0.5 },
  });
  doc.rules = [
    {
      id: "r1",
      on: { event: "click", entity: "board" },
      then: [
        { type: "setVisible", entity: "board", visible: false },
        { type: "setColor", entity: "board", color: "#ff0000" },
        {
          type: "animate",
          entity: "board",
          kind: "spin",
          axis: [0, 1, 0],
          speed: 2,
        },
        { type: "cameraFocus", entity: "board" },
        {
          type: "showPanel",
          title: "PCB",
          body: "A circuit board",
          entity: "board",
        },
        { type: "hidePanel" },
      ],
    },
    {
      id: "r2",
      on: { event: "hoverEnter", entity: "board" },
      then: [
        { type: "animate", entity: "board", kind: "bob", amplitude: 0.5, speed: 1 },
      ],
    },
    {
      id: "r3",
      on: { event: "hoverLeave", entity: "board" },
      then: [
        { type: "animate", entity: "board", kind: "slide", to: [1, 1, 1], duration: 500 },
      ],
    },
    {
      id: "r4",
      on: { event: "interact", entity: "board" },
      then: [{ type: "animate", entity: "board", kind: "pulse", speed: 0.5 }],
    },
    {
      id: "r5",
      on: { event: "interact", entity: "board" },
      then: [{ type: "animate", entity: "board", kind: "orbit", amplitude: 2, speed: 0.25 }],
    },
  ];
  return doc;
}

describe("GameSchema v1.1 additions", () => {
  test("doc with parts, labels, mode, new events and actions parses", () => {
    const res = validateGame(v11Doc());
    expect(res.ok).toBe(true);
    expect(res.data?.meta.mode).toBe("inspect");
    const board = res.data?.entities.find((e) => e.id === "board");
    expect(board?.parts).toHaveLength(2);
    expect(board?.parts?.[0]?.shape).toBe("box");
    expect(board?.parts?.[0]?.material?.texture).toBe("circuit");
    expect(board?.label?.text).toBe("PCB");
    expect(board?.label?.size).toBe(0.5);
    const actions = res.data?.rules[0]?.then ?? [];
    expect(actions.map((a) => a.type)).toEqual([
      "setVisible",
      "setColor",
      "animate",
      "cameraFocus",
      "showPanel",
      "hidePanel",
    ]);
    expect(res.data?.rules[1]?.on.event).toBe("hoverEnter");
    expect(res.data?.rules[2]?.on.event).toBe("hoverLeave");
  });

  test("part defaults applied (offset and size)", () => {
    const res = validateGame(v11Doc());
    const part = res.data?.entities.find((e) => e.id === "board")?.parts?.[1];
    expect(part?.offset).toEqual([0, 0, 0]);
    expect(part?.size).toEqual([1, 1, 1]);
  });

  test("bad part shape fails", () => {
    const doc = v11Doc();
    (doc.entities[1]!.parts as Array<Record<string, unknown>>)[0]!.shape =
      "pyramid";
    expect(isGame(doc)).toBe(false);
  });

  test("bad texture fails", () => {
    const doc = v11Doc();
    const material = (
      (doc.entities[1]!.parts as Array<Record<string, unknown>>)[0]!
        .material as Record<string, unknown>
    );
    material.texture = "marble";
    expect(isGame(doc)).toBe(false);
  });

  test("bad animate kind fails", () => {
    const doc = v11Doc();
    (doc.rules[0] as { then: Array<Record<string, unknown>> }).then[2]!.kind =
      "explode";
    expect(isGame(doc)).toBe(false);
  });

  test("bad mode fails", () => {
    const doc = v11Doc();
    doc.meta.mode = "fly";
    expect(isGame(doc)).toBe(false);
  });

  test("old minimal doc still parses without v1.1 fields (backward compat)", () => {
    const res = validateGame(minimalDoc());
    expect(res.ok).toBe(true);
    expect(res.data?.meta.mode).toBeUndefined();
    expect(res.data?.entities[0]?.parts).toBeUndefined();
    expect(res.data?.entities[0]?.label).toBeUndefined();
  });
});
