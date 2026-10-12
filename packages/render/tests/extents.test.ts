import { describe, expect, test } from "vitest";
import * as THREE from "three";
import type { Entity, GameDoc, Vec3 } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { createState } from "@prompt-to-playable/engine";
import { Renderer } from "../src/renderer.js";

function ent(
  id: string,
  kind: Entity["kind"],
  size?: Vec3,
  position: Vec3 = [0, 0, 0]
): Entity {
  return {
    id: id as Entity["id"],
    kind,
    position,
    tags: [],
    active: true,
    ...(size ? { size } : {}),
  };
}

function validDoc(entities: Entity[]): GameDoc {
  const withPlayer = entities.some((e) => e.kind === "player")
    ? entities
    : [ent("player", "player", undefined, [0, 10, 0]), ...entities];
  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Extents Test", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: withPlayer,
    objectives: [],
    rules: [],
    scratch: {},
  });
  if (!res.ok || !res.data) throw new Error("test doc invalid");
  return res.data;
}

function newRenderer(): { scene: THREE.Scene; renderer: Renderer } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  return { scene, renderer: new Renderer(scene, camera) };
}

function extents(scene: THREE.Scene, id: string): Vec3 {
  const mesh = scene.getObjectByName(id);
  if (!mesh) throw new Error(`no mesh named ${id}`);
  mesh.updateWorldMatrix(true, true);
  const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
  return [size.x, size.y, size.z];
}

function expectExtents(actual: Vec3, expected: Vec3): void {
  for (let axis = 0; axis < 3; axis += 1) {
    expect(actual[axis]).toBeCloseTo(expected[axis], 5);
  }
}

describe("mesh world extents match physics AABB", () => {
  test("player without size renders 0.6 x 1.8 x 0.6", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(createState(validDoc([ent("player", "player")]), 1));

    expectExtents(extents(scene, "player"), [0.6, 1.8, 0.6]);
    renderer.dispose();
  });

  test("player with size [1, 2, 1] renders 1 x 2 x 1", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(
      createState(validDoc([ent("player", "player", [1, 2, 1])]), 1)
    );

    expectExtents(extents(scene, "player"), [1, 2, 1]);
    renderer.dispose();
  });

  test("platform with size [4, 0.5, 4] renders 4 x 0.5 x 4", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(
      createState(validDoc([ent("plat", "platform", [4, 0.5, 4])]), 1)
    );

    expectExtents(extents(scene, "plat"), [4, 0.5, 4]);
    renderer.dispose();
  });

  test("default entity without size renders 1 x 1 x 1", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(createState(validDoc([ent("prop", "prop")]), 1));

    expectExtents(extents(scene, "prop"), [1, 1, 1]);
    renderer.dispose();
  });

  test("zone without size renders 2 x 2 x 2 and stays visible", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(createState(validDoc([ent("zone", "zone")]), 1));

    const mesh = scene.getObjectByName("zone");
    expect(mesh?.visible).toBe(true);
    expectExtents(extents(scene, "zone"), [2, 2, 2]);
    renderer.dispose();
  });

  test("reconcile with a changed size updates rendered extents", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(
      createState(validDoc([ent("player", "player", [0.6, 1.8, 0.6])]), 1)
    );
    expectExtents(extents(scene, "player"), [0.6, 1.8, 0.6]);

    renderer.reconcile(
      createState(validDoc([ent("player", "player", [2, 4, 2])]), 1)
    );
    expectExtents(extents(scene, "player"), [2, 4, 2]);
    renderer.dispose();
  });
});
