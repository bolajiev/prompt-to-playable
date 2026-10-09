import { describe, expect, test } from "vitest";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import type { GameEvent } from "../src/events.js";
import { updateObjectives } from "../src/objectives.js";
import { createState } from "../src/state.js";

function loadDoc(): GameDoc {
  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Objective Room", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
    objectives: [
      { id: "crystals", type: "collect", count: 3 },
      { id: "exit", type: "reach", target: "door" },
      { id: "guards", type: "avoid" },
      { id: "wave", type: "survive", time: 30 },
      { id: "timer", type: "timeLimit", time: 30 },
    ],
    rules: [],
    scratch: {},
  });
  if (!res.ok || !res.data) {
    throw new Error("doc failed schema validation");
  }
  return res.data;
}

function statusOf(doc: ReturnType<typeof createState>, id: string) {
  return doc.objectives.find((o) => o.id === id)?.status;
}

describe("updateObjectives", () => {
  test("collect progress increments and completes when count is reached", () => {
    const state = createState(loadDoc());
    const events: GameEvent[] = [
      { type: "objectiveProgress", objectiveId: "crystals", by: 2 },
    ];

    const partial = updateObjectives(state, events);
    const partialObj = partial.objectives.find((o) => o.id === "crystals");
    expect(partialObj?.progress).toBe(2);
    expect(partialObj?.status).toBe("active");

    const complete = updateObjectives(partial, [
      { type: "objectiveProgress", objectiveId: "crystals", by: 1 },
    ]);
    const completeObj = complete.objectives.find((o) => o.id === "crystals");
    expect(completeObj?.progress).toBe(3);
    expect(completeObj?.status).toBe("done");
  });

  test("does not overrun the target count on a big progress step", () => {
    const state = createState(loadDoc());
    const next = updateObjectives(state, [
      { type: "objectiveProgress", objectiveId: "crystals", by: 9 },
    ]);
    const obj = next.objectives.find((o) => o.id === "crystals");
    expect(obj?.progress).toBe(3);
    expect(obj?.status).toBe("done");
  });

  test("objectiveComplete marks an active objective done", () => {
    const state = createState(loadDoc());
    const next = updateObjectives(state, [
      { type: "objectiveComplete", objectiveId: "exit" },
    ]);
    expect(statusOf(next, "exit")).toBe("done");
  });

  test("ignores progress for already-done objectives", () => {
    const state = createState(loadDoc());
    const done = updateObjectives(state, [
      { type: "objectiveComplete", objectiveId: "exit" },
    ]);
    const next = updateObjectives(done, [
      { type: "objectiveProgress", objectiveId: "exit", by: 5 },
    ]);
    expect(statusOf(next, "exit")).toBe("done");
  });

  test("playerDeath fails avoid and survive objectives only", () => {
    const state = createState(loadDoc());
    const next = updateObjectives(state, [{ type: "playerDeath" }]);
    expect(statusOf(next, "guards")).toBe("failed");
    expect(statusOf(next, "wave")).toBe("failed");
    expect(statusOf(next, "crystals")).toBe("active");
    expect(statusOf(next, "exit")).toBe("active");
  });

  test("timeLimit objective fails once state time reaches the limit", () => {
    const state = createState(loadDoc());
    const before = updateObjectives({ ...state, time: 29 }, []);
    expect(statusOf(before, "timer")).toBe("active");

    const after = updateObjectives({ ...state, time: 30 }, []);
    expect(statusOf(after, "timer")).toBe("failed");
  });

  test("returns a new state without mutating the input", () => {
    const state = createState(loadDoc());
    const snapshot = JSON.stringify(state.objectives);
    const next = updateObjectives(state, [
      { type: "objectiveProgress", objectiveId: "crystals", by: 1 },
    ]);

    expect(next).not.toBe(state);
    expect(JSON.stringify(state.objectives)).toBe(snapshot);
    expect(
      state.objectives.find((o) => o.id === "crystals")?.progress
    ).toBe(0);
  });

  test("returns the same state when no objective changes", () => {
    const state = createState(loadDoc());
    const next = updateObjectives(state, [{ type: "tick" }]);
    expect(next).toBe(state);
  });
});
