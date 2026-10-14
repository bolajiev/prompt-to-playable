import { describe, expect, test, vi } from "vitest";
import request from "supertest";
import type { Archetype, GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import {
  ARCHETYPES,
  DEFAULT_ARCHETYPE,
  buildClassifierPrompt,
  classify,
  isExplorePrompt,
  parseArchetype,
} from "../src/classifier.js";
import {
  ARCHETYPE_EXAMPLES,
  buildGenerationPrompt,
  generate,
  parseGameDoc,
} from "../src/generator.js";
import {
  createDefaultPipelineDeps,
  createGenerationPipeline,
  generateGame,
} from "../src/pipeline.js";
import type { GenerationPipelineDeps } from "../src/pipeline.js";
import { RouteError, createApp } from "../src/routes.js";
import { sanityCheck } from "../src/sanity.js";

type LlmCall = (prompt: string) => Promise<string>;

function mustDoc(raw: unknown): GameDoc {
  const res = validateGame(raw);
  if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
  return res.data;
}

function validDoc(): GameDoc {
  return mustDoc({
    version: "1.0.0",
    meta: { title: "Mock Chamber", archetype: "puzzle-switch" },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "switch-a", kind: "interactable", position: [3, 1, 0] },
      { id: "door", kind: "exitDoor", position: [6, 1, 0] },
    ],
    objectives: [{ id: "open-exit", type: "activate", target: "switch-a" }],
    rules: [
      {
        id: "switch-opens-door",
        on: { event: "interact", entity: "switch-a" },
        then: [
          { type: "openDoor", entity: "door" },
          { type: "objectiveProgress", objective: "open-exit" },
        ],
      },
      {
        id: "done-wins",
        on: { event: "objectiveComplete", objective: "open-exit" },
        then: [{ type: "win" }],
      },
    ],
    scratch: {},
  });
}

function invalidDoc(): unknown {
  return {
    version: "1.0.0",
    meta: { title: "Bad", archetype: "racing" },
    world: { bounds: [20, 10, 20] },
    entities: [],
    objectives: [],
    rules: [],
    scratch: {},
  };
}

function sanityBrokenDoc(): GameDoc {
  const doc = validDoc();
  doc.objectives = [{ id: "open-exit", type: "reach", target: "ghost-door" }];
  return doc;
}

function neverRepairer(): never {
  throw new Error("repairer must not be called");
}

describe("classify", () => {
  test("returns the archetype returned by the LLM, constrained to the enum", async () => {
    const llm = vi.fn<LlmCall>(async () => "  puzzle-switch\n");
    const archetype = await classify("a room with a locked door and a switch", llm);
    expect(archetype).toBe("puzzle-switch");
    expect(llm).toHaveBeenCalledTimes(1);
    const sent = llm.mock.calls[0]?.[0] ?? "";
    for (const allowed of ARCHETYPES) expect(sent).toContain(allowed);
    expect(sent).toContain("a room with a locked door and a switch");
    expect(sent).toContain("ONLY the archetype string");
  });

  test("extracts an archetype from conversational output", async () => {
    const llm = vi.fn<LlmCall>(async () => "I'd say this is a **stealth-chase** game!");
    await expect(classify("sneak past a guard", llm)).resolves.toBe("stealth-chase");
  });

  test("falls back to collect-a-thon for unclear but non-empty output", async () => {
    await expect(classify("prompt", async () => "banana")).resolves.toBe(DEFAULT_ARCHETYPE);
    expect(parseArchetype("   ")).toBe(DEFAULT_ARCHETYPE);
  });

  test("matches exact enum values case-insensitively", () => {
    expect(parseArchetype("Platformer-Lite")).toBe("platformer-lite");
    expect(parseArchetype("PLATFORMERLITE")).toBe("platformer-lite");
    expect(parseArchetype('"collect-a-thon"')).toBe("collect-a-thon");
  });

  test("buildClassifierPrompt lists the allowed archetypes", () => {
    const text = buildClassifierPrompt("a chase through a market");
    expect(text).toContain("collect-a-thon");
    expect(text).toContain("stealth-chase");
    expect(text).toContain("a chase through a market");
  });
});

describe("generator", () => {
  test("parses structured JSON out of a fenced LLM response", async () => {
    const doc = validDoc();
    const llm = vi.fn<LlmCall>(async () => `Here you go:\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\``);
    const result = await generate("a puzzle room", "puzzle-switch", llm);
    expect(result).toEqual(doc);
    const sent = llm.mock.calls[0]?.[0] ?? "";
    expect(sent).toContain('"archetype": "puzzle-switch"');
    expect(sent).toContain("a puzzle room");
  });

  test("throws when the response contains no JSON object", async () => {
    await expect(generate("x", "collect-a-thon", async () => "no json here")).rejects.toThrow(
      /no JSON object/
    );
  });

  test("parseGameDoc rejects malformed JSON with a structured message", () => {
    expect(() => parseGameDoc('{"version": }')).toThrow(/not valid JSON/);
  });

  test("every archetype example is schema-valid and includes required sections", () => {
    for (const archetype of ARCHETYPES) {
      const example = ARCHETYPE_EXAMPLES[archetype];
      const res = validateGame(example);
      expect(res.ok, `example for ${archetype} must validate`).toBe(true);
      expect(example.version).toBe("1.0.0");
      expect(example.meta.archetype).toBe(archetype);
      expect(Array.isArray(example.entities)).toBe(true);
      expect(Array.isArray(example.objectives)).toBe(true);
      expect(Array.isArray(example.rules)).toBe(true);
      expect(typeof example.scratch).toBe("object");
      expect(example.world.bounds.length).toBe(3);
    }
  });

  test("buildGenerationPrompt embeds the matching few-shot example", () => {
    const text = buildGenerationPrompt("collect gems in a cave", "collect-a-thon");
    expect(text).toContain('"archetype": "collect-a-thon"');
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES["collect-a-thon"], null, 2));
    expect(text).toContain("collect gems in a cave");
  });
});

describe("explore archetype", () => {
  const gameCases: ReadonlyArray<readonly [string, Archetype]> = [
    ["a room where I collect 3 glowing crystals while avoiding one guard", "collect-a-thon"],
    ["puzzle room: activate three switches to open the exit", "puzzle-switch"],
    ["a platforming course with moving hazards to reach the door", "platformer-lite"],
    ["sneak past patrolling guards to the exit", "stealth-chase"],
  ];

  const exploreCases: readonly string[] = [
    "a quiet forest clearing with a campfire at dusk",
    "a museum hall with marble statues",
    "a neon city street at night",
    "show me a cozy room",
  ];

  test("classifies goal prompts into the four game archetypes", async () => {
    for (const [prompt, expected] of gameCases) {
      const llm = vi.fn<LlmCall>(async () => expected);
      await expect(classify(prompt, llm)).resolves.toBe(expected);
    }
  });

  test("classifies scene prompts as explore", async () => {
    for (const prompt of exploreCases) {
      const llm = vi.fn<LlmCall>(async () => "explore");
      await expect(classify(prompt, llm)).resolves.toBe("explore");
    }
  });

  test("deterministic fallback maps scene prompts to explore", async () => {
    for (const prompt of exploreCases) {
      const llm = vi.fn<LlmCall>(async () => "banana");
      await expect(classify(prompt, llm)).resolves.toBe("explore");
    }
    await expect(classify("sneak past a guard", async () => "banana")).resolves.toBe(
      DEFAULT_ARCHETYPE
    );
    expect(parseArchetype("banana", "a quiet forest clearing at dusk")).toBe("explore");
  });

  test("isExplorePrompt separates scenes from goal prompts", () => {
    for (const prompt of exploreCases) {
      expect(isExplorePrompt(prompt), prompt).toBe(true);
    }
    for (const [prompt] of gameCases) {
      expect(isExplorePrompt(prompt), prompt).toBe(false);
    }
  });

  test("buildClassifierPrompt teaches the explore choice", () => {
    const text = buildClassifierPrompt("a quiet forest clearing with a campfire at dusk");
    expect(text).toContain("- explore");
    expect(text).toContain('choose "explore"');
    expect(text).toContain("a quiet forest clearing with a campfire at dusk");
  });

  test("explore few-shot is a zero-objective zone-free scene that passes sanity", () => {
    const explore = ARCHETYPE_EXAMPLES.explore;
    expect(explore.meta.archetype).toBe("explore");
    expect(explore.objectives).toEqual([]);
    expect(explore.entities.some((entity) => entity.kind === "zone")).toBe(false);
    expect(explore.entities.some((entity) => entity.kind === "prop")).toBe(true);
    expect(explore.entities.some((entity) => entity.kind === "interactable")).toBe(true);
    expect(sanityCheck(explore).ok).toBe(true);
  });

  test("explore few-shot props use the render shape vocabulary", () => {
    const shapeVocabulary = [
      "tree",
      "rock",
      "campfire",
      "pillar",
      "statue",
      "lamp",
      "table",
      "flower",
      "building",
    ];
    expect(validateGame(ARCHETYPE_EXAMPLES.explore).ok).toBe(true);
    const props = ARCHETYPE_EXAMPLES.explore.entities.filter(
      (entity) => entity.kind === "prop"
    );
    expect(props.length).toBeGreaterThanOrEqual(2);
    for (const entity of props) {
      const shape = entity.props?.shape;
      expect(typeof shape, entity.id).toBe("string");
      expect(shapeVocabulary, entity.id).toContain(shape);
    }
    expect(props.some((entity) => entity.props?.shape === "campfire")).toBe(true);
    expect(props.some((entity) => entity.props?.shape === "tree")).toBe(true);
  });

  test("explore generation prompt teaches the prop shape vocabulary", () => {
    const text = buildGenerationPrompt(
      "a quiet forest clearing with a campfire at dusk",
      "explore"
    );
    expect(text).toContain('"shape"');
    for (const shape of [
      "tree",
      "rock",
      "campfire",
      "pillar",
      "statue",
      "lamp",
      "table",
      "flower",
      "building",
    ]) {
      expect(text, shape).toContain(shape);
    }
  });

  test("explore generation prompt requires empty objectives and no win path", () => {
    const text = buildGenerationPrompt(
      "a quiet forest clearing with a campfire at dusk",
      "explore"
    );
    expect(text).toContain('"explore" archetype');
    expect(text).toContain("MUST be an empty array: []");
    expect(text).not.toContain("The game must be winnable through its rules alone.");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.explore, null, 2));
  });

  test("explore generation prompt forbids zone entities", () => {
    const text = buildGenerationPrompt(
      "a quiet forest clearing with a campfire at dusk",
      "explore"
    );
    expect(text).toContain("NO trigger zones");
    expect(text).toContain('MUST NOT include "zone" entities');
    expect(text).not.toContain('"kind": "zone"');
  });

  test("game generation prompt keeps the winnability requirement", () => {
    const text = buildGenerationPrompt("collect gems in a cave", "collect-a-thon");
    expect(text).toContain("The game must be winnable through its rules alone.");
    expect(text).not.toContain("MUST be an empty array: []");
    expect(text).toContain('trigger zone (kind "zone")');
  });
});

describe("generateGame — pipeline", () => {
  test("returns the generated doc when it is valid and sane on the first try", async () => {
    const doc = validDoc();
    const classifier = vi.fn(async (_prompt: string): Promise<Archetype> => "puzzle-switch");
    const generator = vi.fn(async (_prompt: string, _archetype: Archetype) => doc);
    const repairer = vi.fn(neverRepairer);

    const result = await generateGame("a puzzle room", { classifier, generator, repairer });

    expect(result).toEqual(doc);
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(classifier).toHaveBeenCalledWith("a puzzle room");
    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator).toHaveBeenCalledWith("a puzzle room", "puzzle-switch");
    expect(repairer).not.toHaveBeenCalled();
  });

  test("a failing classifier surfaces as RouteError GENERATION_FAILED", async () => {
    const error = await generateGame("a puzzle room", {
      classifier: async () => {
        throw new Error("LLM request failed with status 503");
      },
      generator: async () => validDoc(),
      repairer: neverRepairer,
    }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(RouteError);
    const routeError = error as RouteError;
    expect(routeError.code).toBe("GENERATION_FAILED");
    expect(routeError.details.join("\n")).toContain("503");
  });

  test("an invalid doc triggers one repair that returns the fixed doc", async () => {
    const broken = invalidDoc();
    const fixed = validDoc();
    const repairer = vi.fn(async () => fixed);

    const result = await generateGame("a puzzle room", {
      classifier: async () => "puzzle-switch",
      generator: async () => broken,
      repairer,
    });

    expect(result).toEqual(fixed);
    expect(repairer).toHaveBeenCalledTimes(1);
    const [repairedDoc, errors, attempt] = repairer.mock.calls[0] ?? [];
    expect(repairedDoc).toBe(broken);
    expect(attempt).toBe(1);
    expect(errors.some((e: unknown) => typeof e !== "string" && e.path.includes("meta.archetype"))).toBe(
      true
    );
  });

  test("a schema-valid doc that fails sanity triggers repair", async () => {
    const repairer = vi.fn(async () => validDoc());

    const result = await generateGame("a puzzle room", {
      classifier: async () => "puzzle-switch",
      generator: async () => sanityBrokenDoc(),
      repairer,
    });

    expect(result).toEqual(validDoc());
    expect(repairer).toHaveBeenCalledTimes(1);
    const [, errors] = repairer.mock.calls[0] ?? [];
    expect(
      errors.some((e: unknown) => typeof e !== "string" && e.message.includes("ghost-door"))
    ).toBe(true);
  });

  test("throws RouteError REPAIR_EXHAUSTED with structured details after 2 repairs", async () => {
    const generator = vi.fn(async () => invalidDoc());
    const repairer = vi.fn(async () => invalidDoc());

    const error = await generateGame("broken everything", {
      classifier: async () => "collect-a-thon",
      generator,
      repairer,
    }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(RouteError);
    const routeError = error as RouteError;
    expect(routeError.code).toBe("REPAIR_EXHAUSTED");
    expect(routeError.details.length).toBeGreaterThan(0);
    expect(routeError.details.join("\n")).toContain("meta.archetype");
    expect(repairer).toHaveBeenCalledTimes(2);
    expect(repairer.mock.calls[0]?.[2]).toBe(1);
    expect(repairer.mock.calls[1]?.[2]).toBe(2);
  });

  test("a thrown repair counts against the shared budget of 2", async () => {
    const repairer = vi.fn(async () => {
      throw new Error("llm exploded");
    });

    const error = await generateGame("broken", {
      classifier: async () => "collect-a-thon",
      generator: async () => invalidDoc(),
      repairer,
    }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(RouteError);
    const routeError = error as RouteError;
    expect(routeError.code).toBe("REPAIR_EXHAUSTED");
    expect(repairer).toHaveBeenCalledTimes(2);
    expect(routeError.details.join("\n")).toContain("llm exploded");
  });

  test("unparseable generator output is repairable", async () => {
    const repairer = vi.fn(async () => validDoc());

    const result = await generateGame("go", {
      classifier: async () => "puzzle-switch",
      generator: async () => {
        throw new Error("generator response was not valid JSON");
      },
      repairer,
    });

    expect(result).toEqual(validDoc());
    expect(repairer).toHaveBeenCalledTimes(1);
  });

  test("maxRepairs: 0 fails fast without calling the repairer", async () => {
    const repairer = vi.fn(neverRepairer);
    const deps: GenerationPipelineDeps = {
      classifier: async () => "collect-a-thon",
      generator: async () => invalidDoc(),
      repairer,
      maxRepairs: 0,
    };
    await expect(generateGame("broken", deps)).rejects.toMatchObject({
      name: "RouteError",
      code: "REPAIR_EXHAUSTED",
    });
    expect(repairer).not.toHaveBeenCalled();
  });

  test("createGenerationPipeline exposes generateGame", async () => {
    const doc = validDoc();
    const pipeline = createGenerationPipeline({
      classifier: async () => "puzzle-switch",
      generator: async () => doc,
      repairer: vi.fn(neverRepairer),
    });
    await expect(pipeline.generateGame("a puzzle room")).resolves.toEqual(doc);
  });
});

describe("generateGame — default deps over a mocked LLM", () => {
  test("classifies, generates, and returns a validated doc end to end", async () => {
    const doc = validDoc();
    const llm = vi.fn<LlmCall>(async (prompt: string) => {
      if (prompt.includes("ONLY the archetype string")) return "puzzle-switch";
      return JSON.stringify(doc);
    });

    const deps = createDefaultPipelineDeps(llm);
    const result = await generateGame("a room with a switch and a door", deps);

    expect(result).toEqual(doc);
    expect(llm).toHaveBeenCalledTimes(2);
  });
});

describe("POST /generate wiring", () => {
  function depsFixed(doc: GameDoc): GenerationPipelineDeps {
    return {
      classifier: async () => "puzzle-switch",
      generator: async () => doc,
      repairer: vi.fn(neverRepairer),
    };
  }

  test("returns only the validated game JSON", async () => {
    const doc = validDoc();
    const pipeline = createGenerationPipeline(depsFixed(doc));
    const app = createApp({ generate: (prompt) => pipeline.generateGame(prompt) });
    const res = await request(app).post("/generate").send({ prompt: "a puzzle room" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: "1.0.0",
      meta: { title: "Mock Chamber", archetype: "puzzle-switch" },
    });
  });

  test("repair exhaustion surfaces as 400 with structured details", async () => {
    const pipeline = createGenerationPipeline({
      classifier: async () => "collect-a-thon",
      generator: async () => invalidDoc(),
      repairer: async () => invalidDoc(),
    });
    const app = createApp({ generate: (prompt) => pipeline.generateGame(prompt) });
    const res = await request(app).post("/generate").send({ prompt: "broken" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("REPAIR_EXHAUSTED");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });
});
