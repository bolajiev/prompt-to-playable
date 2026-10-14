import { describe, expect, test } from "vitest";
import * as THREE from "three";
import {
  CLICK_DURATION_LIMIT_MS,
  CLICK_MOVE_TOLERANCE_PX,
  gestureOutcome,
  hoverEdgeEvents,
  intersectEntity,
  isClickGesture,
  pickEntityId,
  type PointerSample,
} from "../src/ui/picking.js";

function sample(x: number, y: number, time: number): PointerSample {
  return { x, y, time };
}

describe("isClickGesture", () => {
  test("accepts a short, still press", () => {
    expect(isClickGesture(sample(10, 20, 0), sample(10, 20, 0))).toBe(true);
    expect(isClickGesture(sample(10, 20, 100), sample(13, 23, 300))).toBe(
      true
    );
  });

  test("rejects pointer travel of the tolerance or more", () => {
    expect(
      isClickGesture(sample(0, 0, 0), sample(CLICK_MOVE_TOLERANCE_PX, 0, 10))
    ).toBe(false);
    expect(
      isClickGesture(sample(0, 0, 0), sample(0, -CLICK_MOVE_TOLERANCE_PX, 10))
    ).toBe(false);
    expect(
      isClickGesture(sample(0, 0, 0), sample(5, 4, 10))
    ).toBe(false);
    expect(isClickGesture(sample(0, 0, 0), sample(4, 3, 10))).toBe(true);
  });

  test("rejects slow presses", () => {
    expect(
      isClickGesture(sample(0, 0, 0), sample(0, 0, CLICK_DURATION_LIMIT_MS))
    ).toBe(false);
    expect(
      isClickGesture(
        sample(0, 0, 0),
        sample(0, 0, CLICK_DURATION_LIMIT_MS - 1)
      )
    ).toBe(true);
  });

  test("rejects missing, non-finite and time-travelling samples", () => {
    expect(isClickGesture(null, sample(0, 0, 0))).toBe(false);
    expect(isClickGesture(sample(0, 0, 0), undefined)).toBe(false);
    expect(
      isClickGesture(sample(Number.NaN, 0, 0), sample(0, 0, 10))
    ).toBe(false);
    expect(
      isClickGesture(sample(0, 0, 0), sample(0, 0, Number.POSITIVE_INFINITY))
    ).toBe(false);
    expect(isClickGesture(sample(0, 0, 20), sample(0, 0, 10))).toBe(false);
  });
});

function entityMesh(id: string | null, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial()
  );
  mesh.position.z = z;
  if (id !== null) mesh.userData.entityId = id;
  // Raycaster r169 trusts world matrices; the app relies on the render loop
  // updating them, tests must refresh them explicitly.
  mesh.updateMatrixWorld(true);
  return mesh;
}

function cameraAt(z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 0, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function raycasterFor(camera: THREE.Camera): THREE.Raycaster {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  return raycaster;
}

describe("intersectEntity", () => {
  test("returns the nearest entity id along the ray", () => {
    const raycaster = raycasterFor(cameraAt(10));
    const near = entityMesh("near", 0);
    const far = entityMesh("far", -5);

    expect(intersectEntity(raycaster, [far, near])).toBe("near");
    expect(intersectEntity(raycaster, [far])).toBe("far");
  });

  test("resolves meshes nested inside an entity root through their ancestors", () => {
    const raycaster = raycasterFor(cameraAt(10));
    const root = new THREE.Group();
    root.userData.entityId = "robot";
    root.add(entityMesh(null, 0));
    root.updateMatrixWorld(true);

    expect(intersectEntity(raycaster, [root])).toBe("robot");
  });

  test("ignores hits with no entity ancestor", () => {
    const raycaster = raycasterFor(cameraAt(10));
    const ground = entityMesh(null, 0);
    const entity = entityMesh("goal", -5);

    expect(intersectEntity(raycaster, [ground])).toBeNull();
    expect(intersectEntity(raycaster, [ground, entity])).toBe("goal");
    expect(intersectEntity(raycaster, [])).toBeNull();
  });
});

describe("intersectEntity visibility", () => {
  test("skips hidden entities even when they are nearest", () => {
    const raycaster = raycasterFor(cameraAt(10));
    const hidden = entityMesh("hidden", 0);
    hidden.visible = false;
    const visible = entityMesh("visible", -5);

    expect(intersectEntity(raycaster, [hidden, visible])).toBe("visible");
    expect(intersectEntity(raycaster, [hidden])).toBeNull();
  });

  test("skips hits nested under a hidden ancestor", () => {
    const raycaster = raycasterFor(cameraAt(10));
    const root = new THREE.Group();
    root.userData.entityId = "robot";
    root.visible = false;
    root.add(entityMesh(null, 0));
    root.updateMatrixWorld(true);
    const visible = entityMesh("goal", -5);

    expect(intersectEntity(raycaster, [root, visible])).toBe("goal");
    expect(intersectEntity(raycaster, [root])).toBeNull();
  });

  test("skips a hidden child mesh of a visible entity", () => {
    const raycaster = raycasterFor(cameraAt(10));
    const root = new THREE.Group();
    root.userData.entityId = "robot";
    const child = entityMesh(null, 0);
    child.visible = false;
    root.add(child);
    root.updateMatrixWorld(true);

    expect(intersectEntity(raycaster, [root])).toBeNull();
  });
});

describe("hoverEdgeEvents", () => {
  test("no change yields no events", () => {
    expect(hoverEdgeEvents(null, null)).toEqual([]);
    expect(hoverEdgeEvents("a", "a")).toEqual([]);
  });

  test("entering, leaving and switching entities", () => {
    expect(hoverEdgeEvents(null, "a")).toEqual([
      { type: "hoverEnter", targetId: "a" },
    ]);
    expect(hoverEdgeEvents("a", null)).toEqual([
      { type: "hoverLeave", targetId: "a" },
    ]);
    expect(hoverEdgeEvents("a", "b")).toEqual([
      { type: "hoverLeave", targetId: "a" },
      { type: "hoverEnter", targetId: "b" },
    ]);
  });
});

describe("gestureOutcome", () => {
  test("still, short releases are clicks; moves and missing starts are drags", () => {
    expect(gestureOutcome(sample(1, 1, 0), sample(1, 1, 50))).toBe("click");
    expect(gestureOutcome(sample(1, 1, 0), sample(30, 1, 50))).toBe("drag");
    expect(gestureOutcome(sample(1, 1, 0), sample(1, 1, 999))).toBe("drag");
    expect(gestureOutcome(null, sample(1, 1, 50))).toBe("drag");
  });

  test("a cancelled gesture never becomes a click", () => {
    expect(gestureOutcome(sample(1, 1, 0), sample(1, 1, 50), true)).toBe(
      "cancel"
    );
    expect(gestureOutcome(null, null, true)).toBe("cancel");
  });
});

describe("pickEntityId", () => {
  test("casts through the camera at the requested NDC point", () => {
    const camera = cameraAt(10);
    const raycaster = new THREE.Raycaster();
    const objects = [entityMesh("center", 0)];

    expect(pickEntityId(raycaster, camera, objects)).toBe("center");
    expect(
      pickEntityId(raycaster, camera, objects, { x: 0.9, y: 0.9 })
    ).toBeNull();
  });
});
