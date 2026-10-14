import { afterEach, describe, expect, test } from "vitest";
import * as THREE from "three";
import type { Entity, GameDoc } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { createState } from "@prompt-to-playable/engine";
import {
  buildLabelSprite,
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
