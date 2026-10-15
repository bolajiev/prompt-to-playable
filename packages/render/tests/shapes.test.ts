import { describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import type { Entity, GameDoc, Vec3 } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { createState } from "@prompt-to-playable/engine";
import { Renderer } from "../src/renderer.js";
import {
  applyShapeColor,
  createShapeObject,
  PIN_GOLD_COLOR,
  PROP_SHAPES,
  resolvePropShape,
  type PropShape,
} from "../src/shapes.js";

function ent(
  id: string,
  kind: Entity["kind"],
  extra: Partial<Entity> = {}
): Entity {
  return {
    id: id as Entity["id"],
    kind,
    position: [0, 0, 0],
    tags: [],
    active: true,
    ...extra,
  };
}

function validDoc(entities: Entity[]): GameDoc {
  const withPlayer = entities.some((entity) => entity.kind === "player")
    ? entities
    : [ent("player", "player"), ...entities];
  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Shapes Test", archetype: "collect-a-thon" },
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

function prop(
  id: string,
  props?: Record<string, string | number | boolean>,
  color?: string
): Entity {
  return ent(id, "prop", {
    ...(props ? { props } : {}),
    ...(color ? { color } : {}),
  });
}

const SHAPE_CHILD_COUNT: Record<PropShape, number> = {
  tree: 2,
  rock: 1,
  campfire: 4,
  pillar: 1,
  statue: 2,
  lamp: 2,
  table: 5,
  flower: 2,
  building: 5,
  chip: 9,
  header: 11,
  capacitor: 2,
  led: 1,
  hole: 1,
};

const GOLD_HEX = new THREE.Color(PIN_GOLD_COLOR).getHexString();

function materialAt(mesh: THREE.Object3D): THREE.MeshStandardMaterial {
  return (mesh as THREE.Mesh).material as THREE.MeshStandardMaterial;
}

describe("resolvePropShape", () => {
  test("resolves every vocabulary shape id", () => {
    for (const shape of PROP_SHAPES) {
      expect(resolvePropShape({ shape })).toBe(shape);
    }
  });

  test("unknown or non-string shapes fall back to box", () => {
    expect(resolvePropShape({ shape: "castle" })).toBe("box");
    expect(resolvePropShape({ shape: "" })).toBe("box");
    expect(resolvePropShape({ shape: 3 })).toBe("box");
    expect(resolvePropShape({ shape: true })).toBe("box");
  });

  test("missing props or missing shape fall back to box", () => {
    expect(resolvePropShape(undefined)).toBe("box");
    expect(resolvePropShape({})).toBe("box");
    expect(resolvePropShape({ color: "red", solid: true })).toBe("box");
  });
});

describe("createShapeObject", () => {
  test("builds a Group with the expected primitive parts per shape", () => {
    for (const shape of PROP_SHAPES) {
      const group = createShapeObject(shape, "#4ade80");
      expect(group, shape).toBeInstanceOf(THREE.Group);
      expect(group.userData.propShape, shape).toBe(shape);
      expect(group.children.length, shape).toBe(SHAPE_CHILD_COUNT[shape]);
      for (const child of group.children) {
        const mesh = child as THREE.Mesh;
        expect(mesh, shape).toBeInstanceOf(THREE.Mesh);
        expect(mesh.geometry, shape).toBeInstanceOf(THREE.BufferGeometry);
        expect(mesh.material, shape).toBeInstanceOf(THREE.Material);
      }
    }
  });

  test("every shape stays inside the unit cube", () => {
    for (const shape of PROP_SHAPES) {
      const group = createShapeObject(shape, "#94a3b8");
      group.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3());
      expect(size.x, shape).toBeLessThanOrEqual(1 + 1e-6);
      expect(size.y, shape).toBeLessThanOrEqual(1 + 1e-6);
      expect(size.z, shape).toBeLessThanOrEqual(1 + 1e-6);
      expect(box.min.y, shape).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(box.max.y, shape).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });

  test("parts derive their colors from the entity color", () => {
    const group = createShapeObject("tree", "#ff0000");
    const materials = group.children.map(
      (child) => (child as THREE.Mesh).material as THREE.MeshStandardMaterial
    );
    for (const material of materials) {
      expect(material.color.r).toBeGreaterThan(0);
      expect(material.color.g).toBe(0);
      expect(material.color.b).toBe(0);
    }
    expect(materials[0]?.color.r).toBeLessThan(materials[1]!.color.r);
  });
});

describe("PCB composite shapes", () => {
  test("chip has a dark body and two gold pin rows", () => {
    const group = createShapeObject("chip", "#ff0000");
    expect(group.children.length).toBe(9);

    const body = materialAt(group.children[0]!);
    expect(body.color.r).toBeGreaterThan(0);
    expect(body.color.g).toBe(0);
    expect(body.color.r).toBeLessThan(0.3);

    const pins = group.children.slice(1) as THREE.Mesh[];
    for (const pin of pins) {
      expect(pin.geometry.type).toBe("CylinderGeometry");
      expect(materialAt(pin).color.getHexString()).toBe(GOLD_HEX);
    }
    const xPositions = new Set(pins.map((pin) => pin.position.x.toFixed(4)));
    expect(xPositions.size).toBe(2);
  });

  test("chip pin count follows the size aspect ratio, clamped to 10 per row", () => {
    const wide = createShapeObject("chip", "#94a3b8", [2, 0.2, 1]);
    expect(wide.children.length).toBe(1 + 2 * 8);

    const extreme = createShapeObject("chip", "#94a3b8", [4, 0.2, 0.5]);
    expect(extreme.children.length).toBe(1 + 2 * 10);
  });

  test("applyShapeColor re-tints the chip body but never the gold pins", () => {
    const group = createShapeObject("chip", "#00ff00");
    applyShapeColor(group, "#0000ff");

    const body = materialAt(group.children[0]!);
    expect(body.color.b).toBeGreaterThan(0);
    expect(body.color.g).toBe(0);

    for (const pin of group.children.slice(1)) {
      expect(materialAt(pin).color.getHexString()).toBe(GOLD_HEX);
    }
  });

  test("header is a black strip with a double row of gold pins on top", () => {
    const group = createShapeObject("header", "#94a3b8");
    expect(group.children.length).toBe(11);

    const strip = group.children[0] as THREE.Mesh;
    expect(strip.geometry.type).toBe("BoxGeometry");
    const stripTop = strip.position.y + 0.5 * (strip.geometry as THREE.BoxGeometry).parameters.height;
    expect(stripTop).toBeCloseTo(-0.21, 6);

    const pins = group.children.slice(1) as THREE.Mesh[];
    const zPositions = new Set(pins.map((pin) => pin.position.z.toFixed(4)));
    expect(zPositions.size).toBe(2);
    for (const pin of pins) {
      expect(pin.geometry.type).toBe("CylinderGeometry");
      expect(materialAt(pin).color.getHexString()).toBe(GOLD_HEX);
      expect(pin.position.y).toBeGreaterThan(stripTop);
      const bottom =
        pin.position.y -
        0.5 * (pin.geometry as THREE.CylinderGeometry).parameters.height;
      expect(bottom).toBeGreaterThan(stripTop - 0.01);
    }
  });

  test("capacitor is a black can with a lighter top disc", () => {
    const group = createShapeObject("capacitor", "#94a3b8");
    expect(group.children.length).toBe(2);

    const [body, disc] = group.children as THREE.Mesh[];
    expect(body.geometry.type).toBe("CylinderGeometry");
    expect(disc.geometry.type).toBe("CylinderGeometry");
    const bodyColor = materialAt(body).color;
    const discColor = materialAt(disc).color;
    const bodyLuma = bodyColor.r + bodyColor.g + bodyColor.b;
    const discLuma = discColor.r + discColor.g + discColor.b;
    expect(bodyLuma).toBeLessThan(discLuma);
    expect(disc.position.y).toBeGreaterThan(body.position.y);
  });

  test("led is a single emissive cylinder using the entity color", () => {
    const group = createShapeObject("led", "#ff0000");
    expect(group.children.length).toBe(1);
    const lens = materialAt(group.children[0]!);
    expect(lens.color.r).toBeCloseTo(1, 6);
    expect(lens.emissive.r).toBeGreaterThan(0.5);
    expect(lens.emissive.g).toBe(0);
  });

  test("hole is a flat black torus spanning the unit box", () => {
    const group = createShapeObject("hole", "#94a3b8");
    expect(group.children.length).toBe(1);
    const torus = group.children[0] as THREE.Mesh;
    expect(torus.geometry.type).toBe("TorusGeometry");
    expect(torus.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
    const color = materialAt(torus).color;
    expect(color.r).toBeLessThan(0.15);
    expect(color.g).toBeLessThan(0.15);
    expect(color.b).toBeLessThan(0.15);

    group.updateWorldMatrix(true, true);
    const size = new THREE.Box3()
      .setFromObject(group)
      .getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(1, 3);
    expect(size.z).toBeCloseTo(1, 3);
    expect(size.y).toBeCloseTo(0.2, 3);
  });
});

describe("shaped props in the renderer", () => {
  test("prop without props.shape keeps the default unit box", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(createState(validDoc([prop("crate")]), 1));

    const view = scene.getObjectByName("crate") as THREE.Mesh;
    expect(view).toBeInstanceOf(THREE.Mesh);
    expect(view).not.toBeInstanceOf(THREE.Group);
    expect(view.geometry.type).toBe("BoxGeometry");
    const material = view.material as THREE.MeshStandardMaterial;
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material.emissive.getHex()).toBe(0);

    view.updateWorldMatrix(true, true);
    const size = new THREE.Box3().setFromObject(view).getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(1, 5);
    expect(size.y).toBeCloseTo(1, 5);
    expect(size.z).toBeCloseTo(1, 5);
    renderer.dispose();
  });

  test("unknown props.shape also renders through the default box path", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(
      createState(validDoc([prop("weird", { shape: "castle" })]), 1)
    );

    const view = scene.getObjectByName("weird") as THREE.Mesh;
    expect(view).toBeInstanceOf(THREE.Mesh);
    expect(view.geometry.type).toBe("BoxGeometry");
    renderer.dispose();
  });

  test("shaped prop becomes a group that follows position and scale", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(
      createState(validDoc([prop("tree", { shape: "tree" }, "forestgreen")]), 1)
    );
    const first = scene.getObjectByName("tree") as THREE.Group;
    expect(first).toBeInstanceOf(THREE.Group);
    expect(first.children.length).toBe(SHAPE_CHILD_COUNT.tree);

    renderer.reconcile(
      createState(
        validDoc([
          ent("tree", "prop", {
            props: { shape: "tree" },
            position: [2, 1, -3] as Vec3,
            size: [2, 4, 2] as Vec3,
          }),
        ]),
        1
      )
    );

    const group = scene.getObjectByName("tree") as THREE.Group;
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group).not.toBe(first);
    expect(group.children.length).toBe(SHAPE_CHILD_COUNT.tree);
    expect(group.position.toArray()).toEqual([2, 1, -3]);
    expect(group.scale.toArray()).toEqual([2, 4, 2]);
    renderer.dispose();
  });

  test("chip pin count reflects the authored entity size", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(
      createState(
        validDoc([
          ent("u1", "prop", {
            props: { shape: "chip" },
            size: [2, 0.2, 1] as Vec3,
          }),
        ]),
        1
      )
    );

    const group = scene.getObjectByName("u1") as THREE.Group;
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children.length).toBe(1 + 2 * 8);
    renderer.dispose();
  });

  test("update re-tints every tagged child material after a color change", () => {
    const { scene, renderer } = newRenderer();
    const state = createState(
      validDoc([prop("fire", { shape: "campfire" }, "red")]),
      1
    );
    renderer.reconcile(state);
    const group = scene.getObjectByName("fire") as THREE.Group;

    const blueFire = prop("fire", { shape: "campfire" }, "blue");
    renderer.reconcile({
      ...state,
      entities: state.entities.map((entity) =>
        entity.id === blueFire.id ? blueFire : entity
      ),
    });
    expect(scene.getObjectByName("fire")).toBe(group);

    const materials = group.children.map(
      (child) => (child as THREE.Mesh).material as THREE.MeshStandardMaterial
    );
    for (const material of materials) {
      expect(material.color.b).toBeGreaterThan(material.color.r);
    }
    const ember = materials.find((m) => m.emissive.getHex() !== 0);
    expect(ember).toBeDefined();
    expect(ember!.emissive.b).toBeGreaterThan(0);
    renderer.dispose();
  });

  test("removing a shaped prop disposes every child geometry and material", () => {
    const { scene, renderer } = newRenderer();
    renderer.reconcile(
      createState(validDoc([prop("table", { shape: "table" })]), 1)
    );

    const group = scene.getObjectByName("table") as THREE.Group;
    const meshes = group.children as THREE.Mesh[];
    const geometrySpies = meshes.map((mesh) =>
      vi.spyOn(mesh.geometry, "dispose")
    );
    const materials = new Set<THREE.Material>();
    for (const mesh of meshes) {
      const material = mesh.material;
      for (const entry of Array.isArray(material) ? material : [material]) {
        materials.add(entry);
      }
    }
    const materialSpies = [...materials].map((material) =>
      vi.spyOn(material, "dispose")
    );

    renderer.reconcile(createState(validDoc([]), 1));

    expect(scene.getObjectByName("table")).toBeUndefined();
    for (const spy of geometrySpies) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of materialSpies) expect(spy).toHaveBeenCalled();
    renderer.dispose();
  });
});
