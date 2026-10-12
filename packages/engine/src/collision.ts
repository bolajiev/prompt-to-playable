import type { Entity } from "@prompt-to-playable/schema";
import type { AABB, Vec3 } from "@prompt-to-playable/shared";
import type { GameState } from "./state.js";

export interface Sphere {
  center: Vec3;
  radius: number;
}

export interface Box {
  position: Vec3;
  size: Vec3;
}

export const DEFAULT_SOLID_SIZE: Vec3 = [1, 1, 1];

export function pointInAABB(p: Vec3, box: AABB): boolean {
  return (
    p[0] >= box.min[0] &&
    p[0] <= box.max[0] &&
    p[1] >= box.min[1] &&
    p[1] <= box.max[1] &&
    p[2] >= box.min[2] &&
    p[2] <= box.max[2]
  );
}

export function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

export function sphereOverlap(a: Sphere, b: Sphere): boolean {
  const dx = a.center[0] - b.center[0];
  const dy = a.center[1] - b.center[1];
  const dz = a.center[2] - b.center[2];
  const radii = a.radius + b.radius;
  return dx * dx + dy * dy + dz * dz <= radii * radii;
}

export function aabbFromBox(box: Box): AABB {
  const half: Vec3 = [box.size[0] / 2, box.size[1] / 2, box.size[2] / 2];
  return {
    min: [
      box.position[0] - half[0],
      box.position[1] - half[1],
      box.position[2] - half[2],
    ],
    max: [
      box.position[0] + half[0],
      box.position[1] + half[1],
      box.position[2] + half[2],
    ],
  };
}

function isEntityActive(state: GameState, entity: Entity): boolean {
  const runtime = state.entityRuntime[entity.id];
  return runtime ? runtime.active : entity.active;
}

/** Terrain obstacles plus active `solid` / `platform` entities as world AABBs. */
export function collectSolids(state: GameState): AABB[] {
  const solids: AABB[] = [];

  const obstacles = state.doc.world.terrain?.obstacles ?? [];
  for (const obstacle of obstacles) {
    solids.push(
      aabbFromBox({ position: obstacle.position, size: obstacle.size })
    );
  }

  for (const entity of state.entities) {
    if (entity.solid !== true && entity.kind !== "platform") continue;
    if (!isEntityActive(state, entity)) continue;
    const runtime = state.entityRuntime[entity.id];
    const position = runtime ? runtime.position : entity.position;
    solids.push(
      aabbFromBox({ position, size: entity.size ?? DEFAULT_SOLID_SIZE })
    );
  }

  return solids;
}

function penetration(position: Vec3, size: Vec3, solid: AABB): Vec3 | null {
  const pen: Vec3 = [0, 0, 0];
  for (const axis of [0, 1, 2] as const) {
    const half = size[axis] / 2;
    pen[axis] =
      Math.min(position[axis] + half, solid.max[axis]) -
      Math.max(position[axis] - half, solid.min[axis]);
    if (pen[axis] <= 0) return null;
  }
  return pen;
}

/**
 * Axis-separated horizontal pushout: resolve X then Z against every solid.
 * Contacts where the vertical overlap is the smallest (landing / head bumps)
 * are left to `resolveY`.
 */
export function resolveXZ(
  pos: Vec3,
  vel: Vec3,
  size: Vec3,
  solids: AABB[]
): { pos: Vec3; vel: Vec3 } {
  const position: Vec3 = [...pos];
  const velocity: Vec3 = [...vel];

  for (const axis of [0, 2] as const) {
    for (const solid of solids) {
      const pen = penetration(position, size, solid);
      if (!pen) continue;
      if (pen[1] < pen[0] && pen[1] < pen[2]) continue;

      const half = size[axis] / 2;
      if (velocity[axis] > 0) {
        position[axis] = solid.min[axis] - half;
      } else if (velocity[axis] < 0) {
        position[axis] = solid.max[axis] + half;
      } else {
        const center = (solid.min[axis] + solid.max[axis]) / 2;
        position[axis] =
          position[axis] < center
            ? solid.min[axis] - half
            : solid.max[axis] + half;
      }
      velocity[axis] = 0;
    }
  }

  return { pos: position, vel: velocity };
}

/**
 * Vertical resolution: falling contacts land on the solid top (grounded),
 * rising contacts stop at the solid bottom (head bump, not grounded).
 */
export function resolveY(
  pos: Vec3,
  vel: Vec3,
  size: Vec3,
  solids: AABB[]
): { pos: Vec3; vel: Vec3; grounded: boolean } {
  const position: Vec3 = [...pos];
  const velocity: Vec3 = [...vel];
  const half = size[1] / 2;
  let grounded = false;

  for (const solid of solids) {
    if (!penetration(position, size, solid)) continue;
    if (velocity[1] <= 0) {
      position[1] = solid.max[1] + half;
      velocity[1] = 0;
      grounded = true;
    } else {
      position[1] = solid.min[1] - half;
      velocity[1] = 0;
    }
  }

  return { pos: position, vel: velocity, grounded };
}
