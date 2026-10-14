import { describe, expect, test } from "vitest";
import {
  EXAMPLE_PROMPTS,
  Onboarding,
  type OnboardingElements,
} from "../src/ui/onboarding.js";
import { FakeDocument, FakeNode } from "./fakes.js";

describe("example prompt list", () => {
  test("covers each game archetype, an explore scene and each interactive kit", () => {
    expect(EXAMPLE_PROMPTS).toHaveLength(9);
    expect(new Set(EXAMPLE_PROMPTS.map((example) => example.kind)).size).toBe(
      EXAMPLE_PROMPTS.length
    );
    expect(EXAMPLE_PROMPTS.map((example) => example.prompt)).toEqual([
      "a room where I collect 3 glowing crystals while avoiding one guard",
      "puzzle room: activate three switches to open the exit",
      "a platforming course with moving hazards to reach the door",
      "sneak past patrolling guards to the exit",
      "a quiet forest clearing with a campfire at dusk",
      "a 3D PCB I can click and inspect",
      "a house I can walk through",
      "a car racing game",
      "a robot with animated arms",
    ]);
  });

  test("entries are unique and non-empty", () => {
    for (const example of EXAMPLE_PROMPTS) {
      expect(example.id.length).toBeGreaterThan(0);
      expect(example.kind.length).toBeGreaterThan(0);
      expect(example.label.length).toBeGreaterThan(0);
      expect(example.prompt.length).toBeGreaterThan(0);
    }
    expect(new Set(EXAMPLE_PROMPTS.map((example) => example.id)).size).toBe(
      EXAMPLE_PROMPTS.length
    );
    expect(new Set(EXAMPLE_PROMPTS.map((example) => example.label)).size).toBe(
      EXAMPLE_PROMPTS.length
    );
    expect(new Set(EXAMPLE_PROMPTS.map((example) => example.prompt)).size).toBe(
      EXAMPLE_PROMPTS.length
    );
  });
});

function createHarness() {
  const doc = new FakeDocument();
  const examples = new FakeNode(doc);
  const emptyState = new FakeNode(doc);
  const picks: string[] = [];
  const onboarding = new Onboarding(
    { examples, emptyState } as unknown as OnboardingElements,
    { onPick: (prompt) => picks.push(prompt) }
  );
  return { onboarding, examples, emptyState, picks };
}

describe("Onboarding", () => {
  test("renders one chip per example and forwards the full prompt on click", () => {
    const { examples, emptyState, picks } = createHarness();

    expect(examples.children).toHaveLength(EXAMPLE_PROMPTS.length);
    examples.children.forEach((chip, index) => {
      expect(chip.className).toBe("chip");
      expect(chip.type).toBe("button");
      expect(chip.textContent).toBe(EXAMPLE_PROMPTS[index].label);
      expect(chip.title).toBe(EXAMPLE_PROMPTS[index].prompt);
      expect(chip.dataset.exampleId).toBe(EXAMPLE_PROMPTS[index].id);
    });

    expect(emptyState.hidden).toBe(false);
    examples.children[4].click();
    expect(picks).toEqual(["a quiet forest clearing with a campfire at dusk"]);
    expect(emptyState.hidden).toBe(false);
  });

  test("hides the overlay while busy and once the first game has loaded", () => {
    const { onboarding, emptyState } = createHarness();

    onboarding.setBusy(true);
    expect(emptyState.hidden).toBe(true);
    onboarding.setBusy(false);
    expect(emptyState.hidden).toBe(false);

    onboarding.complete();
    expect(emptyState.hidden).toBe(true);
    onboarding.setBusy(true);
    onboarding.setBusy(false);
    expect(emptyState.hidden).toBe(true);
  });
});
