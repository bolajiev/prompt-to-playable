import { describe, expect, test } from "vitest";
import request from "supertest";
import type { GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { createApp, RouteError } from "../src/routes.js";
import type { EditResult } from "../src/routes.js";

function validDoc(): GameDoc {
  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Route Room", archetype: "puzzle-switch" },
    world: { bounds: [20, 10, 20] },
    entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
    objectives: [],
    rules: [],
    scratch: {},
  });
  if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
  return res.data;
}

describe("POST /generate", () => {
  test("returns 400 with structured error when prompt is missing", async () => {
    const res = await request(createApp()).post("/generate").send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "INVALID_REQUEST" });
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  test("returns 400 when prompt is not a string", async () => {
    const res = await request(createApp())
      .post("/generate")
      .send({ prompt: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_REQUEST");
  });

  test("returns 501 when generate handler is not wired", async () => {
    const res = await request(createApp())
      .post("/generate")
      .send({ prompt: "a tiny room" });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("NOT_IMPLEMENTED");
  });

  test("returns only validated JSON doc on success", async () => {
    const app = createApp({ generate: async () => validDoc() });
    const res = await request(app)
      .post("/generate")
      .send({ prompt: "a tiny room" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: "1.0.0", meta: { title: "Route Room" } });
  });

  test("returns 400 when the handler returns a non-conforming doc", async () => {
    const app = createApp({
      generate: async () =>
        ({ version: "1.0.0", meta: { title: "Bad", archetype: "racing" } }) as GameDoc,
    });
    const res = await request(app)
      .post("/generate")
      .send({ prompt: "anything" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("GENERATION_FAILED");
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  test("returns 400 with error/details when repair budget is exhausted", async () => {
    const app = createApp({
      generate: async () => {
        throw new RouteError("REPAIR_EXHAUSTED", "gave up after 2 retries", [
          "still invalid",
        ]);
      },
    });
    const res = await request(app)
      .post("/generate")
      .send({ prompt: "anything" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "REPAIR_EXHAUSTED", details: ["still invalid"] });
  });

  test("returns 404 with structured error for unknown routes", async () => {
    const res = await request(createApp()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  test("returns 400 BAD_REQUEST for a malformed raw JSON body", async () => {
    const res = await request(createApp())
      .post("/generate")
      .set("Content-Type", "application/json")
      .send('{"prompt": "unterminated');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BAD_REQUEST");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  test("returns 413 when the JSON body exceeds the size limit", async () => {
    const res = await request(createApp())
      .post("/generate")
      .send({ prompt: "x".repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("PAYLOAD_TOO_LARGE");
  });

  test("does not echo the thrown message in the 500 body", async () => {
    const app = createApp({
      generate: async () => {
        throw new Error("super secret internal detail");
      },
    });
    const res = await request(app).post("/generate").send({ prompt: "anything" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "INTERNAL_ERROR" });
    expect(JSON.stringify(res.body)).not.toContain("super secret");
  });

  test("returns 400 when a generated doc fails the route-level sanity gate", async () => {
    const doc = validDoc();
    const app = createApp({
      generate: async () => ({
        ...doc,
        objectives: [
          {
            id: "collect-gems",
            type: "collect" as const,
            target: "ghost-gem",
            progress: 0,
            status: "active" as const,
          },
        ],
      }),
    });
    const res = await request(app).post("/generate").send({ prompt: "anything" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("GENERATION_FAILED");
    expect(res.body.details.join("\n")).toContain("ghost-gem");
  });

  test("returns the GameDoc at the top level plus the agent trace", async () => {
    const doc = validDoc();
    const app = createApp({
      generate: async () => ({
        doc,
        steps: [
          { tool: "plan", status: "ok", detail: "kit: puzzle-switch", ms: 4 },
          { tool: "generate", status: "ok", detail: "generated 1 entities", ms: 900 },
          { tool: "simulate", status: "ok", detail: "simulated 3 checks", ms: 12 },
        ],
        repairs: 1,
      }),
    });
    const res = await request(app)
      .post("/generate")
      .send({ prompt: "a tiny room" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: "1.0.0",
      meta: { title: "Route Room" },
      agent: { repairs: 1 },
    });
    expect(res.body.agent.steps).toHaveLength(3);
    expect(res.body.agent.steps[0]).toEqual({
      tool: "plan",
      status: "ok",
      detail: "kit: puzzle-switch",
      ms: 4,
    });
  });

  test("legacy doc-only handlers still respond with an empty agent trace", async () => {
    const app = createApp({ generate: async () => validDoc() });
    const res = await request(app)
      .post("/generate")
      .send({ prompt: "a tiny room" });
    expect(res.status).toBe(200);
    expect(res.body.meta.title).toBe("Route Room");
    expect(res.body.agent).toEqual({ steps: [], repairs: 0 });
  });

  test("accepts an objective-less explore scene through the sanity gate", async () => {
    const res = validateGame({
      version: "1.0.0",
      meta: { title: "Quiet Scene", archetype: "explore" },
      world: { bounds: [24, 10, 24] },
      entities: [
        { id: "player", kind: "player", position: [0, 1, 0] },
        { id: "bench", kind: "prop", position: [4, 0.5, 3] },
      ],
      objectives: [],
      rules: [],
      scratch: {},
    });
    if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
    const app = createApp({ generate: async () => res.data as GameDoc });
    const response = await request(app)
      .post("/generate")
      .send({ prompt: "show me a quiet room" });
    expect(response.status).toBe(200);
    expect(response.body.meta.archetype).toBe("explore");
    expect(response.body.objectives).toEqual([]);
  });
});

describe("POST /edit", () => {
  test("returns 400 when game is missing", async () => {
    const res = await request(createApp()).post("/edit").send({ prompt: "make it bigger" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_REQUEST");
    expect(res.body.details.some((d: string) => d.includes("game"))).toBe(true);
  });

  test("returns 400 when game fails schema validation", async () => {
    const res = await request(createApp())
      .post("/edit")
      .send({ prompt: "nope", game: { version: "1.0.0" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_REQUEST");
  });

  test("returns 501 when edit handler is not wired", async () => {
    const res = await request(createApp())
      .post("/edit")
      .send({ prompt: "bigger", game: validDoc() });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("NOT_IMPLEMENTED");
  });

  test("returns patched validated doc plus the patch on success", async () => {
    const app = createApp({
      edit: async (prompt, game) => {
        expect(prompt).toBe("bigger");
        const doc = { ...game, meta: { ...game.meta, title: "Bigger Room" } };
        return { doc, patch: [{ op: "replace", path: "/meta/title", value: "Bigger Room" }] };
      },
    });
    const res = await request(app)
      .post("/edit")
      .send({ prompt: "bigger", game: validDoc() });
    expect(res.status).toBe(200);
    expect(res.body.doc.meta.title).toBe("Bigger Room");
    expect(res.body.patch).toEqual([
      { op: "replace", path: "/meta/title", value: "Bigger Room" },
    ]);
  });

  test("returns 400 when the handler returns an invalid JSON Patch", async () => {
    const app = createApp({
      edit: async (_prompt, game) =>
        ({
          doc: game,
          patch: [{ op: "frobnicate", path: "/meta/title", value: "x" }],
        }) as unknown as EditResult,
    });
    const res = await request(app)
      .post("/edit")
      .send({ prompt: "rename", game: validDoc() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("EDIT_FAILED");
    expect(res.body.details.join("\n")).toContain("unsupported op");
  });

  test("returns 400 when the patched doc fails validation", async () => {
    const app = createApp({
      edit: async (_prompt, game) => ({
        // strength the result: drop the player entity below schema minimum
        doc: { ...game, entities: [] } as GameDoc,
        patch: [{ op: "replace", path: "/entities", value: [] }],
      }),
    });
    const res = await request(app)
      .post("/edit")
      .send({ prompt: "break it", game: validDoc() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("EDIT_FAILED");
  });

  test("returns 400 when an edited doc fails the route-level sanity gate", async () => {
    const app = createApp({
      edit: async (_prompt, game) => ({
        doc: {
          ...game,
          objectives: [
            {
              id: "reach-gem",
              type: "reach" as const,
              target: "ghost-gem",
              progress: 0,
              status: "active" as const,
            },
          ],
        } as GameDoc,
        patch: [],
      }),
    });
    const res = await request(app)
      .post("/edit")
      .send({ prompt: "add an unreachable goal", game: validDoc() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("EDIT_FAILED");
    expect(res.body.details.join("\n")).toContain("ghost-gem");
  });
});