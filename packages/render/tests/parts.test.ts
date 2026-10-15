import { afterEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import type { Entity, GameDoc, Part, PartShape } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import {
  createState,
  type EntityRuntime,
  type GameState,
} from "@prompt-to-playable/engine";
import { buildPartsObject } from "../src/parts.js";
import { Renderer } from "../src/renderer.js";
import { TEXTURE_CLONE_KEY, CIRCUIT_TILE_WORLD_SIZE, textureForName } from "../src/textures.js";
import { installFakeDocument, type FakeDom } from "./fake-dom.js";

let fake: FakeDom | null = null;

afterEach(() => {
  fake?.restore();
  fake = null;
});

const PART_SHAPES: PartShape[] = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "capsule",
  "wedge",
  "plane",
];

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

function part(shape: PartShape, extra: Partial<Part> = {}): Part {
  return { shape, offset: [0, 0, 0], size: [1, 1, 1], ...extra };
}

function validDoc(entities: Entity[]): GameDoc {
  const withPlayer = entities.some((entity) => entity.kind === "player")
    ? entities
    : [ent("player", "player"), ...entities];
  const result = validateGame({
    version: "1.0.0",
    meta: { title: "Parts Test", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: withPlayer,
    objectives: [],
    rules: [],
    scratch: {},
  });
  if (!result.ok || !result.data) throw new Error("test doc invalid");
  return result.data;
}

function newRenderer(): { scene: THREE.Scene; renderer: Renderer } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  return { scene, renderer: new Renderer(scene, camera) };
}

function withRuntime(
  state: GameState,
  id: string,
  patch: Partial<EntityRuntime>
): GameState {
  const runtime = state.entityRuntime[id];
  if (!runtime) throw new Error(`no runtime for ${id}`);
  return {
    ...state,
    entityRuntime: { ...state.entityRuntime, [id]: { ...runtime, ...patch } },
  };
}

function pulseAnimation(pulse: number): EntityRuntime["animations"] {
  return [
    { kind: "pulse", elapsed: 0, basePos: [0, 0, 0], baseRot: [0, 0, 0], pulse },
  ];
}

function materialOf(mesh: THREE.Object3D): THREE.MeshStandardMaterial {
  return (mesh as THREE.Mesh).material as THREE.MeshStandardMaterial;
}

describe("buildPartsObject", () => {
  test("builds one mesh per part with local offset, rotation and size", () => {
    const group = buildPartsObject(
      ent("machine", "prop", {
        parts: [
          part("box", { offset: [0, 0.25, 0], size: [1, 0.5, 1] }),
          part("cylinder", {
            offset: [0.4, 0, 0],
            rotation: [0, 0, Math.PI / 2],
            size: [0.2, 0.6, 0.2],
          }),
        ],
      })
    );

    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.userData.partsObject).toBe(true);
    expect(group.children).toHaveLength(2);

    const [first, second] = group.children as THREE.Mesh[];
    expect(first).toBeInstanceOf(THREE.Mesh);
    expect(first.position.toArray()).toEqual([0, 0.25, 0]);
    expect(first.scale.toArray()).toEqual([1, 0.5, 1]);
    expect(first.userData.partShape).toBe("box");
    expect(second.position.toArray()).toEqual([0.4, 0, 0]);
    expect(second.rotation.z).toBeCloseTo(Math.PI / 2, 6);
    expect(second.scale.toArray()).toEqual([0.2, 0.6, 0.2]);
  });

  test("every default part shape stays inside the unit cube", () => {
    for (const shape of PART_SHAPES) {
      const group = buildPartsObject(
        ent("p", "prop", { parts: [part(shape)] })
      );
      group.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3());

      expect(size.x, shape).toBeLessThanOrEqual(1 + 1e-6);
      expect(size.y, shape).toBeLessThanOrEqual(1 + 1e-6);
      expect(size.z, shape).toBeLessThanOrEqual(1 + 1e-6);
      expect(box.min.x, shape).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(box.min.y, shape).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(box.min.z, shape).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(box.max.x, shape).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(box.max.y, shape).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(box.max.z, shape).toBeLessThanOrEqual(0.5 + 1e-6);

      expect(size.y, shape).toBeGreaterThan(0.5);
      if (shape !== "plane") {
        expect(size.z, shape).toBeGreaterThan(0.1);
      }
    }
  });

  test("clamps material numerics and marks translucent parts", () => {
    const group = buildPartsObject(
      ent("p", "prop", {
        parts: [
          part("box", {
            material: { metalness: 5, roughness: -2, opacity: 2 },
          }),
          part("sphere", { material: { opacity: 0.4 } }),
        ],
      })
    );

    const [opaque, translucent] = group.children as THREE.Mesh[];
    const first = materialOf(opaque);
    expect(first.metalness).toBe(1);
    expect(first.roughness).toBe(0);
    expect(first.opacity).toBe(1);
    expect(first.transparent).toBe(false);
    expect(first.depthWrite).toBe(true);

    const second = materialOf(translucent);
    expect(second.opacity).toBeCloseTo(0.4, 6);
    expect(second.transparent).toBe(true);
    expect(second.depthWrite).toBe(false);
  });

  test("glass texture uses translucent parameters instead of a map", () => {
    const group = buildPartsObject(
      ent("p", "prop", {
        parts: [
          part("box", { material: { texture: "glass" } }),
          part("box", { material: { texture: "glass", opacity: 0.8 } }),
        ],
      })
    );

    const [glass, explicit] = group.children as THREE.Mesh[];
    const material = materialOf(glass);
    expect(material.map).toBeNull();
    expect(material.opacity).toBeCloseTo(0.25, 6);
    expect(material.roughness).toBeCloseTo(0.1, 6);
    expect(material.transparent).toBe(true);
    expect(material.side).toBe(THREE.DoubleSide);

    const custom = materialOf(explicit);
    expect(custom.opacity).toBeCloseTo(0.8, 6);
    expect(custom.roughness).toBeCloseTo(0.1, 6);
  });

  test("emissive strings and texture maps apply when a document exists", () => {
    fake = installFakeDocument();
    const group = buildPartsObject(
      ent("p", "prop", {
        parts: [
          part("box", { material: { emissive: "#ff0000" } }),
          part("box", { material: { texture: "circuit" } }),
        ],
      })
    );

    const [glowing, textured] = group.children as THREE.Mesh[];
    expect(materialOf(glowing).emissive.r).toBeCloseTo(1, 6);
    expect(materialOf(textured).map).toBeInstanceOf(THREE.CanvasTexture);
  });

  test("circuit repeats per part footprint; other textures stay shared", () => {
    fake = installFakeDocument();
    const group = buildPartsObject(
      ent("p", "prop", {
        parts: [
          part("box", { size: [4, 0.1, 2], material: { texture: "circuit" } }),
          part("box", { size: [2, 0.1, 2], material: { texture: "wood" } }),
        ],
      })
    );

    const [board, plank] = group.children as THREE.Mesh[];
    const boardMap = materialOf(board).map;
    expect(boardMap).toBeInstanceOf(THREE.CanvasTexture);
    expect(boardMap!.repeat.x).toBe(4 / CIRCUIT_TILE_WORLD_SIZE);
    expect(boardMap!.repeat.y).toBe(2 / CIRCUIT_TILE_WORLD_SIZE);
    expect(boardMap!.userData[TEXTURE_CLONE_KEY]).toBe(true);

    expect(materialOf(plank).map).toBe(textureForName("wood"));
  });
});

describe("parts in the renderer", () => {
  test("entity with parts becomes a Group and parts win over props.shape", () => {
    const { scene, renderer } = newRenderer();
    const machine = ent("machine", "prop", {
      props: { shape: "tree" },
      parts: [part("box"), part("sphere")],
    });
    renderer.reconcile(createState(validDoc([machine]), 1));

    const group = scene.getObjectByName("machine");
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group!.children).toHaveLength(2);
    for (const child of group!.children) {
      expect(child).toBeInstanceOf(THREE.Mesh);
    }

    renderer.dispose();
    expect(scene.getObjectByName("machine")).toBeUndefined();
  });

  test("entity size scales the parts group to the physics extents", () => {
    const { scene, renderer } = newRenderer();
    const machine = ent("machine", "prop", {
      size: [2, 4, 2],
      parts: [part("box")],
    });
    renderer.reconcile(createState(validDoc([machine]), 1));

    const group = scene.getObjectByName("machine")!;
    expect(group.scale.toArray()).toEqual([2, 4, 2]);
    group.updateWorldMatrix(true, true);
    const size = new THREE.Box3()
      .setFromObject(group)
      .getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(2, 5);
    expect(size.y).toBeCloseTo(4, 5);
    expect(size.z).toBeCloseTo(2, 5);

    renderer.dispose();
  });

  test("runtime color re-tints colorless parts, keeps explicit colors, restores", () => {
    const { scene, renderer } = newRenderer();
    const machine = ent("machine", "prop", {
      parts: [
        part("box", { color: "#00ff00" }),
        part("sphere"),
      ],
    });
    const state = createState(validDoc([machine]), 1);
    renderer.reconcile(state);

    const group = scene.getObjectByName("machine") as THREE.Group;
    const [explicit, tintable] = group.children as THREE.Mesh[];
    const explicitMaterial = materialOf(explicit);
    const tintableMaterial = materialOf(tintable);
    const baseHex = tintableMaterial.color.getHexString();
    expect(baseHex).toBe(new THREE.Color("#94a3b8").getHexString());

    renderer.reconcile(withRuntime(state, "machine", { color: "#ff0000" }));
    expect(explicitMaterial.color.getHexString()).toBe("00ff00");
    expect(tintableMaterial.color.getHexString()).toBe("ff0000");

    renderer.reconcile(withRuntime(state, "machine", { color: "#0000ff" }));
    expect(tintableMaterial.color.getHexString()).toBe("0000ff");

    renderer.reconcile(withRuntime(state, "machine", {}));
    expect(tintableMaterial.color.getHexString()).toBe(baseHex);

    renderer.dispose();
  });

  test("pulse animations scale the root without compounding", () => {
    const { scene, renderer } = newRenderer();
    const gem = ent("gem", "collectible", { parts: [part("box")] });
    const state = createState(validDoc([gem]), 1);
    renderer.reconcile(state);

    const view = scene.getObjectByName("gem")!;
    expect(view.scale.x).toBeCloseTo(1, 6);

    const half = withRuntime(state, "gem", { animations: pulseAnimation(0.5) });
    renderer.reconcile(half);
    expect(view.scale.x).toBeCloseTo(1 + 0.06 * 0.5, 6);
    renderer.reconcile(half);
    expect(view.scale.x).toBeCloseTo(1.03, 6);

    renderer.reconcile(withRuntime(state, "gem", { animations: pulseAnimation(1) }));
    expect(view.scale.x).toBeCloseTo(1.06, 6);

    renderer.reconcile(state);
    expect(view.scale.x).toBeCloseTo(1, 6);

    renderer.dispose();
  });

  test("setHighlight applies a 1.06 root scale, is idempotent and clears", () => {
    const { scene, renderer } = newRenderer();
    const crate = ent("crate", "prop");
    const state = createState(validDoc([crate]), 1);
    renderer.reconcile(state);

    const view = scene.getObjectByName("crate")!;
    expect(renderer.highlightedId).toBeNull();
    expect(view.scale.x).toBeCloseTo(1, 6);

    renderer.setHighlight("crate");
    expect(renderer.highlightedId).toBe("crate");
    expect(view.scale.x).toBeCloseTo(1.06, 6);

    renderer.setHighlight("crate");
    expect(view.scale.x).toBeCloseTo(1.06, 6);

    renderer.reconcile(state);
    expect(view.scale.x).toBeCloseTo(1.06, 6);

    renderer.setHighlight(null);
    expect(renderer.highlightedId).toBeNull();
    expect(view.scale.x).toBeCloseTo(1, 6);

    renderer.setHighlight(null);
    expect(view.scale.x).toBeCloseTo(1, 6);

    renderer.setHighlight("missing");
    expect(view.scale.x).toBeCloseTo(1, 6);
    renderer.setHighlight(null);

    renderer.dispose();
  });

  test("removing a circuit board disposes its cloned map, never the cached texture", () => {
    fake = installFakeDocument();
    const { scene, renderer } = newRenderer();
    const board = ent("board", "prop", {
      parts: [
        part("box", {
          size: [2, 0.1, 2],
          material: { texture: "circuit" },
        }),
      ],
    });
    renderer.reconcile(createState(validDoc([board]), 1));

    const mesh = (scene.getObjectByName("board") as THREE.Group)
      .children[0] as THREE.Mesh;
    const map = materialOf(mesh).map!;
    const mapSpy = vi.spyOn(map, "dispose");
    const cachedSpy = vi.spyOn(textureForName("circuit")!, "dispose");

    renderer.reconcile(createState(validDoc([]), 1));

    expect(mapSpy).toHaveBeenCalledTimes(1);
    expect(cachedSpy).not.toHaveBeenCalled();
    renderer.dispose();
  });

  test("visible=false hides the entity view; visible=true restores it", () => {
    const { scene, renderer } = newRenderer();
    const machine = ent("machine", "prop", {
      parts: [part("box")],
      label: { text: "Machine" },
    });
    const state = createState(validDoc([machine]), 1);
    renderer.reconcile(state);

    const view = scene.getObjectByName("machine")!;
    expect(view.visible).toBe(true);

    renderer.reconcile(withRuntime(state, "machine", { visible: false }));
    expect(view.visible).toBe(false);

    renderer.reconcile(withRuntime(state, "machine", { visible: true }));
    expect(view.visible).toBe(true);

    renderer.dispose();
  });
});
