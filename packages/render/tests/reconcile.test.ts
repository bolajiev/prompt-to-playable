import { describe, expect, test } from "vitest";
import type { Entity, GameDoc, Vec3 } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { createState } from "@prompt-to-playable/engine";
import { diffEntities, entityColor, entityTransform } from "../src/scene.js";
import {
  EntityReconciler,
  Renderer,
  type ViewAdapter,
} from "../src/renderer.js";

function ent(
  id: string,
  position: Vec3 = [0, 0, 0],
  kind: Entity["kind"] = "prop"
): Entity {
  return {
    id: id as Entity["id"],
    kind,
    position,
    tags: [],
    active: true,
  };
}

function player(position: Vec3 = [0, 0, 0]): Entity {
  return ent("player", position, "player");
}

function validDoc(entities: Entity[]): GameDoc {
  const res = validateGame({
    version: "1.0.0",
    meta: { title: "Render Test", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities,
    objectives: [],
    rules: [],
    scratch: {},
  });
  if (!res.ok || !res.data) throw new Error("test doc invalid");
  return res.data;
}

describe("diffEntities", () => {
  test("prev {a,b}, next {b,c} => create c, update b, remove a", () => {
    const diff = diffEntities(new Set(["a", "b"]), [ent("b"), ent("c")]);

    expect(diff.create.map((e) => e.id)).toEqual(["c"]);
    expect(diff.update.map((e) => e.id)).toEqual(["b"]);
    expect(diff.remove).toEqual(["a"]);
  });

  test("empty prev => everything is created", () => {
    const diff = diffEntities(new Set(), [ent("a"), ent("b")]);

    expect(diff.create.map((e) => e.id)).toEqual(["a", "b"]);
    expect(diff.update).toEqual([]);
    expect(diff.remove).toEqual([]);
  });

  test("identical ids => only updates, no create/remove", () => {
    const diff = diffEntities(new Set(["a", "b"]), [ent("a"), ent("b")]);

    expect(diff.create).toEqual([]);
    expect(diff.update.map((e) => e.id)).toEqual(["a", "b"]);
    expect(diff.remove).toEqual([]);
  });

  test("empty next => everything removed", () => {
    const diff = diffEntities(new Set(["a", "b"]), []);

    expect(diff.create).toEqual([]);
    expect(diff.update).toEqual([]);
    expect(diff.remove.sort()).toEqual(["a", "b"]);
  });

  test("accepts a Set only (does not consume generators twice)", () => {
    const prev = new Set(["only"]);
    const diff = diffEntities(prev, []);
    expect(diff.remove).toEqual(["only"]);
  });
});

describe("entityTransform", () => {
  test("uses runtime position/rotation when present", () => {
    const e = ent("p", [1, 2, 3]);
    const t = entityTransform(e, {
      position: [9, 8, 7],
      rotation: [0, 1, 0],
      active: false,
    });

    expect(t.position).toEqual([9, 8, 7]);
    expect(t.rotation).toEqual([0, 1, 0]);
    expect(t.visible).toBe(false);
  });

  test("defaults rotation to zero and copies (never aliases) position", () => {
    const e = ent("p", [1, 2, 3]);
    const t = entityTransform(e);

    expect(t.rotation).toEqual([0, 0, 0]);
    expect(t.visible).toBe(true);
    t.position[0] = 999;
    expect(e.position[0]).toBe(1);
  });

  test("maps size to scale when scale absent", () => {
    const e = { ...ent("p"), size: [2, 3, 4] as Vec3 };
    expect(entityTransform(e).scale).toEqual([2, 3, 4]);
  });
});

describe("entityColor", () => {
  test("honors explicit color then falls back to kind color", () => {
    expect(entityColor({ ...ent("p"), color: "#123456" })).toBe("#123456");
    expect(entityColor({ ...ent("p"), kind: "player" })).toBe(
      entityColor({ ...ent("q"), kind: "player" })
    );
  });
});

interface FakeView {
  id: string;
}

function fakeAdapter(log: string[]): ViewAdapter<FakeView> {
  return {
    create: (entity) => {
      log.push(`create:${entity.id}`);
      return { id: entity.id };
    },
    attach: (view) => log.push(`attach:${view.id}`),
    detach: (view) => log.push(`detach:${view.id}`),
    apply: (view, _entity, transform) =>
      log.push(`apply:${view.id}:${transform.visible}`),
    dispose: (view) => log.push(`dispose:${view.id}`),
  };
}

describe("EntityReconciler", () => {
  test("creates, updates and removes views through the adapter", () => {
    const log: string[] = [];
    const reconciler = new EntityReconciler(fakeAdapter(log));

    reconciler.reconcile(
      createState(validDoc([player(), ent("a"), ent("b")]), 1)
    );
    expect(log).toEqual([
      "create:player",
      "attach:player",
      "apply:player:true",
      "create:a",
      "attach:a",
      "apply:a:true",
      "create:b",
      "attach:b",
      "apply:b:true",
    ]);

    log.length = 0;
    reconciler.reconcile(
      createState(validDoc([player(), ent("b"), ent("c")]), 1)
    );
    expect(log).toEqual([
      "detach:a",
      "dispose:a",
      "create:c",
      "attach:c",
      "apply:c:true",
      "apply:player:true",
      "apply:b:true",
    ]);
    expect(reconciler.size).toBe(3);
  });

  test("never mutates the engine state it reads", () => {
    const log: string[] = [];
    const reconciler = new EntityReconciler(fakeAdapter(log));
    const state = createState(
      validDoc([player(), ent("a", [1, 2, 3])]),
      1
    );
    const snapshot = JSON.stringify(state, (key, value) =>
      key === "rng" ? undefined : value
    );

    reconciler.reconcile(state);
    reconciler.reconcile(state);

    expect(
      JSON.stringify(state, (key, value) => (key === "rng" ? undefined : value))
    ).toBe(snapshot);
  });
});

describe("Renderer", () => {
  test("reconciles a GameState into a real Three scene by id", async () => {
    const THREE = await import("three");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const renderer = new Renderer(scene, camera);

    renderer.reconcile(
      createState(validDoc([player(), ent("gem")]), 1)
    );
    expect(renderer.entityCount).toBe(2);
    expect(scene.children.map((c) => c.name).sort()).toEqual(["gem", "player"]);

    renderer.reconcile(createState(validDoc([player()]), 1));
    expect(renderer.entityCount).toBe(1);
    expect(scene.children.map((c) => c.name)).toEqual(["player"]);

    renderer.dispose();
    expect(scene.children.length).toBe(0);
  });

  test("setEntityHidden hides a view visually and survives view rebuilds", async () => {
    const THREE = await import("three");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const renderer = new Renderer(scene, camera);

    // Unknown ids are remembered and apply when the entity appears.
    renderer.setEntityHidden("player", true);
    renderer.reconcile(createState(validDoc([player(), ent("gem")]), 1));
    const playerView = scene.getObjectByName("player")!;
    expect(playerView.visible).toBe(false);
    expect(scene.getObjectByName("gem")!.visible).toBe(true);

    // Repeated reconciles (same doc and a rebuilt doc) keep it hidden.
    renderer.reconcile(createState(validDoc([player(), ent("gem")]), 1));
    expect(scene.getObjectByName("player")!.visible).toBe(false);

    const rebuiltScene = scene.getObjectByName("player")!;
    renderer.reconcile(createState(validDoc([player(), ent("gem")]), 2));
    const rebuilt = scene.getObjectByName("player")!;
    expect(rebuilt).not.toBe(rebuiltScene);
    expect(rebuilt.visible).toBe(false);

    // Unhiding one id restores the authored visibility.
    renderer.setEntityHidden("player", false);
    expect(rebuilt.visible).toBe(true);

    // Null clears every hidden override.
    renderer.setEntityHidden("player", true);
    renderer.setEntityHidden("gem", true);
    expect(rebuilt.visible).toBe(false);
    expect(scene.getObjectByName("gem")!.visible).toBe(false);
    renderer.setEntityHidden(null, false);
    expect(rebuilt.visible).toBe(true);
    expect(scene.getObjectByName("gem")!.visible).toBe(true);

    renderer.dispose();
  });

  test("setEntityHidden never mutates engine state", async () => {
    const THREE = await import("three");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const renderer = new Renderer(scene, camera);
    const state = createState(validDoc([player(), ent("gem")]), 1);
    const snapshot = JSON.stringify(state, (key, value) =>
      key === "rng" ? undefined : value
    );

    renderer.reconcile(state);
    renderer.setEntityHidden("player", true);
    renderer.reconcile(state);
    renderer.setEntityHidden(null, false);
    renderer.reconcile(state);

    expect(
      JSON.stringify(state, (key, value) => (key === "rng" ? undefined : value))
    ).toBe(snapshot);
    renderer.dispose();
  });

  test("rebuilds a view when a new document reuses an id with a new shape", async () => {
    const THREE = await import("three");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const renderer = new Renderer(scene, camera);

    renderer.reconcile(createState(validDoc([player(), ent("x")]), 1));
    const plain = scene.getObjectByName("x");
    expect(plain).toBeInstanceOf(THREE.Mesh);
    expect(plain).not.toBeInstanceOf(THREE.Group);

    const shaped: Entity = { ...ent("x"), props: { shape: "tree" } };
    renderer.reconcile(createState(validDoc([player(), shaped]), 1));

    const rebuilt = scene.getObjectByName("x");
    expect(rebuilt).toBeInstanceOf(THREE.Group);
    expect(rebuilt!.children.length).toBeGreaterThan(1);
    expect(rebuilt).not.toBe(plain);
    expect(renderer.entityCount).toBe(2);
    expect(scene.children.map((c) => c.name).sort()).toEqual(["player", "x"]);

    renderer.dispose();
    expect(scene.children.length).toBe(0);
  });
});
