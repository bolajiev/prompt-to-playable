import { describe, expect, test } from "vitest";
import * as THREE from "three";
import type { Entity, GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { createState } from "@prompt-to-playable/engine";
import { entityColor } from "../src/scene.js";
import { Renderer } from "../src/renderer.js";

function ent(id: string, kind: Entity["kind"]): Entity {
  return {
    id: id as Entity["id"],
    kind,
    position: [0, 0, 0],
    tags: [],
    active: true,
  };
}

function validDoc(entities: Entity[]): GameDoc {
  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Materials Test", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: [ent("player", "player"), ...entities],
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

function meshMaterial(scene: THREE.Scene, id: string): THREE.Material {
  const mesh = scene.getObjectByName(id) as THREE.Mesh | undefined;
  if (!mesh) throw new Error(`no mesh named ${id}`);
  if (Array.isArray(mesh.material)) throw new Error(`${id} has material array`);
  return mesh.material;
}

describe("kind materials", () => {
  test("zones render as translucent, non-depth-writing volumes", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(createState(validDoc([ent("zone", "zone")]), 1));

    const material = meshMaterial(scene, "zone") as THREE.MeshBasicMaterial;
    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBeGreaterThanOrEqual(0.15);
    expect(material.opacity).toBeLessThanOrEqual(0.25);
    expect(material.depthWrite).toBe(false);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.color.getHexString()).toBe(
      new THREE.Color(entityColor(ent("zone", "zone"))).getHexString()
    );

    renderer.reconcile(createState(validDoc([ent("zone", "zone")]), 1));
    const afterUpdate = meshMaterial(scene, "zone") as THREE.MeshBasicMaterial;
    expect(afterUpdate.transparent).toBe(true);
    expect(afterUpdate.depthWrite).toBe(false);

    renderer.dispose();
  });

  test("all non-zone kinds stay opaque", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(
      createState(
        validDoc([
          ent("gem", "collectible"),
          ent("guard", "enemy"),
          ent("prop", "prop"),
          ent("beam", "beam"),
        ]),
        1
      )
    );

    for (const id of ["player", "gem", "guard", "prop", "beam"]) {
      const material = meshMaterial(scene, id);
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
    }

    renderer.dispose();
  });

  test("collectibles and enemies are slightly emissive; props are not", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(
      createState(
        validDoc([ent("gem", "collectible"), ent("guard", "enemy"), ent("prop", "prop")]),
        1
      )
    );

    const gem = meshMaterial(scene, "gem") as THREE.MeshStandardMaterial;
    const guard = meshMaterial(scene, "guard") as THREE.MeshStandardMaterial;
    const prop = meshMaterial(scene, "prop") as THREE.MeshStandardMaterial;
    expect(gem.emissive.getHex()).not.toBe(0);
    expect(guard.emissive.getHex()).not.toBe(0);
    expect(prop.emissive.getHex()).toBe(0);

    renderer.dispose();
  });
});
