import { describe, expect, test, vi } from "vitest";
import request from "supertest";
import type { GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import {
  buildEditPrompt,
  createDefaultEditDeps,
  createEditPipeline,
  editGame,
  generatePatch,
  parseJsonPatch,
} from "../src/edit.js";
import type { EditPipelineDeps, PatchGeneratorFn } from "../src/edit.js";
import { RouteError, createApp } from "../src/routes.js";

type LlmCall = (prompt: string) => Promise<string>;

function mustDoc(raw: unknown): GameDoc {
  const res = validateGame(raw);
  if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
  return res.data;
}

function validDoc(): GameDoc {
  return mustDoc({
    version: "1.0.0",
    meta: { title: "Edit Room", archetype: "puzzle-switch" },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "goal", kind: "zone", position: [5, 1, 0] },
    ],
    objectives: [{ id: "reach-goal", type: "reach", target: "goal" }],
    rules: [
      {
        id: "win",
        on: { event: "objectiveComplete", objective: "reach-goal" },
        then: [{ type: "win" }],
      },
    ],
    scratch: {},
  });
}

function depsWith(generator: PatchGeneratorFn, maxRepairs?: number): EditPipelineDeps {
  return maxRepairs === undefined ? { generatePatch: generator } : { generatePatch: generator, maxRepairs };
}

describe("buildEditPrompt", () => {
  test("asks for an RFC 6902 JSON Patch only and embeds the doc and request", () => {
    const doc = validDoc();
    const text = buildEditPrompt({
      prompt: "add a second guard",
      doc,
      history: [{ prompt: "make it dark", patch: [] }],
    });
    expect(text).toContain("RFC 6902 JSON Patch");
    expect(text).toContain("add, remove, replace");
    expect(text).toContain("JSON Pointer");
    expect(text).toContain("add a second guard");
    expect(text).toContain(JSON.stringify(doc, null, 2));
    expect(text).toContain("make it dark");
  });

  test("includes repair feedback with attempt counters", () => {
    const text = buildEditPrompt({
      prompt: "add a guard",
      doc: validDoc(),
      errors: ["Cannot replace missing key at /meta/missing"],
      attempt: 2,
      maxRetries: 2,
    });
    expect(text).toContain("previous patch was rejected");
    expect(text).toContain("attempt 2 of 2");
    expect(text).toContain("Cannot replace missing key at /meta/missing");
  });
});

describe("parseJsonPatch", () => {
  test("extracts a patch from a fenced LLM response", () => {
    const patch = parseJsonPatch(
      'Sure:\\n```json\\n[{"op":"replace","path":"/meta/title","value":"New"}]\\n```'
    );
    expect(patch).toEqual([{ op: "replace", path: "/meta/title", value: "New" }]);
  });

  test("throws on responses with no array or an invalid patch", () => {
    expect(() => parseJsonPatch("no array here")).toThrow(/no JSON array/);
    expect(() => parseJsonPatch('[{"op":"replace","path":"/meta/title"}]')).toThrow(
      /must include a 'value'/
    );
  });
});

describe("generatePatch over a mocked LLM", () => {
  test("prompts the LLM and parses the returned patch", async () => {
    const doc = validDoc();
    const llm = vi.fn<LlmCall>(async () =>
      JSON.stringify([{ op: "replace", path: "/meta/title", value: "Renamed" }])
    );
    const patch = await generatePatch("rename it", doc, [], llm);
    expect(patch).toEqual([{ op: "replace", path: "/meta/title", value: "Renamed" }]);
    const sent = llm.mock.calls[0]?.[0] ?? "";
    expect(sent).toContain("rename it");
    expect(sent).toContain("JSON Patch");
  });
});

describe("editGame", () => {
  test("applies a valid patch and returns the validated doc plus the patch", async () => {
    const doc = validDoc();
    const patch = [{ op: "replace", path: "/meta/title", value: "Edited Room" }];
    const generator = vi.fn(async () => patch);

    const result = await editGame("rename it", doc, [], depsWith(generator));

    expect(result.doc.meta.title).toBe("Edited Room");
    expect(result.patch).toEqual(patch);
    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator.mock.calls[0]?.slice(0, 3)).toEqual(["rename it", doc, []]);
  });

  test("returns the Zod-validated doc, filling schema defaults", async () => {
    const doc = validDoc();
    const generator = vi.fn(async () => [
      { op: "add", path: "/entities/-", value: { id: "crate", kind: "prop", position: [2, 1, 2] } },
    ]);

    const result = await editGame("add a crate", doc, [], depsWith(generator));

    const crate = result.doc.entities.find((e) => e.id === "crate");
    expect(crate).toBeDefined();
    expect(crate?.tags).toEqual([]);
    expect(crate?.active).toBe(true);
  });

  test("does not mutate the input document", async () => {
    const doc = validDoc();
    const snapshot = JSON.parse(JSON.stringify(doc));
    const generator = vi.fn(async () => [
      { op: "replace", path: "/meta/title", value: "Changed" },
    ]);
    await editGame("rename", doc, [], depsWith(generator));
    expect(doc).toEqual(snapshot);
  });

  test("repairs an invalid patch shape, then applies the corrected patch", async () => {
    const doc = validDoc();
    const generator = vi.fn();
    generator
      .mockResolvedValueOnce({ op: "replace", path: "/meta/title", value: "oops" })
      .mockResolvedValueOnce([{ op: "replace", path: "/meta/title", value: "Fixed" }]);

    const result = await editGame("rename", doc, [], depsWith(generator));

    expect(result.doc.meta.title).toBe("Fixed");
    expect(generator).toHaveBeenCalledTimes(2);
    const context = generator.mock.calls[1]?.[3];
    expect(context?.attempt).toBe(1);
    expect(context?.errors.length).toBeGreaterThan(0);
  });

  test("repairs a patch that breaks schema validation", async () => {
    const doc = validDoc();
    const generator = vi.fn();
    generator
      .mockResolvedValueOnce([{ op: "replace", path: "/entities", value: [] }])
      .mockResolvedValueOnce([{ op: "replace", path: "/meta/title", value: "Recovered" }]);

    const result = await editGame("break it", doc, [], depsWith(generator));

    expect(result.doc.meta.title).toBe("Recovered");
    expect(generator).toHaveBeenCalledTimes(2);
    expect(generator.mock.calls[1]?.[3]?.errors.join("\n")).toContain("entities");
  });

  test("repairs a patch that breaks sanity invariants", async () => {
    const doc = validDoc();
    const generator = vi.fn();
    generator
      .mockResolvedValueOnce([
        { op: "replace", path: "/objectives/0/target", value: "ghost-door" },
      ])
      .mockResolvedValueOnce([
        { op: "add", path: "/objectives/0/description", value: "Reach the goal" },
      ]);

    const result = await editGame("move the goal", doc, [], depsWith(generator));

    expect(result.doc.objectives[0]?.target).toBe("goal");
    expect(generator).toHaveBeenCalledTimes(2);
    expect(generator.mock.calls[1]?.[3]?.errors.join("\n")).toContain("ghost-door");
  });

  test("repairs a patch that fails to apply (missing path)", async () => {
    const doc = validDoc();
    const generator = vi.fn();
    generator
      .mockResolvedValueOnce([{ op: "remove", path: "/scratch/missing" }])
      .mockResolvedValueOnce([{ op: "add", path: "/scratch/score", value: 1 }]);

    const result = await editGame("score", doc, [], depsWith(generator));

    expect(result.doc.scratch.score).toBe(1);
    expect(generator).toHaveBeenCalledTimes(2);
  });

  test("repairs when the generator throws", async () => {
    const doc = validDoc();
    const generator = vi.fn();
    generator
      .mockRejectedValueOnce(new Error("llm exploded"))
      .mockResolvedValueOnce([{ op: "replace", path: "/meta/title", value: "Survived" }]);

    const result = await editGame("rename", doc, [], depsWith(generator));

    expect(result.doc.meta.title).toBe("Survived");
    expect(generator).toHaveBeenCalledTimes(2);
  });

  test("throws RouteError EDIT_FAILED after exhausting 2 repairs", async () => {
    const doc = validDoc();
    const generator = vi.fn(async () => [{ op: "frobnicate", path: "/meta/title", value: 1 }]);

    const error = await editGame("rename", doc, [], depsWith(generator)).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(RouteError);
    const routeError = error as RouteError;
    expect(routeError.code).toBe("EDIT_FAILED");
    expect(routeError.details.join("\n")).toContain("unsupported op");
    expect(generator).toHaveBeenCalledTimes(3);
    expect(generator.mock.calls[0]?.[3]?.attempt).toBe(0);
    expect(generator.mock.calls[2]?.[3]?.attempt).toBe(2);
  });

  test("maxRepairs: 0 fails fast with a single attempt", async () => {
    const doc = validDoc();
    const generator = vi.fn(async () => [{ op: "nope", path: "/meta/title", value: 1 }]);

    await expect(
      editGame("rename", doc, [], depsWith(generator, 0))
    ).rejects.toMatchObject({ name: "RouteError", code: "EDIT_FAILED" });
    expect(generator).toHaveBeenCalledTimes(1);
  });

  test("an empty patch is valid and returns the document unchanged", async () => {
    const doc = validDoc();
    const generator = vi.fn(async () => []);

    const result = await editGame("do nothing", doc, [], depsWith(generator));

    expect(result.doc).toEqual(doc);
    expect(result.patch).toEqual([]);
  });
});

describe("createDefaultEditDeps end to end over a mocked LLM", () => {
  test("prompts, parses, applies, and validates a patch", async () => {
    const doc = validDoc();
    const llm = vi.fn<LlmCall>(async () =>
      JSON.stringify([{ op: "replace", path: "/meta/title", value: "End to End" }])
    );

    const result = await editGame("rename", doc, [], createDefaultEditDeps(llm));

    expect(result.doc.meta.title).toBe("End to End");
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

describe("POST /edit wiring through createEditPipeline", () => {
  test("returns the patched validated doc plus the patch", async () => {
    const generator = vi.fn(async () => [
      { op: "replace", path: "/meta/title", value: "Wired Room" },
    ]);
    const pipeline = createEditPipeline(depsWith(generator));
    const app = createApp({
      edit: (prompt, game, history) => pipeline.editGame(prompt, game, history),
    });

    const res = await request(app)
      .post("/edit")
      .send({ prompt: "rename it", game: validDoc() });

    expect(res.status).toBe(200);
    expect(res.body.doc.meta.title).toBe("Wired Room");
    expect(res.body.patch).toEqual([
      { op: "replace", path: "/meta/title", value: "Wired Room" },
    ]);
  });

  test("surfaces edit exhaustion as 400 with structured details", async () => {
    const pipeline = createEditPipeline(
      depsWith(async () => [{ op: "nope", path: "/meta/title", value: 1 }])
    );
    const app = createApp({
      edit: (prompt, game, history) => pipeline.editGame(prompt, game, history),
    });

    const res = await request(app)
      .post("/edit")
      .send({ prompt: "rename it", game: validDoc() });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("EDIT_FAILED");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });
});

describe("createEditPipeline", () => {
  test("exposes editGame with history defaulted to empty", async () => {
    const doc = validDoc();
    const generator = vi.fn(async () => [
      { op: "replace", path: "/meta/title", value: "Piped" },
    ]);
    const pipeline = createEditPipeline(depsWith(generator));

    const result = await pipeline.editGame("rename", doc);

    expect(result.doc.meta.title).toBe("Piped");
    expect(generator.mock.calls[0]?.[2]).toEqual([]);
  });
});
