import type { Entity, Objective } from "@prompt-to-playable/schema";
import type { AABB, Vec3 } from "@prompt-to-playable/shared";
import { pointInAABB } from "./collision.js";
import type { GameEvent } from "./events.js";
import { updateObjectives } from "./objectives.js";
import { evaluateRules } from "./rules.js";
import type { GameState } from "./state.js";

export const SYSTEM_ORDER = [
  "integrate",
  "broadphase",
  "events",
  "rules",
  "objectives",
  "cleanup",
] as const;

export type SystemName = (typeof SYSTEM_ORDER)[number];

export const ZONE_FLAG_PREFIX = "__zone__";
export const DEFAULT_ZONE_SIZE: Vec3 = [2, 2, 2];
export const MAX_RULE_PASSES = 4;

function isActive(state: GameState, id: string): boolean {
  const runtime = state.entityRuntime[id];
  if (runtime) return runtime.active;
  return state.entities.find((e) => e.id === id)?.active ?? false;
}

function positionOf(state: GameState, entity: Entity): Vec3 {
  return state.entityRuntime[entity.id]?.position ?? entity.position;
}

function entityAABB(entity: Entity, position: Vec3): AABB {
  const size = entity.size ?? DEFAULT_ZONE_SIZE;
  const half: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  return {
    min: [position[0] - half[0], position[1] - half[1], position[2] - half[2]],
    max: [position[0] + half[0], position[1] + half[1], position[2] + half[2]],
  };
}

/**
 * Integrate: advance dynamic entities. Movement/AI is intentionally a stub in
 * this task; the player is driven by input/teleport actions from the renderer.
 * Kept as an explicit system so ordering stays spec-compliant and pure.
 */
export function integrate(state: GameState, _dt: number): GameState {
  return state;
}

export interface BroadphaseResult {
  state: GameState;
  events: GameEvent[];
}

/**
 * Broadphase: AABB zone checks against the player. Emits `playerEnter` only on
 * the rising edge (player was outside during the previous tick) so rules do not
 * retrigger while the player remains inside a zone.
 */
export function broadphase(state: GameState): BroadphaseResult {
  const player = state.entities.find(
    (e) => e.kind === "player" && isActive(state, e.id)
  );
  if (!player) return { state, events: [] };

  const playerPos = positionOf(state, player);
  const events: GameEvent[] = [];
  let flags = state.flags;
  let changed = false;

  for (const zone of state.entities) {
    if (zone.kind !== "zone" || !isActive(state, zone.id)) continue;

    const inside = pointInAABB(
      playerPos,
      entityAABB(zone, positionOf(state, zone))
    );
    const key = ZONE_FLAG_PREFIX + zone.id;
    const was = flags[key] === true;
    if (inside === was) continue;

    if (!changed) {
      flags = { ...flags };
      changed = true;
    }

    if (inside) {
      flags[key] = true;
      events.push({ type: "playerEnter", zoneId: zone.id, entityId: player.id });
    } else {
      delete flags[key];
    }
  }

  return { state: changed ? { ...state, flags } : state, events };
}

function statusMap(objectives: Objective[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const objective of objectives) map[objective.id] = objective.status;
  return map;
}

function completedSince(
  before: Record<string, string>,
  objectives: Objective[]
): string[] {
  const ids: string[] = [];
  for (const objective of objectives) {
    if (objective.status === "done" && before[objective.id] !== "done") {
      ids.push(objective.id);
    }
  }
  return ids;
}

/** Cleanup: drop runtime state for entities that no longer exist. */
export function cleanup(state: GameState): GameState {
  const present = new Set<string>(state.entities.map((e) => e.id));
  let runtime = state.entityRuntime;
  let changed = false;

  for (const id of Object.keys(runtime)) {
    if (!present.has(id)) {
      if (!changed) {
        runtime = { ...runtime };
        changed = true;
      }
      delete runtime[id];
    }
  }

  return changed ? { ...state, entityRuntime: runtime } : state;
}

export function emitEvents(state: GameState): GameEvent[] {
  return [{ type: "tick" }];
}

export function tick(state: GameState, dt: number): GameState {
  let next: GameState = integrate(state, dt);
  next = { ...next, time: state.time + dt, ticks: state.ticks + 1 };

  const broad = broadphase(next);
  next = broad.state;

  const emitted: GameEvent[] = [...emitEvents(next), ...broad.events];
  let pending: GameEvent[] = emitted;
  let passes = 0;

  while (pending.length > 0 && passes < MAX_RULE_PASSES) {
    passes++;

    const before = statusMap(next.objectives);
    const { state: afterRules } = evaluateRules(next, pending);
    next = updateObjectives(afterRules, pending);

    const completed = completedSince(before, next.objectives);
    if (completed.length === 0) break;

    pending = completed.map((objectiveId) => ({
      type: "objectiveComplete",
      objectiveId,
    }));
    emitted.push(...pending);
  }

  next = cleanup(next);
  next = { ...next, events: emitted };
  return next;
}
