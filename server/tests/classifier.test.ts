import { describe, expect, test, vi } from "vitest";
import {
  ARCHETYPES,
  DEFAULT_ARCHETYPE,
  KIT_ARCHETYPES,
  buildClassifierPrompt,
  classify,
  isDrivePrompt,
  isExplorePrompt,
  isInspectPrompt,
  isMachinePrompt,
  isWalkthroughPrompt,
  parseArchetype,
} from "../src/classifier.js";
import type { KitArchetype } from "../src/classifier.js";
import { classifyByKeywords } from "../../scripts/eval-corpus.js";

type LlmCall = (prompt: string) => Promise<string>;

const GAME_AND_EXPLORE: ReadonlyArray<readonly [string, KitArchetype]> = [
  ["collect 3 crystals while avoiding patrolling guards", "collect-a-thon"],
  ["puzzle room where I rotate beams to light 3 crystals", "collect-a-thon"],
  ["hop across floating platforms to reach the summit", "collect-a-thon"],
  ["sneak past a patrolling guard to the shadowed exit", "collect-a-thon"],
  ["a quiet forest clearing with a campfire at dusk", "explore"],
  ["a museum hall with marble statues", "explore"],
  ["show me a cozy room", "explore"],
];

const KIT_PROMPTS: ReadonlyArray<readonly [string, KitArchetype]> = [
  ["a 3D PCB I can click and inspect", "inspect"],
  ["an interactive circuit board viewer", "inspect"],
  ["a machine engine blueprint the user can study", "inspect"],
  ["a house I can walk through", "walkthrough"],
  ["walk through a cozy apartment interior", "walkthrough"],
  ["first-person room tour of a villa", "walkthrough"],
  ["a car racing game with 3 laps", "drive"],
  ["kart rally around a dirt track", "drive"],
  ["drive a rally car through the checkpoints", "drive"],
];

/**
 * Deterministic machine fallback coverage: every cue family in the brief plus
 * the deferred prompts that must NOT reach the machine kit.
 */
const MACHINE_PROMPTS: ReadonlyArray<readonly [string, KitArchetype]> = [
  [
    "a robotic arm with joint sliders I can control and clickable parts",
    "machine",
  ],
  ["an interactive robot arm with labeled joints", "machine"],
  ["a factory crane with a turret I can steer", "machine"],
  ["a conveyor with servo joints I can toggle", "machine"],
  ["a desktop robot with sliders that move its arm", "machine"],
  ["a gantry manipulator with joint controls", "machine"],
  ["a machine with servo arms I can control", "machine"],
  ["an interactive crane rig with labeled parts", "machine"],
  ["a robotic arm with a gripper toggle and joint sliders", "machine"],
];

describe("classifier label set", () => {
  test("allows the five schema archetypes plus the four kits", () => {
    expect(KIT_ARCHETYPES).toHaveLength(9);
    for (const archetype of ARCHETYPES) expect(KIT_ARCHETYPES).toContain(archetype);
    expect(KIT_ARCHETYPES).toContain("inspect");
    expect(KIT_ARCHETYPES).toContain("walkthrough");
    expect(KIT_ARCHETYPES).toContain("drive");
    expect(KIT_ARCHETYPES).toContain("machine");
  });

  test("classify returns the kit label the LLM chose", async () => {
    const cases: ReadonlyArray<readonly [string, KitArchetype]> = [
      ["a 3D PCB I can click and inspect", "inspect"],
      ["a house I can walk through", "walkthrough"],
      ["a car racing game", "drive"],
      ["a robotic arm with joint sliders", "machine"],
      ["collect 3 crystals", "collect-a-thon"],
    ];
    for (const [prompt, expected] of cases) {
      const llm = vi.fn<LlmCall>(async () => expected);
      await expect(classify(prompt, llm)).resolves.toBe(expected);
    }
  });

  test("parses kit labels case-insensitively, exactly and loosely", () => {
    expect(parseArchetype("Inspect")).toBe("inspect");
    expect(parseArchetype("WALKTHROUGH")).toBe("walkthrough");
    expect(parseArchetype('"drive"')).toBe("drive");
    expect(parseArchetype("Machine")).toBe("machine");
    expect(parseArchetype("I choose walkthrough here.")).toBe("walkthrough");
  });
});

describe("deterministic kit fallback", () => {
  test("maps kit prompts when the LLM answer cannot be parsed", async () => {
    const cases = [...KIT_PROMPTS, ...MACHINE_PROMPTS, ...GAME_AND_EXPLORE];
    for (const [prompt, expected] of cases) {
      const llm = vi.fn<LlmCall>(async () => "banana");
      await expect(classify(prompt, llm), prompt).resolves.toBe(expected);
    }
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(MACHINE_PROMPTS.length).toBeGreaterThanOrEqual(8);
  });

  test("parseArchetype uses the prompt fallback for an unparseable answer", () => {
    expect(parseArchetype("banana", "a 3D PCB I can click and inspect")).toBe("inspect");
    expect(parseArchetype("banana", "a house I can walk through")).toBe("walkthrough");
    expect(parseArchetype("banana", "a car racing game")).toBe("drive");
    expect(
      parseArchetype("banana", "a robotic arm with joint sliders I can control")
    ).toBe("machine");
    expect(parseArchetype("banana", "a museum hall with marble statues")).toBe("explore");
    expect(parseArchetype("banana", "collect gems")).toBe(DEFAULT_ARCHETYPE);
  });

  test("machine fallback is deterministic across repeated calls", () => {
    const prompt = "a robotic arm with joint sliders I can control";
    expect(parseArchetype("", prompt)).toBe(parseArchetype("", prompt));
    expect(parseArchetype("", prompt)).toBe("machine");
  });

  test("kit cues stay deterministic for repeated calls", () => {
    expect(parseArchetype("", "a 3D PCB viewer")).toBe(
      parseArchetype("", "a 3D PCB viewer")
    );
  });
});

describe("kit cue predicates", () => {
  test("inspect cues match technical objects but not houses or tracks", () => {
    expect(isInspectPrompt("a 3D PCB I can click and inspect")).toBe(true);
    expect(isInspectPrompt("a circuit board product viewer")).toBe(true);
    expect(isInspectPrompt("a machine engine gadget")).toBe(true);
    expect(isInspectPrompt("a house I can walk through")).toBe(false);
    expect(isInspectPrompt("a car racing game")).toBe(false);
  });

  test("drive cues match cars and tracks but not circuit boards", () => {
    expect(isDrivePrompt("a car racing game with 3 laps")).toBe(true);
    expect(isDrivePrompt("kart rally on a dirt track")).toBe(true);
    expect(isDrivePrompt("a circuit board viewer")).toBe(false);
  });

  test("walkthrough cues need movement language and no goal", () => {
    expect(isWalkthroughPrompt("a house I can walk through")).toBe(true);
    expect(isWalkthroughPrompt("walk through a cozy apartment interior")).toBe(true);
    expect(isWalkthroughPrompt("first-person room tour of a villa")).toBe(true);
    expect(isWalkthroughPrompt("walk through the museum")).toBe(true);
    expect(isWalkthroughPrompt("a museum hall with marble statues")).toBe(false);
    expect(isWalkthroughPrompt("walk through the house and find the key")).toBe(false);
    expect(isExplorePrompt("a museum hall with marble statues")).toBe(true);
  });

  test("machine cues match robot arms, cranes and servo rigs", () => {
    expect(
      isMachinePrompt("a robotic arm with joint sliders I can control and clickable parts")
    ).toBe(true);
    expect(isMachinePrompt("an interactive robot arm")).toBe(true);
    expect(isMachinePrompt("a factory crane with a turret")).toBe(true);
    expect(isMachinePrompt("a conveyor with servo joints")).toBe(true);
    expect(isMachinePrompt("a gantry manipulator with joint controls")).toBe(true);
    expect(isMachinePrompt("a machine with servo arms I can control")).toBe(true);
    expect(isMachinePrompt("a 3D model of a robotic arm")).toBe(true);
    expect(isInspectPrompt("a machine engine gadget")).toBe(true);
  });

  test("machine defers to inspect objects, goals, drives and walkthroughs", () => {
    expect(isMachinePrompt("a machine engine blueprint the user can study")).toBe(false);
    expect(isInspectPrompt("a machine engine blueprint the user can study")).toBe(true);
    expect(isMachinePrompt("a 3D PCB I can click and inspect")).toBe(false);
    expect(isMachinePrompt("a machine viewer product")).toBe(false);
    expect(isMachinePrompt("hide behind crates and escape the patrolling robot")).toBe(
      false
    );
    expect(isMachinePrompt("walk through a robot assembly hall")).toBe(false);
    expect(isMachinePrompt("a car racing machine on a track")).toBe(false);
    expect(isMachinePrompt("collect robot batteries")).toBe(false);
  });
});

describe("buildClassifierPrompt", () => {
  test("lists every allowed label and teaches the kits", () => {
    const text = buildClassifierPrompt("a 3D PCB I can click and inspect");
    for (const archetype of KIT_ARCHETYPES) {
      expect(text, archetype).toContain(`- ${archetype}`);
    }
    expect(text).toContain("PCB");
    expect(text).toContain("walk through");
    expect(text).toContain("racing");
    expect(text).toContain("Few-shot examples:");
    expect(text).toContain('"a 3D PCB I can click and inspect" -> inspect');
    expect(text).toContain('"a house I can walk through" -> walkthrough');
    expect(text).toContain('"a car racing game with 3 laps" -> drive');
    expect(text).toContain(
      '"a robotic arm with joint sliders I can control" -> machine'
    );
    expect(text).toContain("robot or robotic arm");
    expect(text).toContain("a 3D PCB I can click and inspect");
  });
});

describe("eval-corpus keyword fallback", () => {
  test("maps kit and legacy prompts without breaking the corpus", () => {
    expect(classifyByKeywords("a 3D PCB viewer")).toBe("inspect");
    expect(classifyByKeywords("a house I can walk through")).toBe("walkthrough");
    expect(classifyByKeywords("an apartment interior tour")).toBe("walkthrough");
    expect(classifyByKeywords("a car racing game")).toBe("drive");
    expect(
      classifyByKeywords("a robotic arm with joint sliders I can control")
    ).toBe("machine");
    expect(
      classifyByKeywords("hide behind crates and escape the patrolling robot")
    ).toBe("stealth-chase");
    expect(classifyByKeywords("walk through a robot assembly hall")).toBe(
      "walkthrough"
    );
    expect(classifyByKeywords("gather all five glowing orbs in a courtyard")).toBe(
      "collect-a-thon"
    );
    expect(classifyByKeywords("sneak past a patrolling guard to the shadowed exit")).toBe(
      "stealth-chase"
    );
    expect(classifyByKeywords("a quiet forest clearing with a campfire at dusk")).toBe(
      "explore"
    );
    expect(classifyByKeywords("a museum hall with marble statues")).toBe("explore");
  });
});
