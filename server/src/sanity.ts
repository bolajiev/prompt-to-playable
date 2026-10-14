import type {
  Action,
  Condition,
  Entity,
  GameDoc,
  Objective,
  Rule,
  Vec3,
} from "@prompt-to-playable/schema";

export type SanityCode =
  | "no-player"
  | "missing-objective-target"
  | "missing-rule-reference"
  | "out-of-bounds"
  | "unreachable-target";

export interface SanityIssue {
  code: SanityCode;
  message: string;
  path: string;
}

export interface SanityResult {
  ok: boolean;
  errors: SanityIssue[];
}

const PLAYER_ID = "player";
const BOUNDS_EPS = 1e-3;
const GRID_CELL = 1;
const SQRT2 = Math.SQRT2;

interface IdRef {
  id: string;
  path: string;
}

function entityById(entities: readonly Entity[], id: string): Entity | undefined {
  return entities.find((e) => e.id === id);
}

function objectiveTargetRefs(objective: Objective, basePath: string): IdRef[] {
  const refs: IdRef[] = [];
  if (objective.target !== undefined) {
    refs.push({ id: objective.target, path: `${basePath}.target` });
  }
  for (let i = 0; i < (objective.targets?.length ?? 0); i += 1) {
    refs.push({
      id: (objective.targets as string[])[i],
      path: `${basePath}.targets[${i}]`,
    });
  }
  return refs;
}

function conditionEntityRefs(
  condition: Condition | undefined,
  basePath: string,
  refs: IdRef[]
): void {
  if (!condition) return;
  switch (condition.op) {
    case "and":
    case "or":
      condition.conditions.forEach((child, i) =>
        conditionEntityRefs(child, `${basePath}.conditions[${i}]`, refs)
      );
      break;
    case "not":
      conditionEntityRefs(condition.condition, `${basePath}.condition`, refs);
      break;
    case "has":
      refs.push({ id: condition.entity, path: `${basePath}.entity` });
      break;
    default:
      break;
  }
}

function actionRefs(action: Action, basePath: string): { entity: IdRef[]; objective: IdRef[] } {
  const entity: IdRef[] = [];
  const objective: IdRef[] = [];
  switch (action.type) {
    case "despawn":
    case "enable":
    case "disable":
    case "setEnemyState":
    case "openDoor":
      entity.push({ id: action.entity, path: `${basePath}.entity` });
      break;
    case "teleport":
      entity.push({ id: action.entity, path: `${basePath}.entity` });
      break;
    case "damage":
      if (action.entity !== undefined) {
        entity.push({ id: action.entity, path: `${basePath}.entity` });
      }
      break;
    case "toggle":
      entity.push({ id: action.target, path: `${basePath}.target` });
      break;
    case "objectiveProgress":
    case "setObjective":
      objective.push({ id: action.objective, path: `${basePath}.objective` });
      break;
    case "addObjective":
      objectiveTargetRefs(action.objective, `${basePath}.objective`).forEach((ref) =>
        objective.push(ref)
      );
      break;
    default:
      break;
  }
  return { entity, objective };
}

function ruleRefs(rule: Rule): { entity: IdRef[]; objective: IdRef[] } {
  const entity: IdRef[] = [];
  const objective: IdRef[] = [];
  const base = `rules[${rule.id}]`;

  if (rule.on.zone !== undefined) {
    entity.push({ id: rule.on.zone, path: `${base}.on.zone` });
  }
  if (rule.on.entity !== undefined) {
    entity.push({ id: rule.on.entity, path: `${base}.on.entity` });
  }
  if (rule.on.objective !== undefined) {
    objective.push({ id: rule.on.objective, path: `${base}.on.objective` });
  }
  conditionEntityRefs(rule.if, `${base}.if`, entity);
  rule.then.forEach((action, i) => {
    const refs = actionRefs(action, `${base}.then[${i}]`);
    entity.push(...refs.entity);
    objective.push(...refs.objective);
  });
  return { entity, objective };
}

function checkPosition(pos: Vec3, path: string, bounds: Vec3, issues: SanityIssue[]): void {
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(pos[axis]) > bounds[axis] + BOUNDS_EPS) {
      issues.push({
        code: "out-of-bounds",
        path,
        message: `Position ${JSON.stringify(pos)} exceeds world bounds ${JSON.stringify(bounds)} on axis ${axis}`,
      });
      return;
    }
  }
}

function boundsIssues(doc: GameDoc): SanityIssue[] {
  const issues: SanityIssue[] = [];
  for (const entity of doc.entities) {
    checkPosition(entity.position, `entities[${entity.id}].position`, doc.world.bounds, issues);
    for (let i = 0; i < (entity.patrol?.length ?? 0); i += 1) {
      checkPosition(
        (entity.patrol as Vec3[])[i],
        `entities[${entity.id}].patrol[${i}]`,
        doc.world.bounds,
        issues
      );
    }
  }
  return issues;
}

interface Cell {
  x: number;
  z: number;
}

function cellOf(value: number, halfExtent: number, cells: number): number {
  const index = Math.floor((value + halfExtent) / GRID_CELL);
  return Math.max(0, Math.min(cells - 1, index));
}

function pathExistsOnGrid(
  start: Cell,
  goal: Cell,
  blocked: Uint8Array,
  width: number,
  height: number
): boolean {
  if (start.x === goal.x && start.z === goal.z) return true;
  if (blocked[start.z * width + start.x] === 1 || blocked[goal.z * width + goal.x] === 1) {
    return false;
  }

  interface HeapEntry {
    f: number;
    g: number;
    x: number;
    z: number;
    seq: number;
  }

  const gScore = new Float64Array(width * height).fill(Infinity);
  const closed = new Uint8Array(width * height);
  const heap: HeapEntry[] = [];
  const goalIndex = goal.z * width + goal.x;

  function octile(x: number, z: number): number {
    const dx = Math.abs(x - goal.x);
    const dz = Math.abs(z - goal.z);
    return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
  }

  function push(entry: HeapEntry): void {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (before(heap[i], heap[parent])) {
        const swap = heap[i];
        heap[i] = heap[parent];
        heap[parent] = swap;
        i = parent;
      } else {
        break;
      }
    }
  }

  function pop(): HeapEntry | undefined {
    const top = heap[0];
    const last = heap.pop();
    if (last === undefined) return top;
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (left < heap.length && before(heap[left], heap[smallest])) smallest = left;
        if (right < heap.length && before(heap[right], heap[smallest])) smallest = right;
        if (smallest === i) break;
        const swap = heap[i];
        heap[i] = heap[smallest];
        heap[smallest] = swap;
        i = smallest;
      }
    }
    return top;
  }

  // Deterministic total order: f, then g, then x, then z, then insertion sequence.
  function before(a: HeapEntry, b: HeapEntry): boolean {
    if (a.f !== b.f) return a.f < b.f;
    if (a.g !== b.g) return a.g < b.g;
    if (a.x !== b.x) return a.x < b.x;
    if (a.z !== b.z) return a.z < b.z;
    return a.seq < b.seq;
  }

  gScore[start.z * width + start.x] = 0;
  let seq = 0;
  push({
    f: octile(start.x, start.z),
    g: 0,
    x: start.x,
    z: start.z,
    seq: seq++,
  });

  let guard = 0;
  while (heap.length > 0) {
    const current = pop() as HeapEntry;
    const index = current.z * width + current.x;
    if (index === goalIndex) return true;
    if (closed[index] === 1) continue;
    closed[index] = 1;

    const neighbors: ReadonlyArray<readonly [number, number, number]> = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, SQRT2],
      [1, -1, SQRT2],
      [-1, 1, SQRT2],
      [-1, -1, SQRT2],
    ];

    for (const [dx, dz, cost] of neighbors) {
      const nx = current.x + dx;
      const nz = current.z + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
      const next = nz * width + nx;
      if (blocked[next] === 1 || closed[next] === 1) continue;
      const tentative = current.g + cost;
      if (tentative < gScore[next]) {
        gScore[next] = tentative;
        push({
          f: tentative + octile(nx, nz),
          g: tentative,
          x: nx,
          z: nz,
          seq: seq++,
        });
      }
    }
    guard += 1;
    if (guard > width * height * 4) break;
  }
  return false;
}

function reachabilityIssues(doc: GameDoc): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const players = doc.entities.filter((e) => e.kind === "player" || e.id === PLAYER_ID);
  if (players.length === 0) return issues;

  const playerPos = players[0].position;
  const targets: { pos: Vec3; label: string }[] = [];
  for (const objective of doc.objectives) {
    if (objective.type !== "reach" && objective.type !== "collect") continue;
    for (const ref of objectiveTargetRefs(objective, `objectives[${objective.id}]`)) {
      const entity = entityById(doc.entities, ref.id);
      if (entity !== undefined) {
        targets.push({ pos: entity.position, label: ref.path });
      }
    }
  }
  if (targets.length === 0) return issues;

  const bounds = doc.world.bounds;
  const width = Math.ceil((bounds[0] * 2) / GRID_CELL);
  const height = Math.ceil((bounds[2] * 2) / GRID_CELL);
  if (width <= 0 || height <= 0) {
    for (const target of targets) {
      issues.push({
        code: "unreachable-target",
        path: target.label,
        message: "world bounds too small to evaluate reachability",
      });
    }
    return issues;
  }

  const blocked = new Uint8Array(width * height);
  for (const obstacle of doc.world.terrain.obstacles) {
    const minX = cellOf(obstacle.position[0] - obstacle.size[0] / 2, bounds[0], width);
    const maxX = cellOf(obstacle.position[0] + obstacle.size[0] / 2, bounds[0], width);
    const minZ = cellOf(obstacle.position[2] - obstacle.size[2] / 2, bounds[2], height);
    const maxZ = cellOf(obstacle.position[2] + obstacle.size[2] / 2, bounds[2], height);
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        blocked[z * width + x] = 1;
      }
    }
  }

  const start: Cell = {
    x: cellOf(playerPos[0], bounds[0], width),
    z: cellOf(playerPos[2], bounds[2], height),
  };

  const seen = new Set<string>();
  for (const target of targets) {
    const goal: Cell = {
      x: cellOf(target.pos[0], bounds[0], width),
      z: cellOf(target.pos[2], bounds[2], height),
    };
    const key = `${goal.x},${goal.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!pathExistsOnGrid(start, goal, blocked, width, height)) {
      issues.push({
        code: "unreachable-target",
        path: target.label,
        message: `No path from player at ${JSON.stringify(playerPos)} to target at ${JSON.stringify(target.pos)}`,
      });
    }
  }
  return issues;
}

export function sanityCheck(doc: GameDoc): SanityResult {
  const errors: SanityIssue[] = [];

  if (!doc.entities.some((e) => e.kind === "player" || e.id === PLAYER_ID)) {
    errors.push({
      code: "no-player",
      path: "entities",
      message: "Document has no player entity (kind 'player' or id 'player')",
    });
  }

  for (const objective of doc.objectives) {
    for (const ref of objectiveTargetRefs(objective, `objectives[${objective.id}]`)) {
      if (entityById(doc.entities, ref.id) === undefined) {
        errors.push({
          code: "missing-objective-target",
          path: ref.path,
          message: `Objective references unknown entity '${ref.id}'`,
        });
      }
    }
  }

  for (const rule of doc.rules) {
    const refs = ruleRefs(rule);
    for (const ref of refs.entity) {
      if (entityById(doc.entities, ref.id) === undefined) {
        errors.push({
          code: "missing-rule-reference",
          path: ref.path,
          message: `Rule references unknown entity '${ref.id}'`,
        });
      }
    }
    for (const ref of refs.objective) {
      if (!doc.objectives.some((o) => o.id === ref.id)) {
        errors.push({
          code: "missing-rule-reference",
          path: ref.path,
          message: `Rule references unknown objective '${ref.id}'`,
        });
      }
    }
  }

  errors.push(...boundsIssues(doc));
  errors.push(...reachabilityIssues(doc));

  return { ok: errors.length === 0, errors };
}

/** True when some rule can end the game with a win action. */
export function hasWinPath(doc: GameDoc): boolean {
  return doc.rules.some((rule) =>
    rule.then.some((action) => action.type === "win")
  );
}

/**
 * Goal games must ship a win path. Explore scenes are free-roam by design:
 * they carry no objectives and need no win condition, while player, bounds
 * and reference checks still apply.
 */
export function requiresWinPath(doc: GameDoc): boolean {
  return doc.meta.archetype !== "explore";
}

export const SANITY_CODES = [
  "no-player",
  "missing-objective-target",
  "missing-rule-reference",
  "out-of-bounds",
  "unreachable-target",
] as const;