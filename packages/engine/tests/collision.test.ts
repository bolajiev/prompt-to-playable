import { describe, expect, test } from "vitest";
import type { AABB, Vec3 } from "@prompt-to-playable/shared";
import {
  aabbOverlap,
  pointInAABB,
  sphereOverlap,
  type Sphere,
} from "../src/collision.js";

const unitBox: AABB = { min: [0, 0, 0], max: [2, 2, 2] };

describe("pointInAABB", () => {
  test("returns true for a point strictly inside", () => {
    expect(pointInAABB([1, 1, 1], unitBox)).toBe(true);
  });

  test("returns true for points on the boundary", () => {
    expect(pointInAABB([0, 0, 0], unitBox)).toBe(true);
    expect(pointInAABB([2, 2, 2], unitBox)).toBe(true);
  });

  test("returns false for a point outside on one axis", () => {
    expect(pointInAABB([3, 1, 1], unitBox)).toBe(false);
    expect(pointInAABB([1, -0.01, 1], unitBox)).toBe(false);
  });
});

describe("aabbOverlap", () => {
  test("returns true for overlapping boxes", () => {
    const other: AABB = { min: [1, 1, 1], max: [3, 3, 3] };
    expect(aabbOverlap(unitBox, other)).toBe(true);
    expect(aabbOverlap(other, unitBox)).toBe(true);
  });

  test("returns true when one box contains another", () => {
    const inner: AABB = { min: [0.5, 0.5, 0.5], max: [1.5, 1.5, 1.5] };
    expect(aabbOverlap(unitBox, inner)).toBe(true);
  });

  test("returns true when boxes only touch on a face", () => {
    const touching: AABB = { min: [2, 0, 0], max: [4, 2, 2] };
    expect(aabbOverlap(unitBox, touching)).toBe(true);
  });

  test("returns false when separated on x", () => {
    const far: AABB = { min: [2.01, 0, 0], max: [4, 2, 2] };
    expect(aabbOverlap(unitBox, far)).toBe(false);
  });

  test("returns false when separated only on z", () => {
    const far: AABB = { min: [0, 0, 5], max: [2, 2, 7] };
    expect(aabbOverlap(unitBox, far)).toBe(false);
  });
});

describe("sphereOverlap", () => {
  const sphere = (center: Vec3, radius: number): Sphere => ({ center, radius });

  test("returns true when spheres overlap", () => {
    expect(sphereOverlap(sphere([0, 0, 0], 1), sphere([1.5, 0, 0], 1))).toBe(
      true
    );
  });

  test("returns true when spheres exactly touch", () => {
    expect(sphereOverlap(sphere([0, 0, 0], 1), sphere([2, 0, 0], 1))).toBe(true);
  });

  test("returns false when spheres are apart", () => {
    expect(sphereOverlap(sphere([0, 0, 0], 1), sphere([2.5, 0, 0], 1))).toBe(
      false
    );
  });
});
