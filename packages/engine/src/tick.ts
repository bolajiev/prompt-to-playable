import type { EnemyState, Entity, Objective } from "@prompt-to-playable/schema";
import type { AABB, Vec3 } from "@prompt-to-playable/shared";
import {
  DEFAULT_SOLID_SIZE,
  aabbOverlap,
  collectSolids,
  pointInAABB,
  resolveXZ,
  resolveY,
} from "./collision.js";
import type { GameEvent } from "./events.js";
import { NEUTRAL_INPUT, sanitizeInput, type InputState } from "./input.js";
import { updateObjectives } from "./objectives.js";
import { evaluateRules } from "./rules.js";
import type { EntityRuntime, GameState } from "./state.js";

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

export const FLOOR_Y = 0;
export const DEFAULT_PLAYER_SIZE: Vec3 = [0.6, 1.8, 0.6];
export const DEFAULT_PLAYER_SPEED = 6;
export const DEFAULT_JUMP_SPEED = 8;
export const DEFAULT_ENEMY_SPEED = 2.5;
export const PATROL_REACHED_DISTANCE = 0.15;
export const ENEMY_LOSE_SIGHT_FACTOR = 1.25;
export const DEFAULT_INTERACT_RANGE = 2.5;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function xzDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function steerToward(
  velocity: Vec3,
  position: Vec3,
  target: Vec3,
  speed: number
): void {
  const dx = target[0] - position[0];
  const dz = target[2] - position[2];
  const d = Math.hypot(dx, dz);
  if (d <= 1e-9) {
    velocity[0] = 0;
    velocity[2] = 0;
    return;
  }
  velocity[0] = (dx / d) * speed;
  velocity[2] = (dz / d) * speed;
}

function integratePlayer(
  player: Entity,
  runtime: EntityRuntime,
  dt: number,
  input: InputState,
  solids: AABB[],
  gravity: number,
  bounds: Vec3
): EntityRuntime {
  const speed = player.speed ?? DEFAULT_PLAYER_SPEED;
  const size = player.size ?? DEFAULT_PLAYER_SIZE;

  const position: Vec3 = [...runtime.position];
  const velocity: Vec3 = runtime.velocity ? [...runtime.velocity] : [0, 0, 0];

  velocity[0] = input.moveX * speed;
  velocity[2] = input.moveZ * speed;
  velocity[1] += -gravity * dt;

  if (input.jump && runtime.grounded) {
    const jumpSpeed =
      typeof player.props?.jumpSpeed === "number"
        ? player.props.jumpSpeed
        : DEFAULT_JUMP_SPEED;
    velocity[1] = jumpSpeed;
  }

  position[0] += velocity[0] * dt;
  position[2] += velocity[2] * dt;

  const xz = resolveXZ(position, velocity, size, solids);
  position[0] = xz.pos[0];
  position[2] = xz.pos[2];
  velocity[0] = xz.vel[0];
  velocity[2] = xz.vel[2];

  position[1] += velocity[1] * dt;

  const y = resolveY(position, velocity, size, solids);
  position[1] = y.pos[1];
  velocity[1] = y.vel[1];
  let grounded = y.grounded;

  const halfHeight = size[1] / 2;
  if (!grounded && position[1] <= FLOOR_Y + halfHeight) {
    position[1] = FLOOR_Y + halfHeight;
    velocity[1] = 0;
    grounded = true;
  }

  const limitX = Math.max(0, bounds[0] / 2 - size[0] / 2);
  const limitZ = Math.max(0, bounds[2] / 2 - size[2] / 2);
  position[0] = clamp(position[0], -limitX, limitX);
  position[2] = clamp(position[2], -limitZ, limitZ);

  return { ...runtime, position, velocity, grounded };
}

/**
 * Enemy AI: resolves the live behavior state (`idle` | `patrol` | `chase` |
 * `return`), steers along XZ at `speed ?? 2.5`, then applies gravity, floor
 * rest, solids and world bounds exactly like the player. Patrol wraps to the
 * next waypoint at `PATROL_REACHED_DISTANCE`; chase loses the player beyond
 * `sight * ENEMY_LOSE_SIGHT_FACTOR` and returns to `patrol[0]`.
 */
function integrateEnemy(
  enemy: Entity,
  runtime: EntityRuntime,
  dt: number,
  playerPosition: Vec3 | undefined,
  solids: AABB[],
  gravity: number,
  bounds: Vec3
): EntityRuntime {
  const size = enemy.size ?? DEFAULT_SOLID_SIZE;
  const speed = enemy.speed ?? DEFAULT_ENEMY_SPEED;
  const patrol = enemy.patrol ?? [];
  const sight = enemy.sight;

  const position: Vec3 = [...runtime.position];
  const velocity: Vec3 = [...runtime.velocity];
  let mode: EnemyState =
    runtime.state ?? enemy.state ?? (patrol.length > 0 ? "patrol" : "idle");
  let waypointIndex = runtime.waypointIndex ?? 0;

  const distanceToPlayer =
    playerPosition !== undefined ? distance(position, playerPosition) : Infinity;
  const seesPlayer =
    playerPosition !== undefined &&
    sight !== undefined &&
    distanceToPlayer <= sight;

  if (mode === "idle" || mode === "patrol") {
    if (seesPlayer) mode = "chase";
  } else if (mode === "chase") {
    if (
      sight === undefined ||
      distanceToPlayer > sight * ENEMY_LOSE_SIGHT_FACTOR
    ) {
      mode = "return";
    }
  } else if (mode === "return" && seesPlayer) {
    mode = "chase";
  }

  velocity[1] += -gravity * dt;
  velocity[0] = 0;
  velocity[2] = 0;

  if (mode === "chase" && playerPosition !== undefined) {
    steerToward(velocity, position, playerPosition, speed);
  } else if (mode === "return") {
    if (patrol.length === 0) {
      mode = "idle";
    } else if (xzDistance(position, patrol[0]) < PATROL_REACHED_DISTANCE) {
      mode = "patrol";
      waypointIndex = 0;
    } else {
      steerToward(velocity, position, patrol[0], speed);
    }
  }

  if (mode === "patrol") {
    if (patrol.length === 0) {
      mode = "idle";
    } else {
      waypointIndex =
        ((waypointIndex % patrol.length) + patrol.length) % patrol.length;
      if (xzDistance(position, patrol[waypointIndex]) < PATROL_REACHED_DISTANCE) {
        waypointIndex = (waypointIndex + 1) % patrol.length;
      }
      steerToward(velocity, position, patrol[waypointIndex], speed);
    }
  }

  position[0] += velocity[0] * dt;
  position[2] += velocity[2] * dt;

  const xz = resolveXZ(position, velocity, size, solids);
  position[0] = xz.pos[0];
  position[2] = xz.pos[2];
  velocity[0] = xz.vel[0];
  velocity[2] = xz.vel[2];

  position[1] += velocity[1] * dt;

  const y = resolveY(position, velocity, size, solids);
  position[1] = y.pos[1];
  velocity[1] = y.vel[1];
  let grounded = y.grounded;

  const halfHeight = size[1] / 2;
  if (!grounded && position[1] <= FLOOR_Y + halfHeight) {
    position[1] = FLOOR_Y + halfHeight;
    velocity[1] = 0;
    grounded = true;
  }

  const limitX = Math.max(0, bounds[0] / 2 - size[0] / 2);
  const limitZ = Math.max(0, bounds[2] / 2 - size[2] / 2);
  position[0] = clamp(position[0], -limitX, limitX);
  position[2] = clamp(position[2], -limitZ, limitZ);

  return { ...runtime, position, velocity, grounded, state: mode, waypointIndex };
}

/**
 * Integrate: advance the active player from sanitized input and every active
 * enemy through its AI, then resolve gravity, solids, floor rest and world
 * bounds. Pure copy-on-write: inputs and previous runtime records are never
 * mutated.
 */
export function integrate(
  state: GameState,
  dt: number,
  input: InputState = NEUTRAL_INPUT
): GameState {
  const gravity = state.doc.world.gravity ?? 9.8;
  const bounds = state.doc.world.bounds;
  const solids = collectSolids(state);

  let entityRuntime = state.entityRuntime;
  let changed = false;

  const player = state.entities.find(
    (e) => e.kind === "player" && isActive(state, e.id)
  );
  const playerRuntime = player ? entityRuntime[player.id] : undefined;

  if (player && playerRuntime) {
    entityRuntime = {
      ...entityRuntime,
      [player.id]: integratePlayer(
        player,
        playerRuntime,
        dt,
        input,
        solids,
        gravity,
        bounds
      ),
    };
    changed = true;
  }

  const playerPosition = player ? entityRuntime[player.id]?.position : undefined;

  for (const entity of state.entities) {
    if (entity.kind !== "enemy" || !isActive(state, entity.id)) continue;
    const runtime = entityRuntime[entity.id];
    if (!runtime) continue;

    entityRuntime = {
      ...entityRuntime,
      [entity.id]: integrateEnemy(
        entity,
        runtime,
        dt,
        playerPosition,
        solids,
        gravity,
        bounds
      ),
    };
    changed = true;
  }

  return changed ? { ...state, entityRuntime } : state;
}

export interface BroadphaseResult {
  state: GameState;
  events: GameEvent[];
}

/**
 * Broadphase: AABB zone checks against the player plus enemy-player contact.
 * `playerEnter` and `enemyContact` are emitted only on the rising edge (the
 * overlap did not exist on the previous tick) so rules do not retrigger while
 * the overlap persists; `contactArmed` re-arms once the boxes separate.
 */
export function broadphase(state: GameState): BroadphaseResult {
  const player = state.entities.find(
    (e) => e.kind === "player" && isActive(state, e.id)
  );
  if (!player) return { state, events: [] };

  const playerPos = positionOf(state, player);
  const playerBox = entityAABB(player, playerPos);
  const events: GameEvent[] = [];
  let flags = state.flags;
  let entityRuntime = state.entityRuntime;
  let flagsChanged = false;
  let runtimeChanged = false;

  for (const zone of state.entities) {
    if (zone.kind !== "zone" || !isActive(state, zone.id)) continue;

    const inside = pointInAABB(playerPos, entityAABB(zone, positionOf(state, zone)));
    const key = ZONE_FLAG_PREFIX + zone.id;
    const was = flags[key] === true;
    if (inside === was) continue;

    if (!flagsChanged) {
      flags = { ...flags };
      flagsChanged = true;
    }

    if (inside) {
      flags[key] = true;
      events.push({ type: "playerEnter", zoneId: zone.id, entityId: player.id });
    } else {
      delete flags[key];
    }
  }

  for (const enemy of state.entities) {
    if (enemy.kind !== "enemy" || !isActive(state, enemy.id)) continue;
    const runtime = entityRuntime[enemy.id];
    if (!runtime) continue;

    const overlapping = aabbOverlap(
      entityAABB(enemy, runtime.position),
      playerBox
    );
    const armed = runtime.contactArmed !== false;

    if (overlapping && armed) {
      entityRuntime = {
        ...entityRuntime,
        [enemy.id]: { ...runtime, contactArmed: false },
      };
      runtimeChanged = true;
      events.push({
        type: "enemyContact",
        entityId: enemy.id,
        targetId: player.id,
      });
    } else if (!overlapping && !armed) {
      entityRuntime = {
        ...entityRuntime,
        [enemy.id]: { ...runtime, contactArmed: true },
      };
      runtimeChanged = true;
    }
  }

  if (!flagsChanged && !runtimeChanged) return { state, events };

  return {
    state: {
      ...state,
      entityRuntime: runtimeChanged ? entityRuntime : state.entityRuntime,
      flags: flagsChanged ? flags : state.flags,
    },
    events,
  };
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

function failedSince(
  before: Record<string, string>,
  objectives: Objective[]
): string[] {
  const ids: string[] = [];
  for (const objective of objectives) {
    if (objective.status === "failed" && before[objective.id] === "active") {
      ids.push(objective.id);
    }
  }
  return ids;
}

function progressMap(objectives: Objective[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const objective of objectives) map[objective.id] = objective.progress;
  return map;
}

function progressSince(
  before: Record<string, number>,
  objectives: Objective[]
): GameEvent[] {
  const events: GameEvent[] = [];
  for (const objective of objectives) {
    const previous = before[objective.id];
    if (typeof previous === "number" && objective.progress > previous) {
      events.push({
        type: "objectiveProgress",
        objectiveId: objective.id,
        by: objective.progress - previous,
      });
    }
  }
  return events;
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

/**
 * Interact: on the rising edge of `input.interact`, emit exactly one `interact`
 * event for the nearest active entity tagged `"interactable"` (or with
 * `kind === "interactable"`) within its
 * `props.interactRange ?? DEFAULT_INTERACT_RANGE`. Ties resolve in entity-list
 * order, so emission stays deterministic.
 */
export function detectInteract(state: GameState): GameEvent[] {
  if (!(state.input.interact && !state.prevInput.interact)) return [];

  const player = state.entities.find(
    (e) => e.kind === "player" && isActive(state, e.id)
  );
  if (!player) return [];

  const playerPos = positionOf(state, player);
  let target: Entity | undefined;
  let targetDistance = Infinity;

  for (const entity of state.entities) {
    if (entity.id === player.id || !isActive(state, entity.id)) continue;

    const tags = state.entityRuntime[entity.id]?.tags ?? entity.tags;
    if (entity.kind !== "interactable" && !tags.includes("interactable")) {
      continue;
    }

    const range =
      typeof entity.props?.interactRange === "number"
        ? entity.props.interactRange
        : DEFAULT_INTERACT_RANGE;
    const d = distance(playerPos, positionOf(state, entity));
    if (d <= range && d < targetDistance) {
      target = entity;
      targetDistance = d;
    }
  }

  if (!target) return [];
  return [{ type: "interact", targetId: target.id, entityId: player.id }];
}

export function tick(
  state: GameState,
  dt: number,
  input: Partial<InputState> = NEUTRAL_INPUT
): GameState {
  const sanitized = sanitizeInput(input);
  let next: GameState = {
    ...state,
    prevInput: state.input ?? { ...NEUTRAL_INPUT },
    input: sanitized,
  };
  next = integrate(next, dt, sanitized);
  next = { ...next, time: state.time + dt, ticks: state.ticks + 1 };

  const broad = broadphase(next);
  next = broad.state;

  const baseEvents: GameEvent[] = [
    ...emitEvents(next),
    ...broad.events,
    ...detectInteract(next),
  ];
  const emitted: GameEvent[] = [...baseEvents];
  let ruleEvents: GameEvent[] = baseEvents;
  let applyEvents: GameEvent[] = baseEvents;
  let passes = 0;

  while (ruleEvents.length > 0 && passes < MAX_RULE_PASSES) {
    passes++;

    const beforeStatus = statusMap(next.objectives);
    const beforeProgress = progressMap(next.objectives);
    const { state: afterRules } = evaluateRules(next, ruleEvents);
    next = updateObjectives(afterRules, applyEvents);

    const progress = progressSince(beforeProgress, next.objectives);
    const completed = completedSince(beforeStatus, next.objectives).map(
      (objectiveId): GameEvent => ({ type: "objectiveComplete", objectiveId })
    );
    const failed = failedSince(beforeStatus, next.objectives).map(
      (objectiveId): GameEvent => ({ type: "objectiveFailed", objectiveId })
    );

    const chained: GameEvent[] = [...progress, ...completed, ...failed];
    if (chained.length === 0) break;

    emitted.push(...chained);
    ruleEvents = chained;
    applyEvents = [...completed, ...failed];
  }

  next = cleanup(next);
  next = { ...next, events: emitted };
  return next;
}
