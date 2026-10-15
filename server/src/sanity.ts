import type {
  Action,
  Condition,
  Entity,
  GameDoc,
  GameMode,
  Objective,
  Rule,
  Vec3,
} from "@prompt-to-playable/schema";

export type SanityCode =
  | "no-player"
  | "missing-objective-target"
  | "missing-rule-reference"
  | "out-of-bounds"
  | "unreachable-target"
  | "missing-inspect-content"
  | "missing-click-rule"
  | "missing-interactable"
  | "missing-checkpoints"
  | "invalid-checkpoint-index"
  | "not-a-vehicle"
  | "missing-win-path"
  | "missing-machine-control"
  | "missing-parent"
  | "parent-cycle"
  | "invalid-control-bind";

export type Kit = GameMode;

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
    case "setVisible":
    case "setColor":
    case "animate":
      entity.push({ id: action.entity, path: `${basePath}.entity` });
      break;
    case "cameraFocus":
    case "showPanel":
    case "hidePanel":
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

/**
 * Entity parenting references: `parent` must name an existing entity (zod
 * cannot check cross-references) and the parent links must be acyclic so the
 * engine's forward-kinematics pass always terminates.
 */
function parentIssues(doc: GameDoc): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const byId = new Map<string, Entity>(
    doc.entities.map((entity) => [entity.id, entity])
  );

  for (const entity of doc.entities) {
    const parentId = entity.parent;
    if (parentId === undefined) continue;

    if (!byId.has(parentId)) {
      issues.push({
        code: "missing-parent",
        path: `entities[${entity.id}].parent`,
        message: `Entity '${entity.id}' has unknown parent '${parentId}'`,
      });
      continue;
    }

    const seen = new Set<string>([entity.id]);
    let current: string | undefined = parentId;
    while (current !== undefined) {
      if (seen.has(current)) {
        const chain = [...seen].join(" -> ");
        issues.push({
          code: "parent-cycle",
          path: `entities[${entity.id}].parent`,
          message: `Entity '${entity.id}' is part of a parent cycle (${chain})`,
        });
        break;
      }
      seen.add(current);
      current = byId.get(current)?.parent;
      if (current !== undefined && !byId.has(current)) break;
    }
  }

  return issues;
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

/**
 * Resolve the interactive kit a document belongs to: the explicit `meta.mode`
 * when present, otherwise inferred the same way the engine does (archetype
 * "explore" -> explore, every other archetype -> game). Unknown mode values
 * cannot reach here because the schema constrains the enum.
 */
export function resolveKit(doc: GameDoc): Kit {
  if (doc.meta.mode !== undefined) return doc.meta.mode;
  return doc.meta.archetype === "explore" ? "explore" : "game";
}

/** inspect: a clickable showcase needs parts/labels and at least one click rule. */
function inspectIssues(doc: GameDoc): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const hasContent = doc.entities.some(
    (entity) => (entity.parts?.length ?? 0) > 0 || entity.label !== undefined
  );
  if (!hasContent) {
    issues.push({
      code: "missing-inspect-content",
      path: "entities",
      message:
        "Inspect scene needs at least one entity with 'parts' or a 'label' to look at",
    });
  }
  if (!doc.rules.some((rule) => rule.on.event === "click")) {
    issues.push({
      code: "missing-click-rule",
      path: "rules",
      message: "Inspect scene needs at least one rule triggered by an on.click event",
    });
  }
  return issues;
}

/** walkthrough: the player must be able to interact with something. */
function walkthroughIssues(doc: GameDoc): SanityIssue[] {
  const hasInteractable = doc.entities.some(
    (entity) => entity.kind === "interactable" || entity.tags.includes("interactable")
  );
  if (hasInteractable) return [];
  return [
    {
      code: "missing-interactable",
      path: "entities",
      message: "Walkthrough needs at least one interactable entity to open or toggle",
    },
  ];
}

function checkpointIndexes(doc: GameDoc): { zones: Entity[]; indexes: number[] } {
  const zones = doc.entities.filter(
    (entity) =>
      entity.kind === "zone" &&
      typeof entity.props?.checkpointIndex === "number" &&
      Number.isInteger(entity.props.checkpointIndex)
  );
  const indexes = zones
    .map((zone) => zone.props?.checkpointIndex as number)
    .sort((a, b) => a - b);
  return { zones, indexes };
}

/**
 * drive: a vehicle player, at least three checkpoint zones with distinct
 * integer checkpointIndex values covering 0..n-1, and a win path.
 */
function driveIssues(doc: GameDoc): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const player = doc.entities.find((e) => e.kind === "player" || e.id === PLAYER_ID);
  if (player !== undefined && player.props?.vehicle !== true) {
    issues.push({
      code: "not-a-vehicle",
      path: `entities[${player.id}].props.vehicle`,
      message: "Drive scene needs the player to have props.vehicle set to true",
    });
  }

  const { zones, indexes } = checkpointIndexes(doc);
  if (zones.length < 3) {
    issues.push({
      code: "missing-checkpoints",
      path: "entities",
      message: `Drive scene needs at least 3 checkpoint zones with props.checkpointIndex (found ${zones.length})`,
    });
  } else {
    const ordered = indexes.every((index, position) => index === position);
    if (!ordered) {
      issues.push({
        code: "invalid-checkpoint-index",
        path: "entities",
        message: `Checkpoint indexes must be distinct integers covering 0..${zones.length - 1} (found ${JSON.stringify(indexes)})`,
      });
    }
  }

  if (!hasWinPath(doc)) {
    issues.push({
      code: "missing-win-path",
      path: "rules",
      message: "Drive scene needs a rule with a win action to finish the race",
    });
  }
  return issues;
}

/**
 * Controls must resolve for every kit: a `bind.entity` or an entity/objective
 * referenced by `bind.onPress` that does not exist can never do anything, so
 * the binding is a data bug wherever it appears.
 */
function controlBindIssues(doc: GameDoc): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const controls = doc.controls ?? [];
  for (const control of controls) {
    const boundEntity = control.bind?.entity;
    if (
      boundEntity !== undefined &&
      entityById(doc.entities, boundEntity) === undefined
    ) {
      issues.push({
        code: "invalid-control-bind",
        path: `controls[${control.id}].bind.entity`,
        message: `Control '${control.id}' binds unknown entity '${boundEntity}'`,
      });
    }
    (control.bind?.onPress ?? []).forEach((action, i) => {
      const refs = actionRefs(
        action,
        `controls[${control.id}].bind.onPress[${i}]`
      );
      for (const ref of refs.entity) {
        if (entityById(doc.entities, ref.id) === undefined) {
          issues.push({
            code: "invalid-control-bind",
            path: ref.path,
            message: `Control '${control.id}' onPress references unknown entity '${ref.id}'`,
          });
        }
      }
      for (const ref of refs.objective) {
        if (!doc.objectives.some((objective) => objective.id === ref.id)) {
          issues.push({
            code: "invalid-control-bind",
            path: ref.path,
            message: `Control '${control.id}' onPress references unknown objective '${ref.id}'`,
          });
        }
      }
    });
  }
  return issues;
}

/**
 * machine: the scene is driven from the sidebar, so at least one slider must
 * drive a real entity property; reference checks above guard the rest.
 */
function machineIssues(doc: GameDoc): SanityIssue[] {
  const sliders = (doc.controls ?? []).filter(
    (control) =>
      control.type === "slider" &&
      control.bind?.entity !== undefined &&
      control.bind.property !== undefined
  );
  if (sliders.length > 0) return [];
  return [
    {
      code: "missing-machine-control",
      path: "controls",
      message:
        "Machine scene needs at least one slider bound to an entity property (rotation/position/visible/color/emissive)",
    },
  ];
}

function kitIssues(doc: GameDoc): SanityIssue[] {
  const kit = resolveKit(doc);
  if (kit === "inspect") return inspectIssues(doc);
  if (kit === "walkthrough") return walkthroughIssues(doc);
  if (kit === "drive") return driveIssues(doc);
  if (kit === "machine") return machineIssues(doc);
  return [];
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

  errors.push(...parentIssues(doc));
  errors.push(...controlBindIssues(doc));
  errors.push(...boundsIssues(doc));
  errors.push(...reachabilityIssues(doc));
  errors.push(...kitIssues(doc));

  return { ok: errors.length === 0, errors };
}

/** True when some rule can end the game with a win action. */
export function hasWinPath(doc: GameDoc): boolean {
  return doc.rules.some((rule) =>
    rule.then.some((action) => action.type === "win")
  );
}

/**
 * Goal games (and races, which are goal games with a vehicle) must ship a win
 * path. Explore scenes, inspect showcases and walkthroughs are free-roam by
 * design: they carry no objectives and need no win condition, while player,
 * bounds and reference checks still apply.
 */
export function requiresWinPath(doc: GameDoc): boolean {
  const kit = resolveKit(doc);
  return kit === "game" || kit === "drive";
}

export const SANITY_CODES = [
  "no-player",
  "missing-objective-target",
  "missing-rule-reference",
  "out-of-bounds",
  "unreachable-target",
  "missing-inspect-content",
  "missing-click-rule",
  "missing-interactable",
  "missing-checkpoints",
  "invalid-checkpoint-index",
  "not-a-vehicle",
  "missing-win-path",
  "missing-machine-control",
  "missing-parent",
  "parent-cycle",
  "invalid-control-bind",
] as const;
