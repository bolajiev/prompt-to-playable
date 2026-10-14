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

  test("inspect example is a labeled, clickable PCB assembly", () => {
    const doc = ARCHETYPE_EXAMPLES.inspect;
    expect(doc.meta.mode).toBe("inspect");
    expect(doc.objectives).toEqual([]);
    expect(requiresWinPath(doc)).toBe(false);
    const withParts = doc.entities.filter((entity) => (entity.parts?.length ?? 0) > 0);
    expect(withParts.length).toBeGreaterThanOrEqual(1);
    const labels = doc.entities.filter((entity) => entity.label !== undefined);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    const clickRules = doc.rules.filter((rule) => rule.on.event === "click");
    expect(clickRules.length).toBeGreaterThanOrEqual(1);
    const actionTypes = clickRules.flatMap((rule) => rule.then.map((action) => action.type));
    expect(actionTypes).toContain("showPanel");
    expect(actionTypes).toContain("setColor");
    expect(actionTypes).toContain("cameraFocus");
  });

  test("walkthrough example has a sliding door and a toggling lamp", () => {
    const doc = ARCHETYPE_EXAMPLES.walkthrough;
    expect(doc.meta.mode).toBe("walkthrough");
    expect(doc.objectives).toEqual([]);
    expect(requiresWinPath(doc)).toBe(false);

    const door = doc.entities.find((entity) => entity.id === "front-door");
    expect(door?.kind).toBe("interactable");
    expect(door?.props?.door).toBe(true);
    const doorRule = doc.rules.find((rule) => rule.on.entity === "front-door");
    expect(doorRule?.on.event).toBe("interact");
    const slide = doorRule?.then.find((action) => action.type === "animate");
    expect(slide?.type === "animate" && slide.kind).toBe("slide");
    expect(slide?.type === "animate" && Array.isArray(slide.to)).toBe(true);
    expect(doorRule?.then.some((action) => action.type === "openDoor")).toBe(true);

    const lamp = doc.entities.find((entity) => entity.id === "floor-lamp");
    expect(lamp?.kind).toBe("interactable");
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
    expect(text).toContain('"click"');
    expect(text).not.toContain("The game must be winnable through its rules alone.");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.inspect, null, 2));
  });

  test("walkthrough prompt teaches slide doors, interactables and no win path", () => {
    const text = buildGenerationPrompt("a house I can walk through", "walkthrough");
    expect(text).toContain('"mode": "walkthrough"');
    expect(text).toContain('"props": { "door": true }');
    expect(text).toContain('"kind":"slide"');
    expect(text).toContain("openDoor");
    expect(text).toContain("setVisible");
    expect(text).not.toContain("The game must be winnable through its rules alone.");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.walkthrough, null, 2));
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
