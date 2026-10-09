import type { AABB, Vec3 } from "@prompt-to-playable/shared";

export interface Sphere {
  center: Vec3;
  radius: number;
}

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
