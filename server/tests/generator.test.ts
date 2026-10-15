import { describe, expect, test, vi } from "vitest";
import { validateGame } from "@prompt-to-playable/schema";
import type { GameDoc } from "@prompt-to-playable/schema";
import {
  ARCHETYPE_EXAMPLES,
  KIT_ARCHETYPES,
  KIT_SCHEMA_ARCHETYPE,
  buildGenerationPrompt,
  generate,
} from "../src/generator.js";
import type { KitArchetype } from "../src/generator.js";
import { hasWinPath, requiresWinPath, sanityCheck } from "../src/sanity.js";
import { createCorpusLlm, evaluatePrompts } from "../../scripts/eval-corpus.js";
import type { CorpusEntry } from "../../scripts/eval-corpus.js";

type LlmCall = (prompt: string) => Promise<string>;

const KIT_LABELS: readonly KitArchetype[] = ["inspect", "walkthrough", "drive"];

function integerCheckpoints(doc: GameDoc): number[] {
  return doc.entities
    .filter(
      (entity) => entity.kind === "zone" && typeof entity.props?.checkpointIndex === "number"
    )
    .map((entity) => entity.props?.checkpointIndex as number)
    .sort((a, b) => a - b);
}

interface PlanBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function planBounds(entity: { position: number[]; size?: number[] }): PlanBounds {
  if (!entity.size) throw new Error("entity has no size to bound");
  return {
    minX: entity.position[0] - entity.size[0] / 2,
    maxX: entity.position[0] + entity.size[0] / 2,
    minZ: entity.position[2] - entity.size[2] / 2,
    maxZ: entity.position[2] + entity.size[2] / 2,
  };
}

function planOverlap(a: PlanBounds, b: PlanBounds): { x: number; z: number } {
  return {
    x: Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX),
    z: Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ),
  };
}

describe("kit few-shot examples", () => {
  test("every classification label has a schema-valid, sane example", () => {
    expect(Object.keys(ARCHETYPE_EXAMPLES).sort()).toEqual([...KIT_ARCHETYPES].sort());
    for (const label of KIT_ARCHETYPES) {
      const example = ARCHETYPE_EXAMPLES[label];
      expect(validateGame(example).ok, label).toBe(true);
      expect(sanityCheck(example).ok, label).toBe(true);
      expect(example.meta.archetype, label).toBe(KIT_SCHEMA_ARCHETYPE[label]);
      if (KIT_LABELS.includes(label)) {
        expect(example.meta.mode, label).toBe(label);
      }
    }
  });

  test("inspect example is a heypcb-grade PCB assembly", () => {
    const doc = ARCHETYPE_EXAMPLES.inspect;
    expect(doc.meta.mode).toBe("inspect");
    expect(doc.objectives).toEqual([]);
    expect(requiresWinPath(doc)).toBe(false);
    expect(doc.entities.length).toBeLessThanOrEqual(14);
    expect(doc.rules.length).toBeLessThanOrEqual(8);

    const board = doc.entities.find((entity) => entity.id === "board");
    expect(board, "board").toBeDefined();
    expect(
      board?.size,
      "board plate stays unsized so flat silkscreen labels keep their aspect"
    ).toBeUndefined();
    expect(board?.color).toBe("#1b4d2e");
    const plate = board?.parts?.[0];
    expect(plate?.material?.texture).toBe("circuit");
    const plateSize = plate?.size ?? [0, 0, 0];
    expect(plateSize[0] / plateSize[2]).toBeGreaterThan(1.5);
    expect(plateSize[0] / plateSize[2]).toBeLessThan(2.5);
    expect(plateSize[1]).toBeLessThanOrEqual(0.5);

    const labels = doc.entities.filter((entity) => entity.label !== undefined);
    expect(labels.length).toBeGreaterThanOrEqual(6);
    for (const entity of labels) {
      expect(entity.label?.flat, `${entity.id} label is flat silkscreen`).toBe(true);
    }
    expect(board?.label?.text.length ?? 0).toBeGreaterThan(0);

    const chips = doc.entities.filter((entity) => entity.props?.shape === "chip");
    expect(chips.length).toBeGreaterThanOrEqual(3);
    for (const chip of chips) {
      expect(chip.size, chip.id).toBeDefined();
      expect(chip.label?.text, chip.id).toBeDefined();
    }
    const designators = chips.map((chip) => chip.label?.text ?? "");
    expect(new Set(designators).size).toBe(designators.length);

    expect(
      doc.entities.filter((entity) => entity.props?.shape === "header").length
    ).toBeGreaterThanOrEqual(1);
    expect(
      doc.entities.filter((entity) => entity.props?.shape === "capacitor").length
    ).toBeGreaterThanOrEqual(2);
    const leds = doc.entities.filter((entity) => entity.props?.shape === "led");
    expect(leds.length).toBeGreaterThanOrEqual(3);
    for (const led of leds) {
      expect(led.color, led.id).toBeDefined();
    }
    const mountRings = doc.entities
      .flatMap((entity) => entity.parts ?? [])
      .filter((part) => part.shape === "torus");
    expect(mountRings.length).toBeGreaterThanOrEqual(4);

    const clickRules = doc.rules.filter((rule) => rule.on.event === "click");
    expect(clickRules.length).toBeGreaterThanOrEqual(2);
    const actionTypes = clickRules.flatMap((rule) =>
      rule.then.map((action) => action.type)
    );
    expect(actionTypes).toContain("showPanel");
    expect(actionTypes).toContain("setColor");
    expect(actionTypes).toContain("cameraFocus");
    expect(actionTypes).toContain("hidePanel");

    const panelRules = clickRules.filter((rule) =>
      rule.then.some((action) => action.type === "showPanel")
    );
    const panelBodies: string[] = [];
    for (const rule of panelRules) {
      expect(
        rule.then.some((action) => action.type === "setColor"),
        `${rule.id} should emphasize the clicked part`
      ).toBe(true);
      for (const action of rule.then) {
        if (action.type !== "showPanel") continue;
        panelBodies.push(action.body);
        expect(action.title.length, `${rule.id} panel title`).toBeGreaterThan(0);
      }
    }
    expect(panelBodies.some((body) => /pin/i.test(body))).toBe(true);

    const focusRule = clickRules.find((rule) => {
      const condition = rule.if;
      if (!condition || condition.op !== "==") return false;
      const left = condition.left;
      return (
        typeof left === "object" && left !== null && "var" in left && left.var === "focused"
      );
    });
    expect(focusRule, "first-click camera focus rule").toBeDefined();
    expect(
      focusRule?.then.some((action) => action.type === "cameraFocus")
    ).toBe(true);

    const animated = doc.rules
      .flatMap((rule) => rule.then)
      .find((action) => action.type === "animate");
    expect(animated?.type === "animate" && animated.kind).toBe("pulse");

    const resetRule = clickRules.find((rule) =>
      rule.then.some((action) => action.type === "hidePanel")
    );
    expect(resetRule, "reset pad clears the panels").toBeDefined();
  });

  test("walkthrough example has solid wall props, a sliding door and a toggling lamp", () => {
    const doc = ARCHETYPE_EXAMPLES.walkthrough;
    expect(doc.meta.mode).toBe("walkthrough");
    expect(doc.objectives).toEqual([]);
    expect(requiresWinPath(doc)).toBe(false);
    expect(doc.entities.length).toBeLessThanOrEqual(16);
    expect(doc.rules.length).toBeLessThanOrEqual(10);

    const walls = doc.entities.filter(
      (entity) => entity.kind === "prop" && entity.solid === true
    );
    expect(walls.length).toBeGreaterThanOrEqual(4);
    for (const wall of walls) {
      expect(wall.size, wall.id).toBeDefined();
      expect(wall.parts?.[0]?.offset, wall.id).toEqual([0, 0, 0]);
    }
    const frontWalls = walls.filter((wall) => wall.position[2] > 0);
    expect(frontWalls.length).toBeGreaterThanOrEqual(2);

    const wallById = new Map(walls.map((wall) => [wall.id, wall]));
    const back = wallById.get("wall-back");
    const left = wallById.get("wall-left");
    const right = wallById.get("wall-right");
    expect(back, "wall-back").toBeDefined();
    expect(left, "wall-left").toBeDefined();
    expect(right, "wall-right").toBeDefined();
    // Walls extend one thickness past the room corners instead of ending flush
    // with each other, so every corner seam is a real overlap, not a zero-width
    // gap the player could squeeze through.
    expect(back?.size?.[0]).toBeCloseTo(12.6);
    expect(back?.position[0]).toBe(0);
    expect(left?.size?.[2]).toBeCloseTo(10.6);
    expect(right?.size?.[2]).toBeCloseTo(10.6);
    expect(wallById.get("wall-front-left")?.size?.[0]).toBeCloseTo(5.3);
    expect(wallById.get("wall-front-right")?.size?.[0]).toBeCloseTo(5.3);

    const wallThickness = 0.3;
    const cornerPairs: ReadonlyArray<readonly [string, string]> = [
      ["wall-back", "wall-left"],
      ["wall-back", "wall-right"],
      ["wall-front-left", "wall-left"],
      ["wall-front-right", "wall-right"],
    ];
    for (const [firstId, secondId] of cornerPairs) {
      const first = wallById.get(firstId);
      const second = wallById.get(secondId);
      expect(first, firstId).toBeDefined();
      expect(second, secondId).toBeDefined();
      if (!first || !second) continue;
      const shared = planOverlap(planBounds(first), planBounds(second));
      expect(shared.x, `${firstId}/${secondId} x overlap`).toBeGreaterThanOrEqual(
        wallThickness - 1e-9
      );
      expect(shared.z, `${firstId}/${secondId} z overlap`).toBeGreaterThanOrEqual(
        wallThickness - 1e-9
      );
    }

    const door = doc.entities.find((entity) => entity.id === "front-door");
    expect(door?.kind).toBe("interactable");
    expect(door?.props?.door).toBe(true);
    expect(door?.solid).toBe(true);
    expect(door?.size).toBeDefined();
    if (door?.size && frontWalls.length >= 2) {
      const ordered = [...frontWalls].sort(
        (a, b) => a.position[0] - b.position[0]
      );
      const leftEdge = ordered[0].position[0] + ordered[0].size![0] / 2;
      const rightEdge = ordered[1].position[0] - ordered[1].size![0] / 2;
      const gap = rightEdge - leftEdge;
      expect(gap).toBeGreaterThan(0);
      expect(door.size[0]).toBeLessThanOrEqual(gap + 1e-6);
      expect(door.size[0]).toBeGreaterThan(gap / 2);
    }

    const doorRules = doc.rules.filter(
      (rule) => rule.on.event === "interact" && rule.on.entity === "front-door"
    );
    expect(doorRules.length).toBeGreaterThanOrEqual(2);
    const branch = (right: number) =>
      doorRules.find((rule) => {
        if (!rule.if || rule.if.op !== "==") return false;
        const left = rule.if.left;
        return (
          typeof left === "object" &&
          left !== null &&
          "var" in left &&
          left.var === "doorOpen" &&
          rule.if.right === right
        );
      });
    const openRule = branch(0);
    const closeRule = branch(1);
    expect(openRule, "open branch gated on doorOpen == 0").toBeDefined();
    expect(closeRule, "close branch gated on doorOpen == 1").toBeDefined();
    const slide = openRule?.then.find((action) => action.type === "animate");
    expect(slide?.type === "animate" && slide.kind).toBe("slide");
    expect(slide?.type === "animate" && Array.isArray(slide.to)).toBe(true);
    expect(openRule?.then.some((action) => action.type === "openDoor")).toBe(true);
    expect(
      closeRule?.then.some((action) => action.type === "setVar" && action.key === "doorOpen" && action.value === 0)
    ).toBe(true);

    const lamp = doc.entities.find((entity) => entity.id === "floor-lamp");
    expect(lamp?.kind).toBe("interactable");
    expect(lamp?.solid).not.toBe(true);
    const lampRules = doc.rules.filter((rule) => rule.on.entity === "floor-lamp");
    const lampActions = lampRules.flatMap((rule) => rule.then.map((action) => action.type));
    expect(lampActions).toContain("setVisible");
    expect(lampActions).toContain("setColor");
    const glow = doc.entities.find((entity) => entity.id === "lamp-glow");
    expect(glow?.parts?.length).toBeGreaterThanOrEqual(1);
  });

  test("drive example is a winnable, ordered checkpoint race", () => {
    const doc = ARCHETYPE_EXAMPLES.drive;
    expect(doc.meta.mode).toBe("drive");
    expect(requiresWinPath(doc)).toBe(true);
    expect(hasWinPath(doc)).toBe(true);

    const player = doc.entities.find((entity) => entity.kind === "player");
    expect(player?.props?.vehicle).toBe(true);
    expect(typeof player?.props?.maxSpeed).toBe("number");

    const indexes = integerCheckpoints(doc);
    expect(indexes.length).toBeGreaterThanOrEqual(3);
    expect(indexes).toEqual(indexes.map((_value, position) => position));

    const collect = doc.objectives.find((objective) => objective.type === "collect");
    expect(collect?.count).toBe(indexes.length);
    expect(doc.objectives.some((objective) => objective.type === "timeLimit")).toBe(true);
    expect(doc.scratch.lap).toBe(0);

    const winRule = doc.rules.find((rule) =>
      rule.then.some((action) => action.type === "win")
    );
    expect(winRule?.on.event).toBe("objectiveComplete");
    const gated = doc.rules.filter((rule) => {
      if (rule.on.event !== "playerEnter") return false;
      if (!rule.if || rule.if.op !== "==") return false;
      const left = rule.if.left;
      return typeof left === "object" && left !== null && "var" in left && left.var === "cp";
    });
    expect(gated.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildGenerationPrompt kit catalogs", () => {
  test("inspect prompt teaches parts, labels, panels and no win path", () => {
    const text = buildGenerationPrompt("a 3D PCB I can inspect", "inspect");
    expect(text).toContain('"mode": "inspect"');
    expect(text).toContain('"parts"');
    expect(text).toContain('"label"');
    expect(text).toContain("showPanel");
    expect(text).toContain("setColor");
    expect(text).toContain("cameraFocus");
    expect(text).toContain("hidePanel");
    expect(text).toContain('"click"');
    expect(text).toContain('"texture": "circuit"');
    expect(text).toContain('"chip"');
    expect(text).toContain('"header"');
    expect(text).toContain('"capacitor"');
    expect(text).toContain('"led"');
    expect(text).toContain('"hole"');
    expect(text).toContain('"flat": true');
    expect(text).toContain("silkscreen");
    expect(text).toContain("rows and columns");
    expect(text).toContain("camera auto-fits");
    expect(text).toContain("Seat components on the mask");
    expect(text).toContain("Budget: at most 14 entities and 8 rules");
    expect(text).not.toContain("The game must be winnable through its rules alone.");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.inspect, null, 2));
  });

  test("walkthrough prompt teaches solid walls, slide doors and variation", () => {
    const text = buildGenerationPrompt("a house I can walk through", "walkthrough");
    expect(text).toContain('"mode": "walkthrough"');
    expect(text).toContain('"solid": true');
    expect(text).toContain("per entity AABB, never per part");
    expect(text).toContain("door-width gap");
    expect(text).toContain("MUST OVERLAP at every corner");
    expect(text).toContain("zero-width corner seam");
    expect(text).toContain('"props": { "door": true }');
    expect(text).toContain('"kind":"slide"');
    expect(text).toContain("openDoor");
    expect(text).toContain("doorOpen");
    expect(text).toContain("lampOn");
    expect(text).toContain("setVisible");
    expect(text).toContain("Budget: at most 16 entities and 10 rules");
    expect(text).toContain("do not copy the few-shot document verbatim");
    expect(text).not.toContain("The game must be winnable through its rules alone.");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.walkthrough, null, 2));
  });

  test("every archetype prompt carries its loosened entity and rule budget", () => {
    const budgets: ReadonlyArray<readonly [KitArchetype, string]> = [
      ["inspect", "Budget: at most 14 entities and 8 rules"],
      ["walkthrough", "Budget: at most 16 entities and 10 rules"],
      ["drive", "Budget: at most 14 entities and 10 rules"],
      ["explore", "Budget: at most 14 entities and 6 rules"],
      ["collect-a-thon", "Budget: at most 14 entities and 8 rules"],
      ["puzzle-switch", "Budget: at most 14 entities and 8 rules"],
      ["platformer-lite", "Budget: at most 14 entities and 8 rules"],
      ["stealth-chase", "Budget: at most 14 entities and 8 rules"],
    ];
    for (const [archetype, budget] of budgets) {
      expect(buildGenerationPrompt("make something", archetype), archetype).toContain(
        budget
      );
    }
  });

  test("every prompt asks for readable JSON instead of terse output", () => {
    for (const archetype of KIT_ARCHETYPES) {
      const text = buildGenerationPrompt("make something", archetype);
      expect(text, archetype).toContain("Prefer readable, well-formed JSON");
      expect(text, archetype).not.toContain("Prefer terse JSON");
    }
  });

  test("drive prompt teaches vehicle props, ordered checkpoints and winnability", () => {
    const text = buildGenerationPrompt("a car racing game", "drive");
    expect(text).toContain('"mode": "drive"');
    expect(text).toContain('"props": { "vehicle": true');
    expect(text).toContain("checkpointIndex");
    expect(text).toContain("timeLimit");
    expect(text).toContain("The race must be winnable through its rules.");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.drive, null, 2));
    expect(text).not.toContain("MUST be an empty array: []");
  });

  test("game and explore prompts keep their existing requirements", () => {
    const collect = buildGenerationPrompt("collect gems", "collect-a-thon");
    expect(collect).toContain("The game must be winnable through its rules alone.");
    expect(collect).not.toContain("MUST be an empty array: []");

    const explore = buildGenerationPrompt("a quiet clearing", "explore");
    expect(explore).toContain("MUST be an empty array: []");
    expect(explore).not.toContain("The game must be winnable through its rules alone.");
    expect(explore).toContain("MUST NOT include");
  });
});

describe("generate over kit labels", () => {
  test("sends the kit prompt and parses a fenced kit document", async () => {
    const doc = ARCHETYPE_EXAMPLES.inspect;
    const llm = vi.fn<LlmCall>(
      async () => `Here:\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\``
    );
    const result = await generate("a 3D PCB I can inspect", "inspect", llm);
    expect(result).toEqual(doc);
    const sent = llm.mock.calls[0]?.[0] ?? "";
    expect(sent).toContain('"mode": "inspect"');
    expect(sent).toContain("a 3D PCB I can inspect");
  });
});

describe("eval-corpus mock kit coverage", () => {
  const entries: readonly CorpusEntry[] = [
    {
      id: "mock-inspect",
      prompt: "a 3D PCB I can click and inspect",
      archetype: "inspect",
      title: "Mock PCB",
    },
    {
      id: "mock-walkthrough",
      prompt: "a house I can walk through",
      archetype: "walkthrough",
      title: "Mock House",
    },
    {
      id: "mock-drive",
      prompt: "a car racing game",
      archetype: "drive",
      title: "Mock Race",
    },
  ];

  test("builds kit documents that pass the full evaluation harness", async () => {
    const outcomes = await evaluatePrompts(entries, { llm: createCorpusLlm(entries) });
    expect(outcomes.map((outcome) => outcome.archetype)).toEqual([
      "inspect",
      "walkthrough",
      "drive",
    ]);
    for (const outcome of outcomes) {
      expect(outcome.valid, outcome.id).toBe(true);
      expect(outcome.solvable, outcome.id).toBe(true);
      expect(outcome.error, outcome.id).toBeUndefined();
    }
  });
});
