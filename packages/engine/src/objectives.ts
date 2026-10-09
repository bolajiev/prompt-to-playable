import type { Objective, ObjectiveType } from "@prompt-to-playable/schema";
import type { GameEvent } from "./events.js";
import type { GameState } from "./state.js";

const TIMED_FAIL: readonly ObjectiveType[] = ["timeLimit"];
const DEATH_FAIL: readonly ObjectiveType[] = ["avoid", "survive"];

function withStatus(
  objective: Objective,
  status: Objective["status"]
): Objective {
  return { ...objective, status };
}

function progressObjective(objective: Objective, by: number): Objective {
  if (objective.status !== "active") {
    return objective;
  }

  const nextProgress = Math.max(0, objective.progress + by);
  const target = objective.count;

  if (typeof target === "number" && nextProgress >= target) {
    return { ...objective, progress: target, status: "done" };
  }

  return { ...objective, progress: nextProgress };
}

function failForType(objectives: Objective[], types: readonly ObjectiveType[]) {
  return objectives.map((objective) =>
    objective.status === "active" && types.includes(objective.type)
      ? withStatus(objective, "failed")
      : objective
  );
}

export function updateObjectives(
  state: GameState,
  events: GameEvent[]
): GameState {
  let objectives = state.objectives.map((objective) => ({ ...objective }));
  let changed = false;

  for (const event of events) {
    if (event.type === "objectiveProgress") {
      const index = objectives.findIndex((o) => o.id === event.objectiveId);
      if (index === -1) continue;
      const updated = progressObjective(objectives[index], event.by);
      if (updated !== objectives[index]) {
        objectives[index] = updated;
        changed = true;
      }
    } else if (event.type === "objectiveComplete") {
      const index = objectives.findIndex((o) => o.id === event.objectiveId);
      if (index === -1 || objectives[index].status !== "active") continue;
      objectives[index] = withStatus(objectives[index], "done");
      changed = true;
    } else if (event.type === "playerDeath") {
      const next = failForType(objectives, DEATH_FAIL);
      if (next.some((o, i) => o !== objectives[i])) {
        objectives = next;
        changed = true;
      }
    }
  }

  const timedOut = objectives.map((objective) => {
    if (
      objective.status === "active" &&
      TIMED_FAIL.includes(objective.type) &&
      typeof objective.time === "number" &&
      state.time >= objective.time
    ) {
      return withStatus(objective, "failed");
    }
    return objective;
  });
  if (timedOut.some((o, i) => o !== objectives[i])) {
    objectives = timedOut;
    changed = true;
  }

  if (!changed) return state;
  return { ...state, objectives };
}
