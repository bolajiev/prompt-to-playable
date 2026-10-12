import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createEngine } from "@prompt-to-playable/engine";
import type { GameDoc, Vec3 } from "@prompt-to-playable/schema";
import { steerTo } from "./helpers/steer.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export const TICK_BUDGET = 3000;

type PlayableArchetype = "collect-a-thon" | "puzzle-switch";

interface EligibleFixture {
  file: string;
  archetype: PlayableArchetype;
}

/**
 * Fixtures auto-played by pure input steering. Excluded (out of scope by
 * archetype, not by failed steering):
 * - live-crystals-guard.json (stealth-chase): lose-on-enemyContact needs
 *   reactive avoidance, not target-seeking, and the brief restricts the set to
 *   collect-a-thon | puzzle-switch.
 * - live-crystals-guard-edit.json (stealth-chase): same reason.
 * No collect-a-thon / puzzle-switch fixture is excluded: all three auto-win.
 * A fixture that fails three steering attempts must be removed from this list
 * with its reason added here rather than left silently failing.
 */
const FIXTURES: EligibleFixture[] = [
  { file: "live-open-collect.json", archetype: "collect-a-thon" },
  { file: "live-open-puzzle.json", archetype: "puzzle-switch" },
  { file: "live-puzzle-beams.json", archetype: "puzzle-switch" },
];

interface SteeringTarget {
  id: string;
  position: Vec3;
}

interface ObjectiveSteeringPlan {
  objectiveId: string;
  type: "collect" | "activate";
  targets: SteeringTarget[];
}

function loadFixture(file: string): GameDoc {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as GameDoc;
}

/**
 * Resolve collect/activate objectives into ordered steering targets from the
 * fixture document. Other objective types (reach, avoid, survive, timeLimit)
 * are not present in the live fixture set and are intentionally skipped.
 */
function planSteering(doc: GameDoc): ObjectiveSteeringPlan[] {
  const positionById = new Map<string, Vec3>(
    doc.entities.map((entity) => [entity.id, entity.position])
  );
  const plans: ObjectiveSteeringPlan[] = [];

  for (const objective of doc.objectives) {
    if (objective.type !== "collect" && objective.type !== "activate") continue;
    const ids = objective.targets ?? (objective.target ? [objective.target] : []);
    if (ids.length === 0) continue;

    plans.push({
      objectiveId: objective.id,
      type: objective.type,
      targets: ids.map((id) => {
        const position = positionById.get(id);
        if (!position) {
          throw new Error(
            `objective ${objective.id} references unknown entity "${id}"`
          );
        }
        return { id, position };
      }),
    });
  }

  return plans;
}

describe("deterministic input-only playtest", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.file} (${fixture.archetype}) is won within ${TICK_BUDGET} ticks`, () => {
      const doc = loadFixture(fixture.file);
      const engine = createEngine();
      engine.load(doc);

      const plans = planSteering(doc);
      expect(plans.length).toBeGreaterThan(0);

      for (const plan of plans) {
        for (const target of plan.targets) {
          if (engine.getState().status !== "running") break;

          const remaining = TICK_BUDGET - engine.getState().ticks;
          expect(remaining).toBeGreaterThan(0);

          const reached = steerTo(engine, target.position, remaining);
          expect({
            fixture: fixture.file,
            objective: plan.objectiveId,
            target: target.id,
            reached,
          }).toEqual({
            fixture: fixture.file,
            objective: plan.objectiveId,
            target: target.id,
            reached: true,
          });
        }
      }

      const state = engine.getState();
      expect(state.status).toBe("won");
      expect(state.ticks).toBeLessThanOrEqual(TICK_BUDGET);
    });
  }

  test("the auto-play set covers both required archetypes", () => {
    const archetypes = new Set(FIXTURES.map((fixture) => fixture.archetype));
    expect(FIXTURES.length).toBeGreaterThanOrEqual(2);
    expect(archetypes.has("collect-a-thon")).toBe(true);
    expect(archetypes.has("puzzle-switch")).toBe(true);
  });

  test("every eligible fixture is either played or explicitly excluded", () => {
    const liveFiles = readdirSync(FIXTURE_DIR).filter(
      (file) => file.startsWith("live-") && file.endsWith(".json")
    );

    for (const file of liveFiles) {
      const { archetype } = loadFixture(file).meta;
      if (archetype !== "collect-a-thon" && archetype !== "puzzle-switch") continue;
      const played = FIXTURES.some((fixture) => fixture.file === file);
      expect({ file, archetype, played }).toEqual({ file, archetype, played: true });
    }
  });
});
