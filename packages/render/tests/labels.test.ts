import { afterEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import type { Entity, GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { createState } from "@prompt-to-playable/engine";
import {
  buildFlatLabel,
  buildLabelObject,
  buildLabelSprite,
  flatLabelCanvasSize,
  LABEL_FLAT_CHAR_WIDTH_RATIO,
  LABEL_FLAT_DEFAULT_SIZE,
  LABEL_FLAT_LETTER_SPACING_RATIO,
  LABEL_FLAT_NAME,
  LABEL_FONT_SIZE,
  LABEL_SPRITE_NAME,
  labelCanvasSize,
} from "../src/labels.js";
import { Renderer } from "../src/renderer.js";
import { installFakeDocument, type FakeDom } from "./fake-dom.js";

let fake: FakeDom | null = null;

afterEach(() => {
  fake?.restore();
  fake = null;
});

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
  const result = validateGame({
    version: "1.0.0",
    meta: { title: "Labels Test", archetype: "collect-a-thon" },
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

describe("buildLabelSprite", () => {
  test("node guard: creates a sprite with size/offset but no canvas map", () => {
    expect(typeof document).toBe("undefined");
    const sprite = buildLabelSprite({ text: "Hello" });

    expect(sprite).toBeInstanceOf(THREE.Sprite);
    expect(sprite.name).toBe(LABEL_SPRITE_NAME);
    expect(sprite.material.map).toBeNull();
    expect(sprite.userData.labelText).toBe("Hello");

    const { width, height } = labelCanvasSize("Hello");
    expect(sprite.scale.y).toBeCloseTo(0.9, 6);
    expect(sprite.scale.x).toBeCloseTo(0.9 * (width / height), 6);
    expect(sprite.position.toArray()).toEqual([0, 0, 0]);
  });

  test("honors explicit size and offset and draws a canvas texture", () => {
    fake = installFakeDocument();
    const sprite = buildLabelSprite({
      text: "Crystal",
      size: 2,
      offset: [0, 1.5, 0],
    });

    expect(sprite.position.toArray()).toEqual([0, 1.5, 0]);
    expect(sprite.scale.y).toBeCloseTo(2, 6);

    const map = sprite.material.map;
    expect(map).toBeInstanceOf(THREE.CanvasTexture);
    const image = map!.image as { width: number; height: number };
    expect(image.width).toBeGreaterThan(image.height);
    expect(sprite.scale.x).toBeCloseTo(2 * (image.width / image.height), 6);
    expect(fake.calls).toContain("fillText");
    expect(fake.calls).toContain("fill");
  });

  test("sprite is camera-facing by construction (Three.js Sprite)", () => {
    const sprite = buildLabelSprite({ text: "Face" });
    expect((sprite as THREE.Sprite).isSprite).toBe(true);
  });
});

describe("buildFlatLabel", () => {
  test("node guard: creates a flat plane with default size but no canvas map", () => {
    expect(typeof document).toBe("undefined");
    const mesh = buildFlatLabel({ text: "U1", flat: true });

    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect((mesh as THREE.Mesh).geometry).toBeInstanceOf(THREE.PlaneGeometry);
    expect(mesh.name).toBe(LABEL_FLAT_NAME);
    expect(mesh.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
    expect(mesh.userData.labelText).toBe("U1");
    expect(mesh.position.toArray()).toEqual([0, 0, 0]);
    expect(
      (mesh.material as THREE.MeshBasicMaterial).map
    ).toBeNull();

    const parameters = (
      (mesh as THREE.Mesh).geometry as THREE.PlaneGeometry
    ).parameters;
    const { width, height } = flatLabelCanvasSize("U1");
    expect(parameters.height).toBeCloseTo(LABEL_FLAT_DEFAULT_SIZE, 6);
    expect(parameters.width).toBeCloseTo(
      LABEL_FLAT_DEFAULT_SIZE * (width / height),
      6
    );
  });

  test("honors size and offset, draws uppercase glyphs with letter spacing", () => {
    fake = installFakeDocument();
    const mesh = buildFlatLabel({
      text: "u1",
      size: 1.2,
      offset: [0, 0.51, 0],
      flat: true,
    });

    expect(mesh.position.toArray()).toEqual([0, 0.51, 0]);
    const material = mesh.material as THREE.MeshBasicMaterial;
    const map = material.map;
    expect(map).toBeInstanceOf(THREE.CanvasTexture);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);

    const parameters = (
      (mesh as THREE.Mesh).geometry as THREE.PlaneGeometry
    ).parameters;
    const image = map!.image as { width: number; height: number };
    expect(parameters.height).toBeCloseTo(1.2, 6);
    expect(parameters.width).toBeCloseTo(1.2 * (image.width / image.height), 6);

    const glyphs = fake.events
      .filter((event) => event.method === "fillText")
      .map((event) => event.args[0]);
    expect(glyphs).toEqual(["U", "1"]);
    const xs = fake.events
      .filter((event) => event.method === "fillText")
      .map((event) => event.args[1] as number);
    expect(xs[1]! - xs[0]!).toBeCloseTo(
      LABEL_FONT_SIZE *
        (LABEL_FLAT_CHAR_WIDTH_RATIO + LABEL_FLAT_LETTER_SPACING_RATIO),
      6
    );
    expect(fake.calls).toContain("fillText");
  });
});

describe("buildLabelObject", () => {
  test("flat labels become plane meshes, non-flat stay sprites", () => {
    const flat = buildLabelObject({ text: "PI1", flat: true });
    expect(flat).not.toBeInstanceOf(THREE.Sprite);
    expect(flat.name).toBe(LABEL_FLAT_NAME);
    expect((flat as THREE.Mesh).geometry).toBeInstanceOf(THREE.PlaneGeometry);

    const sprite = buildLabelObject({ text: "PI1" });
    expect(sprite).toBeInstanceOf(THREE.Sprite);
    expect(sprite.name).toBe(LABEL_SPRITE_NAME);
  });
});

describe("labels in the renderer", () => {
  test("attaches the label as a child sprite with the authored offset", () => {
    const { scene, renderer } = newRenderer();
    const gem = ent("gem", "collectible", {
      label: { text: "Gem", offset: [0, 1, 0] },
    });
    renderer.reconcile(createState(validDoc([ent("player", "player"), gem]), 1));

    const view = scene.getObjectByName("gem");
    expect(view).toBeDefined();
    const sprite = view!.getObjectByName(LABEL_SPRITE_NAME) as THREE.Sprite;
    expect(sprite).toBeInstanceOf(THREE.Sprite);
    expect(sprite.position.toArray()).toEqual([0, 1, 0]);
    expect(sprite.userData.entityId).toBe("gem");

    renderer.dispose();
  });

  test("flat label attaches as a plane child that follows the entity rotation", () => {
    const { scene, renderer } = newRenderer();
    const board = ent("board", "prop", {
      rotation: [0, Math.PI / 2, 0],
      label: { text: "SENSOR NODE", flat: true, offset: [0, 0.51, 0] },
    });
    renderer.reconcile(
      createState(validDoc([ent("player", "player"), board]), 1)
    );

    const view = scene.getObjectByName("board")!;
    const label = view.getObjectByName(LABEL_FLAT_NAME) as THREE.Mesh;
    expect(label).toBeInstanceOf(THREE.Mesh);
    expect(label.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    expect(label.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
    expect(label.position.toArray()).toEqual([0, 0.51, 0]);
    expect(label.userData.entityId).toBe("board");
    expect(view.rotation.y).toBeCloseTo(Math.PI / 2, 6);

    view.updateWorldMatrix(true, true);
    const worldNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(
      label.getWorldQuaternion(new THREE.Quaternion())
    );
    expect(worldNormal.y).toBeCloseTo(1, 6);

    renderer.dispose();
  });

  test("removing an entity disposes the flat label geometry, material and map", () => {
    fake = installFakeDocument();
    const { scene, renderer } = newRenderer();
    const board = ent("board", "prop", { label: { text: "U1", flat: true } });
    renderer.reconcile(
      createState(validDoc([ent("player", "player"), board]), 1)
    );

    const label = scene
      .getObjectByName("board")!
      .getObjectByName(LABEL_FLAT_NAME) as THREE.Mesh;
    const geometrySpy = vi.spyOn(label.geometry, "dispose");
    const material = label.material as THREE.MeshBasicMaterial;
    const materialSpy = vi.spyOn(material, "dispose");
    const mapSpy = vi.spyOn(material.map!, "dispose");

    renderer.reconcile(createState(validDoc([ent("player", "player")]), 1));

    expect(scene.getObjectByName("board")).toBeUndefined();
    expect(geometrySpy).toHaveBeenCalledTimes(1);
    expect(materialSpy).toHaveBeenCalledTimes(1);
    expect(mapSpy).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  test("label inherits runtime visibility and is disposed with the entity", () => {
    const { scene, renderer } = newRenderer();
    const gem = ent("gem", "collectible", { label: { text: "Gem" } });
    const state = createState(validDoc([ent("player", "player"), gem]), 1);
    renderer.reconcile(state);

    const view = scene.getObjectByName("gem")!;
    expect(view.visible).toBe(true);

    const hidden = {
      ...state,
      entityRuntime: {
        ...state.entityRuntime,
        gem: { ...state.entityRuntime.gem, visible: false },
      },
    };
    renderer.reconcile(hidden);
    expect(view.visible).toBe(false);
    expect(view.getObjectByName(LABEL_SPRITE_NAME)!.visible).toBe(true);

    renderer.dispose();
    expect(scene.getObjectByName("gem")).toBeUndefined();
  });
});
