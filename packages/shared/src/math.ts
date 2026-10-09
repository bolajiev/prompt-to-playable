export type Vec3 = [number, number, number];
export interface AABB {
  min: Vec3;
  max: Vec3;
}
export function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
