import { describe, expect, test, vi } from "vitest";
import type { GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { runAgent } from "../src/agent.js";
import type { AgentDeps, AgentResult } from "../src/agent.js";
import { RouteError } from "../src/routes.js";
import type { SanityResult } from "../src/sanity.js";
import type { SimulateResult } from "../src/simulate.js";
import { validateDoc } from "../src/validate.js";

function mustDoc(raw: unknown): GameDoc {
  const res = validateGame(raw);
  if (!res.ok || !res.data) throw new Error("fixture fails schema validation");
  return res.data;
}

function validDoc(): GameDoc {
  return mustDoc({
    version: "1.0.0",
    meta: { title: "Agent Chamber", archetype: "puzzle-switch" },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "plate", kind: "zone", position: [4, 1, 0], size: [2, 2, 2] },
      { id: "door", kind: "exitDoor", position: [8, 1, 0] },
    ],
    objectives: [{ id: "open-exit", type: "activate", target: "plate", count: 1 }],
    rules: [
      {
        id: "plate-opens-door",
        on: { event: "playerEnter", zone: "plate" },
        then: [
          { type: "openDoor", entity: "door" },
          { type: "objectiveProgress", objective: "open-exit", by: 1 },
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

function passingSimulation(): SimulateResult {
  return {
    ok: true,
    checks: [
      { name: "load", ok: true, detail: "engine loaded" },
      { name: "ticks", ok: true, detail: "no NaN" },
    ],
    failures: [],
  };
}

function cleanSanity(): SanityResult {
  return { ok: true, errors: [] };
}

const NEVER = () => {
  throw new Error("tool must not be called");
};

describe("runAgent", () => {
  test("first try pass records the ordered tool chain with deterministic details", async () => {
    const doc = validDoc();
    let clock = 0;
    const deps: AgentDeps = {
      plan: vi.fn(async () => "puzzle-switch" as const),
      generate: vi.fn(async () => doc),
      repair: vi.fn(NEVER),
      validate: validateDoc,
      sanity: cleanSanity,
      simulate: passingSimulation,
      now: () => (clock += 5),
    };

    const result = await runAgent("a puzzle room", deps);

    expect(result.doc).toEqual(doc);
    expect(result.repairs).toBe(0);
    expect(result.steps.map((step) => step.tool)).toEqual([
      "plan",
      "generate",
      "validate",
      "sanity",
      "simulate",
      "finalize",
    ]);
    expect(result.steps.every((step) => step.status === "ok")).toBe(true);
    expect(result.steps.every((step) => step.ms === 5)).toBe(true);
    expect(result.steps[0]?.detail).toBe("kit: puzzle-switch");
    expect(result.steps[1]?.detail).toBe("generated 3 entities");
    expect(result.steps[4]?.detail).toBe("simulated 2 checks");
    expect(deps.repair).not.toHaveBeenCalled();
  });

  test("a plan failure surfaces as RouteError GENERATION_FAILED", async () => {
    const error = await runAgent("x", {
      plan: async () => {
        throw new Error("LLM request failed with status 503");
      },
      generate: async () => validDoc(),
      repair: NEVER,
    }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(RouteError);
    expect((error as RouteError).code).toBe("GENERATION_FAILED");
    expect((error as RouteError).details.join("\n")).toContain("503");
  });

  test("a simulate failure triggers a repair that receives the failure text, then passes", async () => {
    const doc = validDoc();
    const fixed = { ...doc, meta: { ...doc.meta, title: "Agent Chamber Fixed" } };
    let simulateCalls = 0;
    const simulate = vi.fn((): SimulateResult => {
      simulateCalls += 1;
      if (simulateCalls === 1) {
        return {
          ok: false,
          checks: [{ name: "win-path", ok: false, detail: "not won within 6000 ticks" }],
          failures: ["win-path: not won within 6000 ticks (open-exit 0/1)"],
        };
      }
      return passingSimulation();
    });
    const repair = vi.fn(async (_doc: unknown, errors: readonly unknown[]) => {
      expect(errors).toContain("win-path: not won within 6000 ticks (open-exit 0/1)");
      return fixed;
    });

    const result = await runAgent("a puzzle room", {
      plan: async () => "puzzle-switch",
      generate: async () => doc,
      repair,
      validate: validateDoc,
      sanity: cleanSanity,
      simulate,
    });

    expect(result.doc).toEqual(fixed);
    expect(result.repairs).toBe(1);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(result.steps.map((step) => `${step.tool}:${step.status}`)).toEqual([
      "plan:ok",
      "generate:ok",
      "validate:ok",
      "sanity:ok",
      "simulate:fail",
      "repair:ok",
      "validate:ok",
      "sanity:ok",
      "simulate:ok",
      "finalize:ok",
    ]);
    expect(result.steps[5]?.detail).toBe("simulate: fixed 1 issue (attempt 1)");
  });

  test("an invalid document triggers a validate repair", async () => {
    const doc = validDoc();
    const repair = vi.fn(async () => doc);

    const result = await runAgent("a puzzle room", {
      plan: async () => "puzzle-switch",
      generate: async () => ({ version: "1.0.0", meta: { title: "" } }),
      repair,
      validate: validateDoc,
      sanity: cleanSanity,
      simulate: passingSimulation,
    });

    expect(result.doc).toEqual(doc);
    expect(result.repairs).toBe(1);
    expect(result.steps.map((step) => `${step.tool}:${step.status}`)).toContain(
      "validate:fail"
    );
    expect(result.steps.map((step) => `${step.tool}:${step.status}`)).toContain(
      "repair:ok"
    );
  });

  test("budget exhaustion across stages raises RouteError REPAIR_EXHAUSTED with 3 repairs", async () => {
    const doc = validDoc();
    let validateCalls = 0;
    let sanityCalls = 0;
    const repair = vi.fn(async (_doc: unknown, _errors: readonly unknown[], attempt: number) => {
      return { ...doc, meta: { ...doc.meta, title: `Attempt ${attempt}` } };
    });

    const error = await runAgent("broken everything", {
      plan: async () => "puzzle-switch",
      generate: async () => doc,
      repair,
      validate: (value) => {
        validateCalls += 1;
        return validateCalls === 1
          ? { ok: false, issues: [{ path: "meta.title", message: "too short" }] }
          : validateDoc(value);
      },
      sanity: () => {
        sanityCalls += 1;
        return sanityCalls === 1
          ? {
              ok: false,
              errors: [{ code: "no-player", path: "entities", message: "no player" }],
            }
          : cleanSanity();
      },
      simulate: () => ({
        ok: false,
        checks: [{ name: "win-path", ok: false, detail: "not won" }],
        failures: ["win-path: not won within 6000 ticks"],
      }),
    }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(RouteError);
    const routeError = error as RouteError;
    expect(routeError.code).toBe("REPAIR_EXHAUSTED");
    expect(repair).toHaveBeenCalledTimes(3);
    expect(routeError.details.join("\n")).toContain("win-path: not won within 6000 ticks");
  });

  test("a per-stage cap of 2 stops a repeatedly failing validate stage", async () => {
    const repair = vi.fn(async () => ({ broken: true }));
    const error = await runAgent("broken", {
      plan: async () => "collect-a-thon",
      generate: async () => ({ broken: true }),
      repair,
      validate: () => ({
        ok: false,
        issues: [{ path: "(root)", message: "document is not a game" }],
      }),
      sanity: cleanSanity,
      simulate: passingSimulation,
    }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(RouteError);
    expect((error as RouteError).code).toBe("REPAIR_EXHAUSTED");
    expect(repair).toHaveBeenCalledTimes(2);
  });

  test("step details never contain the raw document JSON", async () => {
    const doc = validDoc();
    const result: AgentResult = await runAgent("a puzzle room", {
      plan: async () => "puzzle-switch",
      generate: async () => doc,
      repair: NEVER,
      validate: validateDoc,
      sanity: cleanSanity,
      simulate: passingSimulation,
    });

    const details = result.steps.map((step) => step.detail).join("\n");
    expect(details).not.toContain('"version"');
    expect(details).not.toContain("player");
  });
});
