import { describe, expect, test } from "vitest";
import { createEngine } from "@prompt-to-playable/engine";
import { validateGame } from "@prompt-to-playable/schema";
import type { GameDoc, Vec3 } from "@prompt-to-playable/schema";
import {
  EvalTargetError,
  assertTarget,
  buildDoc,
  createCorpusLlm,
  evaluatePrompts,
  loadCorpus,
  summarize,
  type CorpusEntry,
  type PromptOutcome,
} from "../scripts/eval-corpus.js";
import { createDefaultPipelineDeps, generateGame } from "../server/src/pipeline.js";
import { hasWinPath, requiresWinPath, sanityCheck } from "../server/src/sanity.js";

const COLLECT: CorpusEntry = {
  id: "smoke-collect",
  prompt: "collect 3 crystals while avoiding patrolling guards",
  archetype: "collect-a-thon",
  title: "Smoke Crystals",
};

const EXPLORE: CorpusEntry = {
  id: "smoke-explore",
  prompt: "a quiet forest clearing with a campfire at dusk",
  archetype: "explore",
  title: "Quiet Clearing",
};

async function generate(entry: CorpusEntry): Promise<GameDoc> {
  return generateGame(entry.prompt, createDefaultPipelineDeps(createCorpusLlm([entry])));
}

function teleportPlayer(state: ReturnType<ReturnType<typeof createEngine>["getState"]>, to: Vec3): void {
  const runtime = state.entityRuntime.player;
  if (runtime) runtime.position = [...to];
  const entity = state.entities.find((candidate) => candidate.kind === "player");
  if (entity) entity.position = [...to];
}

function outcome(valid: boolean, solvable: boolean): PromptOutcome {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    prompt: "p",
    archetype: "collect-a-thon",
    valid,
    solvable,
    repairs: 0,
  };
}

describe("e2e smoke — prompt to playable game", () => {
  test("mocked LLM produces a schema-valid, sane game through the full pipeline", async () => {
    const doc = await generate(COLLECT);
    expect(validateGame(doc).ok).toBe(true);
    expect(sanityCheck(doc).ok).toBe(true);
    expect(doc.meta.archetype).toBe("collect-a-thon");
    expect(doc.entities.some((entity) => entity.kind === "player")).toBe(true);
  });

  test("engine loads the generated game and ticks without errors", async () => {
    const doc = await generate(COLLECT);
    const engine = createEngine();
    expect(engine.load(doc).status).toBe("running");

    for (let i = 0; i < 120; i += 1) engine.step(16.666);

    const state = engine.getState();
    expect(state.status).toBe("running");
    expect(state.ticks).toBeGreaterThan(0);
    expect(state.time).toBeGreaterThan(0);
  });

  test("zone-driven rules progress objectives and fire the win condition", async () => {
    const doc = await generate(COLLECT);
    const engine = createEngine();
    engine.load(doc);

    const pickupZones = doc.entities.filter((entity) => entity.kind === "zone");
    expect(pickupZones.length).toBeGreaterThanOrEqual(3);

    for (const zone of pickupZones) {
      teleportPlayer(engine.getState(), zone.position);
      engine.step(20);
    }

    const state = engine.getState();
    const objective = state.objectives.find((item) => item.id === "collect-crystals");
    expect(objective?.status).toBe("done");
    expect(objective?.progress).toBe(doc.objectives[0]?.count);
    expect(state.status).toBe("won");
  });

  test("the bundled corpus meets the valid+solvable target end to end", async () => {
    const corpus = loadCorpus();
    const outcomes = await evaluatePrompts(corpus.entries);
    const summary = summarize(outcomes, corpus.target);
    expect(summary.passed).toBe(true);
    expect(() => assertTarget(summary)).not.toThrow();
  });
});

describe("explore scene — prompt to playable scene", () => {
  function mustExploreDoc(): GameDoc {
    const checked = validateGame(buildDoc(EXPLORE));
    if (!checked.ok || !checked.data) throw new Error("explore fixture fails validation");
    return checked.data;
  }

  test("the corpus harness accepts an explore scene without a win path", async () => {
    const outcomes = await evaluatePrompts([EXPLORE]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.archetype).toBe("explore");
    expect(outcomes[0]?.valid).toBe(true);
    expect(outcomes[0]?.solvable).toBe(true);
    expect(outcomes[0]?.error).toBeUndefined();
  });

  test("explore docs validate, pass sanity, and are exempt from the win path", () => {
    const doc = mustExploreDoc();
    expect(doc.objectives).toEqual([]);
    expect(doc.entities.some((entity) => entity.kind === "player")).toBe(true);
    expect(sanityCheck(doc).ok).toBe(true);
    expect(hasWinPath(doc)).toBe(false);
    expect(requiresWinPath(doc)).toBe(false);
  });

  test("the engine loads the explore scene and ticks without errors", () => {
    const engine = createEngine();
    expect(engine.load(mustExploreDoc()).status).toBe("running");

    for (let i = 0; i < 120; i += 1) engine.step(16.666);

    const state = engine.getState();
    expect(state.status).toBe("running");
    expect(state.objectives).toEqual([]);
    expect(state.ticks).toBeGreaterThan(0);
  });
});

describe("corpus eval gate", () => {
  test("counts valid, solvable, and valid+solvable outcomes", () => {
    const summary = summarize(
      [
        outcome(true, true),
        outcome(true, false),
        outcome(false, false),
        outcome(true, true),
      ],
      0.95
    );
    expect(summary.total).toBe(4);
    expect(summary.valid).toBe(3);
    expect(summary.solvable).toBe(2);
    expect(summary.usable).toBe(2);
    expect(summary.passed).toBe(false);
  });

  test("fails when below the 95% target", () => {
    const outcomes = Array.from({ length: 20 }, (_, i) => outcome(i < 18, i < 18));
    const summary = summarize(outcomes, 0.95);
    expect(summary.usablePct).toBeCloseTo(90, 5);
    expect(() => assertTarget(summary)).toThrow(EvalTargetError);
  });

  test("passes at exactly the 95% target", () => {
    const outcomes = Array.from({ length: 20 }, (_, i) => outcome(i < 19, i < 19));
    const summary = summarize(outcomes, 0.95);
    expect(summary.passed).toBe(true);
    expect(() => assertTarget(summary)).not.toThrow();
  });

  test("unknown prompts count as failures instead of being skipped", async () => {
    const unknown: CorpusEntry = {
      id: "unknown",
      prompt: "do something no corpus entry describes",
      archetype: "collect-a-thon",
      title: "Mystery",
    };
    const outcomes = await evaluatePrompts([unknown], {
      llm: createCorpusLlm([COLLECT]),
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.valid).toBe(false);
    expect(outcomes[0]?.solvable).toBe(false);
    expect(outcomes[0]?.repairs).toBeGreaterThan(0);
  });
});
