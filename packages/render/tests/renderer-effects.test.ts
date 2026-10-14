import { describe, expect, test } from "vitest";
import * as THREE from "three";
import type { Entity, GameDoc, Vec3 } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import {
  createState,
  type GameState,
  type GameStatus,
} from "@prompt-to-playable/engine";
import { idleSway, spinPhase, walkBob } from "../src/animation.js";
import {
  BURST_PROFILES,
  PARTICLE_SYSTEM_NAME,
  type ParticleBurstKind,
} from "../src/particles.js";
import {
  HIGHLIGHT_RING_NAME,
  Renderer,
} from "../src/renderer.js";

function ent(
  id: string,
  kind: Entity["kind"],
  position: Vec3 = [0, 0, 0]
): Entity {
  return {
    id: id as Entity["id"],
    kind,
    position,
    tags: [],
    active: true,
  };
}

function validDoc(entities: Entity[]): GameDoc {
  const withPlayer = entities.some((entity) => entity.kind === "player")
    ? entities
    : [ent("player", "player"), ...entities];
  const result = validateGame({
    version: "1.0.0",
    meta: { title: "Effects Test", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: withPlayer,
    objectives: [],
    rules: [],
    scratch: {},
  });
  if (!result.ok || !result.data) throw new Error("test doc invalid");
  return result.data;
}

function newRenderer(): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: Renderer;
} {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(5, 5, 5);
  return { scene, camera, renderer: new Renderer(scene, camera) };
}

interface StatePatch {
  time?: number;
  status?: GameStatus;
  positions?: Record<string, Vec3>;
  remove?: string[];
}

/** Derive a new snapshot that shares `state.doc` (renderer effect continuity). */
function derive(state: GameState, patch: StatePatch = {}): GameState {
  let entities = state.entities;
  let entityRuntime = state.entityRuntime;

  if (patch.positions) {
    entityRuntime = { ...entityRuntime };
    for (const [id, position] of Object.entries(patch.positions)) {
      const runtime = entityRuntime[id];
      if (!runtime) continue;
      entityRuntime[id] = { ...runtime, position: [...position] as Vec3 };
    }
  }

  if (patch.remove && patch.remove.length > 0) {
    const removed = new Set(patch.remove);
    entities = entities.filter((entity) => !removed.has(entity.id));
    entityRuntime = { ...entityRuntime };
    for (const id of patch.remove) delete entityRuntime[id];
  }

  return {
    ...state,
    time: patch.time ?? state.time,
    status: patch.status ?? state.status,
    entities,
    entityRuntime,
  };
}

function mesh(scene: THREE.Scene, id: string): THREE.Mesh {
  const found = scene.getObjectByName(id);
  if (!found) throw new Error(`no mesh named ${id}`);
  return found as THREE.Mesh;
}

function extents(object: THREE.Object3D): Vec3 {
  object.updateWorldMatrix(true, true);
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  return [size.x, size.y, size.z];
}

describe("entity animation", () => {
  test("player bobs and yaws toward its movement direction", () => {
    const doc = validDoc([ent("player", "player")]);
    const state = createState(doc, 1);
    const { scene, renderer } = newRenderer();
    renderer.reconcile(state);
    const player = mesh(scene, "player");
    expect(player.rotation.y).toBe(0);

    renderer.reconcile(derive(state, { time: 1, positions: { player: [4, 0, 0] } }));
    expect(player.rotation.y).toBeCloseTo(Math.PI / 2, 2);
    expect(player.position.y).toBeCloseTo(walkBob(4, 1), 5);

    renderer.dispose();
  });

  test("player stays child-free and its vertical extents survive bob + yaw", () => {
    const doc = validDoc([ent("player", "player")]);
    const state = createState(doc, 1);
    const { scene, renderer } = newRenderer();
    renderer.reconcile(state);
    const player = mesh(scene, "player");
    expect(player.children).toHaveLength(0);

    renderer.reconcile(derive(state, { time: 0.5, positions: { player: [3, 0, 2] } }));
    expect(player.children).toHaveLength(0);
    const size = extents(player);
    expect(size[1]).toBeCloseTo(1.8, 5);

    renderer.dispose();
  });

  test("idle player sways without walking", () => {
    const doc = validDoc([ent("player", "player")]);
    const state = createState(doc, 1);
    const { scene, renderer } = newRenderer();
    renderer.reconcile(state);
    renderer.reconcile(derive(state, { time: 0.3 }));

    const player = mesh(scene, "player");
    expect(player.rotation.z).toBeCloseTo(idleSway(0.3), 5);
    expect(player.position.y).toBeCloseTo(0, 5);

    renderer.dispose();
  });

  test("enemy bobs and faces its patrol direction", () => {
    const doc = validDoc([
      ent("player", "player"),
      ent("guard", "enemy", [0, 0, 0]),
    ]);
    const state = createState(doc, 1);
    const { scene, renderer } = newRenderer();
    renderer.reconcile(state);

    renderer.reconcile(derive(state, { time: 0.5, positions: { guard: [3, 0, 0] } }));
    const guard = mesh(scene, "guard");
    expect(guard.rotation.y).toBeCloseTo(Math.PI / 2, 2);
    expect(guard.position.y).toBeCloseTo(walkBob(6, 0.5), 5);

    renderer.dispose();
  });

  test("collectible spins and pulses its emissive", () => {
    const doc = validDoc([
      ent("player", "player"),
      ent("gem", "collectible", [2, 0, 0]),
    ]);
    const state = createState(doc, 1);
    const { scene, renderer } = newRenderer();
    renderer.reconcile(state);
    const gem = mesh(scene, "gem");
    const material = gem.material as THREE.MeshStandardMaterial;
    const initialEmissive = material.emissive.getHex();
    expect(initialEmissive).not.toBe(0);

    renderer.reconcile(derive(state, { time: 0.4 }));
    expect(gem.rotation.y).toBeCloseTo(spinPhase(0.4), 5);
    expect(material.emissive.getHex()).not.toBe(initialEmissive);

    renderer.dispose();
  });
});

describe("interactable highlight ring", () => {
  test("shows a pulsing visualOnly ring within 2.5 units", () => {
    const doc = validDoc([
      ent("player", "player"),
      ent("lever", "interactable", [1.5, 0, 0]),
    ]);
    const state = createState(doc, 1);
    const { scene, renderer } = newRenderer();
    renderer.reconcile(state);

    const lever = mesh(scene, "lever");
    const ring = lever.getObjectByName(HIGHLIGHT_RING_NAME) as THREE.Mesh;
    expect(ring).toBeDefined();
    expect(ring.userData.visualOnly).toBe(true);
    expect(ring.visible).toBe(true);
    const ringMaterial = ring.material as THREE.MeshBasicMaterial;
    expect(ringMaterial.opacity).toBeGreaterThan(0);

    renderer.reconcile(
      derive(state, { time: 0.4, positions: { player: [9, 0, 0] } })
    );
    expect(ring.visible).toBe(false);

    renderer.dispose();
  });

  test("ring child stays inside the entity's unit box (extents-neutral)", () => {
    const doc = validDoc([
      ent("player", "player"),
      ent("lever", "interactable", [1.5, 0, 0]),
    ]);
    const state = createState(doc, 1);
    const { scene, renderer } = newRenderer();
    renderer.reconcile(state);

    const size = extents(mesh(scene, "lever"));
    expect(size[0]).toBeCloseTo(1, 5);
    expect(size[1]).toBeCloseTo(1, 5);
    expect(size[2]).toBeCloseTo(1, 5);

    renderer.dispose();
  });
});

describe("particle effects", () => {
  test("collect burst spawns when a tracked entity disappears", () => {
    const doc = validDoc([
      ent("player", "player"),
      ent("gem", "collectible", [2, 0, 0]),
    ]);
    const state = createState(doc, 1);
    const { scene, renderer } = newRenderer();
    renderer.reconcile(state);
    expect(renderer.particleCount).toBe(0);
    expect(scene.getObjectByName(PARTICLE_SYSTEM_NAME)).toBeUndefined();

    renderer.reconcile(derive(state, { time: 0.016, remove: ["gem"] }));
    expect(renderer.particleCount).toBe(BURST_PROFILES.collect.count);
    expect(scene.getObjectByName("gem")).toBeUndefined();

    const points = scene.getObjectByName(PARTICLE_SYSTEM_NAME) as THREE.Points;
    expect(points).toBeDefined();
    const attribute = points.geometry.getAttribute(
      "position"
    ) as THREE.BufferAttribute;
    expect(Math.abs(attribute.getX(0) - 2)).toBeLessThan(0.5);
    expect(Math.abs(attribute.getZ(0))).toBeLessThan(0.5);

    renderer.dispose();
  });

  test("win confetti fires when status flips to won", () => {
    const doc = validDoc([ent("player", "player")]);
    const state = createState(doc, 1);
    const { scene, renderer } = newRenderer();
    renderer.reconcile(state);
    expect(renderer.particleCount).toBe(0);

    renderer.reconcile(derive(state, { status: "won", time: 0.016 }));
    expect(renderer.particleCount).toBe(BURST_PROFILES.win.count);
    expect(scene.getObjectByName(PARTICLE_SYSTEM_NAME)).toBeDefined();

    renderer.dispose();
  });

  test("lose flashes particles and shakes the camera, then settles", () => {
    const doc = validDoc([ent("player", "player")]);
    const state = createState(doc, 1);
    const { scene, camera, renderer } = newRenderer();
    renderer.reconcile(state);
    const home = camera.position.clone();

    renderer.reconcile(derive(state, { status: "lost", time: 0.016 }));
    expect(renderer.particleCount).toBe(BURST_PROFILES.lose.count);
    expect(camera.position.distanceTo(home)).toBeGreaterThan(0);

    renderer.reconcile(
      derive(state, { status: "lost", time: 1, remove: ["player"] })
    );
    expect(camera.position.distanceTo(home)).toBeLessThan(1e-9);

    renderer.dispose();
  });

  test("particles expire by age", () => {
    const doc = validDoc([ent("player", "player")]);
    const state = createState(doc, 1);
    const { renderer } = newRenderer();
    renderer.reconcile(state);
    renderer.reconcile(derive(state, { status: "won", time: 0.016 }));
    expect(renderer.particleCount).toBeGreaterThan(0);

    renderer.reconcile(derive(state, { status: "won", time: 0.016 }));
    expect(renderer.particleCount).toBeGreaterThan(0);

    for (let frame = 0; frame < 200; frame += 1) {
      renderer.reconcile(derive(state, { status: "won", time: 0.016 }));
    }
    expect(renderer.particleCount).toBe(0);

    renderer.dispose();
  });

  test("a new document resets tracking and emits no bursts", () => {
    const firstDoc = validDoc([
      ent("player", "player"),
      ent("gem", "collectible", [2, 0, 0]),
    ]);
    const { scene, renderer } = newRenderer();
    renderer.reconcile(createState(firstDoc, 1));

    renderer.reconcile(createState(validDoc([ent("player", "player")]), 1));
    expect(renderer.entityCount).toBe(1);
    expect(renderer.particleCount).toBe(0);
    expect(scene.getObjectByName(PARTICLE_SYSTEM_NAME)).toBeUndefined();

    renderer.dispose();
  });

  test("bursts are deterministic across renderer instances", () => {
    const run = (): number[] => {
      const doc = validDoc([
        ent("player", "player"),
        ent("gem", "collectible", [2, 0, 0]),
      ]);
      const state = createState(doc, 1);
      const { scene, renderer } = newRenderer();
      renderer.reconcile(state);
      renderer.reconcile(derive(state, { time: 0.016, remove: ["gem"] }));
      const points = scene.getObjectByName(PARTICLE_SYSTEM_NAME) as THREE.Points;
      const attribute = points.geometry.getAttribute(
        "position"
      ) as THREE.BufferAttribute;
      const values: number[] = [];
      for (let index = 0; index < 12; index += 1) {
        values.push(
          attribute.getX(index),
          attribute.getY(index),
          attribute.getZ(index)
        );
      }
      renderer.dispose();
      return values;
    };

    const first = run();
    expect(first.some((value) => value !== 0)).toBe(true);
    expect(run()).toEqual(first);
  });

  test("each burst kind has a plausible profile", () => {
    const kinds: ParticleBurstKind[] = ["collect", "win", "lose"];
    for (const kind of kinds) {
      const profile = BURST_PROFILES[kind];
      expect(profile.count).toBeGreaterThan(0);
      expect(profile.speed).toBeGreaterThan(0);
      expect(profile.life).toBeGreaterThan(0);
      expect(profile.palette.length).toBeGreaterThan(0);
      for (const color of profile.palette) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
