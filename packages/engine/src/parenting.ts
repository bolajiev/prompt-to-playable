import type { Entity, Vec3 } from "@prompt-to-playable/schema";
import type { GameState } from "./state.js";

/**
 * Entity parenting (forward kinematics): a parented entity's authored
 * `position` / `rotation` are its LOCAL pose inside the parent's space, and
 * `attach` is the mount offset in that same parent-local space. Every tick,
 * after integration + control bindings, world transforms are resolved for the
 * whole hierarchy:
 *
 *   worldPos = parentWorldPos + rotateVec(parentWorldRot, attach + localPos)
 *   worldRot = parentWorldRot + localRot          (euler addition per axis)
 *
 * so rotating a joint carries every descendant with it. Parents are resolved
 * before children (topological passes over the document order); a cycle is
 * ignored deterministically by treating the entities on it as roots, so their
 * descendants still resolve from the cycle's authored pose.
 *
 * Everything here is copy-on-write and deterministic: runtime records are
 * only replaced when a value actually changes and document order drives the
 * traversal.
 */

const ZERO: Vec3 = [0, 0, 0];

function vecEquals(a: Vec3 | undefined, b: Vec3): boolean {
  return (
    a !== undefined &&
    a[0] === b[0] &&
    a[1] === b[1] &&
    a[2] === b[2]
  );
}

/**
 * Rotate `vec` by the euler angles `rotation`, in XYZ order: the X rotation is
 * applied first, then Y, then Z (`R = Rx * Ry * Rz`, matching three.js's
 * "XYZ" Euler convention used by the renderer).
 */
export function rotateVec(rotation: Vec3, vec: Vec3): Vec3 {
  const cx = Math.cos(rotation[0]);
  const sx = Math.sin(rotation[0]);
  const cy = Math.cos(rotation[1]);
  const sy = Math.sin(rotation[1]);
  const cz = Math.cos(rotation[2]);
  const sz = Math.sin(rotation[2]);

  // Rz
  const x1 = cz * vec[0] - sz * vec[1];
  const y1 = sz * vec[0] + cz * vec[1];
  const z1 = vec[2];
  // Ry
  const x2 = cy * x1 + sy * z1;
  const y2 = y1;
  const z2 = -sy * x1 + cy * z1;
  // Rx
  return [x2, cx * y2 - sx * z2, sx * y2 + cx * z2];
}

/** Ids of every entity that is part of a parent cycle, in document order. */
function cycleIds(entities: GameState["entities"]): Set<string> {
  const byId = new Map<string, Entity>(entities.map((entity) => [entity.id, entity]));
  const inCycle = new Set<string>();

  for (const entity of entities) {
    if (entity.parent === undefined) continue;
    const seen = new Set<string>();
    let current: string | undefined = entity.id;
    while (current !== undefined) {
      if (seen.has(current)) {
        // Walk the cycle once more, collecting every member.
        const start = current;
        let node: string | undefined = start;
        do {
          inCycle.add(node);
          node = byId.get(node)?.parent;
        } while (node !== undefined && node !== start);
        break;
      }
      seen.add(current);
      current = byId.get(current)?.parent;
    }
  }
  return inCycle;
}

/** Module-level so a permanent cycle warns once instead of every tick. */
let lastCycleWarning = "";

function warnCycle(ids: readonly string[]): void {
  const key = ids.join(",");
  if (key === lastCycleWarning) return;
  lastCycleWarning = key;
  console.warn(`[engine] parent cycle ignored (treated as root): ${key}`);
}

/**
 * Resolve world transforms for every parented entity. Unparented entities are
 * left untouched, and so are entities whose parent id does not exist (the
 * server reports `missing-parent`; the engine treats them as roots). Returns
 * the same state object when nothing changed.
 */
export function resolveWorldTransforms(state: GameState): GameState {
  const parented = state.entities.filter((entity) => entity.parent !== undefined);
  if (parented.length === 0) return state;

  const byId = new Map<string, Entity>(
    state.entities.map((entity) => [entity.id, entity])
  );
  const cycle = cycleIds(state.entities);

  let entityRuntime = state.entityRuntime;
  let changed = false;

  const apply = (id: string, parentId: string): void => {
    const runtime = entityRuntime[id];
    if (runtime === undefined) return;
    const parent = entityRuntime[parentId];
    if (parent === undefined) return;

    const localPosition = runtime.localPosition ?? ([...runtime.position] as Vec3);
    const localRotation = runtime.localRotation
      ? ([...runtime.localRotation] as Vec3)
      : runtime.rotation
        ? ([...runtime.rotation] as Vec3)
        : ([...ZERO] as Vec3);
    const attach = (byId.get(id)?.attach ?? ZERO) as Vec3;

    const offset: Vec3 = [
      attach[0] + localPosition[0],
      attach[1] + localPosition[1],
      attach[2] + localPosition[2],
    ];
    const parentRotation = parent.rotation ?? ZERO;
    const rotated = rotateVec(parentRotation, offset);
    const worldPosition: Vec3 = [
      parent.position[0] + rotated[0],
      parent.position[1] + rotated[1],
      parent.position[2] + rotated[2],
    ];
    const worldRotation: Vec3 = [
      parentRotation[0] + localRotation[0],
      parentRotation[1] + localRotation[1],
      parentRotation[2] + localRotation[2],
    ];

    if (
      vecEquals(runtime.position, worldPosition) &&
      vecEquals(runtime.rotation, worldRotation) &&
      runtime.localPosition !== undefined &&
      runtime.localRotation !== undefined
    ) {
      return;
    }

    entityRuntime = {
      ...entityRuntime,
      [id]: {
        ...runtime,
        position: worldPosition,
        rotation: worldRotation,
        localPosition: [...localPosition] as Vec3,
        localRotation: [...localRotation] as Vec3,
      },
    };
    changed = true;
  };

  // Cycle members act as roots: their stored pose is taken as world and never
  // rewritten, but their descendants still resolve from it. True roots (no
  // parent, or an unknown parent id) and already-resolved parents make a
  // node ready; document order drives the passes, so the result is stable.
  const isRoot = (id: string): boolean => {
    const entity = byId.get(id);
    return entity === undefined || entity.parent === undefined || cycle.has(id);
  };

  const resolved = new Set<string>();
  let pending = parented.filter((entity) => !cycle.has(entity.id));
  for (;;) {
    const next: GameState["entities"] = [];
    let progressed = false;
    for (const entity of pending) {
      const parentId = entity.parent as string;
      if (isRoot(parentId) || resolved.has(parentId)) {
        apply(entity.id, parentId);
        resolved.add(entity.id);
        progressed = true;
      } else {
        next.push(entity);
      }
    }
    pending = next;
    if (!progressed) break;
  }

  if (cycle.size > 0) {
    warnCycle(state.entities.filter((entity) => cycle.has(entity.id)).map((e) => e.id));
  }

  return changed ? { ...state, entityRuntime } : state;
}
