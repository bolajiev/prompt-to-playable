import { describe, expect, test } from "vitest";
import { NEUTRAL_INPUT } from "@prompt-to-playable/engine";
import type { Entity, GameDoc } from "@prompt-to-playable/schema";
import {
  applyCameraFocus,
  cameraOffset,
  CameraRig,
  CHASE_DISTANCE,
  CHASE_HEIGHT,
  chaseCameraPosition,
  clampDistance,
  clampPitch,
  clampPitchFor,
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_DISTANCE,
  DEFAULT_PITCH,
  dragScaleFor,
  FIRST_PERSON_DRAG_SCALE,
  FIRST_PERSON_EYE_HEIGHT,
  FIRST_PERSON_MAX_PITCH,
  FIRST_PERSON_MIN_PITCH,
  firstPersonEye,
  firstPersonLookAt,
  FOCUS_DISTANCE,
  forwardFromYaw,
  INSPECT_DISTANCE,
  INSPECT_FIT_MAX_DISTANCE,
  INSPECT_FIT_MIN_DISTANCE,
  INSPECT_FIT_SCALE,
  INSPECT_PITCH,
  INSPECT_YAW,
  inspectAssemblyCenter,
  inspectAssemblyDiagonal,
  inspectCameraDistance,
  MACHINE_PITCH,
  MACHINE_YAW,
  MAX_DISTANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  MIN_PITCH,
  partEntityBoxes,
  PITCH_SENSITIVITY,
  resolveCameraMode,
  usesVehicleInput,
  YAW_RETURN_SECONDS,
  YAW_SENSITIVITY,
  ZOOM_SENSITIVITY,
  type CameraRigOptions,
  type FocusCameraState,
} from "../src/ui/camera-rig.js";
import { toWorldInput } from "../src/ui/input.js";

function rig(options: CameraRigOptions = {}): CameraRig {
  return new CameraRig(options);
}

describe("camera offset math", () => {
  test("default spherical parameters reproduce the historical (6, 8, 12) offset", () => {
    const offset = cameraOffset(0, DEFAULT_PITCH, DEFAULT_DISTANCE);
    expect(offset[0]).toBeCloseTo(DEFAULT_CAMERA_OFFSET[0], 10);
    expect(offset[1]).toBeCloseTo(DEFAULT_CAMERA_OFFSET[1], 10);
    expect(offset[2]).toBeCloseTo(DEFAULT_CAMERA_OFFSET[2], 10);

    const position = rig().desiredPosition([1, 2, 3]);
    expect(position[0]).toBeCloseTo(7, 10);
    expect(position[1]).toBeCloseTo(10, 10);
    expect(position[2]).toBeCloseTo(15, 10);
  });

  test("distance is the length of the offset and pitch sets its height", () => {
    const offset = cameraOffset(0.3, 0.4, 10);
    expect(Math.hypot(offset[0], offset[1], offset[2])).toBeCloseTo(10, 10);
    expect(Math.asin(offset[1] / 10)).toBeCloseTo(0.4, 10);
  });

  test("yaw rotates the offset without changing its length or height", () => {
    const base = cameraOffset(0, 0.5, 12);
    const turned = cameraOffset(Math.PI / 2, 0.5, 12);
    expect(Math.hypot(turned[0], turned[1], turned[2])).toBeCloseTo(12, 10);
    expect(turned[1]).toBeCloseTo(base[1], 10);
    expect(Math.hypot(turned[0] - base[0], turned[2] - base[2])).toBeGreaterThan(1);
  });
});

describe("forwardGround / yaw-to-basis mapping", () => {
  test("yaw 0 is the historical camera basis (-0.4472, -0.8944)", () => {
    const forward = forwardFromYaw(0);
    expect(forward[0]).toBeCloseTo(-6 / Math.hypot(6, 12), 10);
    expect(forward[1]).toBeCloseTo(-12 / Math.hypot(6, 12), 10);
    expect(Math.hypot(forward[0], forward[1])).toBeCloseTo(1, 10);
    expect(rig().forwardGround()).toEqual(forward);
  });

  test("forward is the unit camera-to-player direction on XZ", () => {
    for (const yaw of [0, 0.4, -1.2, Math.PI, 3.5]) {
      const offset = cameraOffset(yaw, DEFAULT_PITCH, DEFAULT_DISTANCE);
      const length = Math.hypot(offset[0], offset[2]);
      const forward = rig({ yaw }).forwardGround();
      expect(forward[0]).toBeCloseTo(-offset[0] / length, 10);
      expect(forward[1]).toBeCloseTo(-offset[2] / length, 10);
    }
  });

  test("pitch and distance do not affect the ground forward", () => {
    const flat = rig({ yaw: 0.7, pitch: MIN_PITCH, distance: MIN_DISTANCE });
    const steep = rig({ yaw: 0.7, pitch: MAX_PITCH, distance: MAX_DISTANCE });
    expect(flat.forwardGround()).toEqual(steep.forwardGround());
  });

  test("a +90 degree yaw turns (fx, fz) into (fz, -fx)", () => {
    const base = forwardFromYaw(0.2);
    const turned = forwardFromYaw(0.2 + Math.PI / 2);
    expect(turned[0]).toBeCloseTo(base[1], 10);
    expect(turned[1]).toBeCloseTo(-base[0], 10);
  });

  test("toWorldInput with the rig forward matches engine axes", () => {
    const forward = rig().forwardGround();
    const w = toWorldInput({ ...NEUTRAL_INPUT, moveZ: 1 }, forward);
    expect(w.moveX).toBeCloseTo(forward[0], 10);
    expect(w.moveZ).toBeCloseTo(forward[1], 10);

    const d = toWorldInput({ ...NEUTRAL_INPUT, moveX: 1 }, forward);
    expect(d.moveX).toBeCloseTo(-forward[1], 10);
    expect(d.moveZ).toBeCloseTo(forward[0], 10);
  });
});

describe("CameraRig orbit control", () => {
  test("yaw follows horizontal drag unbounded in both directions", () => {
    const r = rig();
    r.beginDrag();
    r.drag(100, 0);
    expect(r.yaw).toBeCloseTo(100 * YAW_SENSITIVITY, 10);
    r.drag(-5000, 0);
    expect(r.yaw).toBeCloseTo((100 - 5000) * YAW_SENSITIVITY, 10);
    r.drag(1e6, 0);
    expect(Number.isFinite(r.yaw)).toBe(true);
    expect(Math.abs(r.yaw)).toBeGreaterThan(2 * Math.PI);
  });

  test("pitch follows vertical drag and clamps to [min, max]", () => {
    const r = rig();
    r.beginDrag();
    r.drag(0, -1);
    expect(r.pitch).toBeCloseTo(DEFAULT_PITCH + PITCH_SENSITIVITY, 10);

    r.drag(0, -100000);
    expect(r.pitch).toBe(MAX_PITCH);

    r.drag(0, 100000);
    expect(r.pitch).toBe(MIN_PITCH);
    expect(clampPitch(MIN_PITCH - 1)).toBe(MIN_PITCH);
    expect(clampPitch(MAX_PITCH + 1)).toBe(MAX_PITCH);
  });

  test("wheel zoom clamps the distance to [6, 28]", () => {
    const r = rig();
    r.zoom(100);
    expect(r.distance).toBeCloseTo(DEFAULT_DISTANCE + 100 * ZOOM_SENSITIVITY, 10);

    r.zoom(1e9);
    expect(r.distance).toBe(MAX_DISTANCE);

    r.zoom(-1e9);
    expect(r.distance).toBe(MIN_DISTANCE);
    expect(clampDistance(-100)).toBe(MIN_DISTANCE);
    expect(clampDistance(100)).toBe(MAX_DISTANCE);
  });

  test("non-finite drag and zoom inputs are ignored", () => {
    const r = rig();
    r.drag(Number.NaN, Number.POSITIVE_INFINITY);
    r.zoom(Number.NaN);
    expect(r.yaw).toBe(0);
    expect(r.pitch).toBe(DEFAULT_PITCH);
    expect(r.distance).toBe(DEFAULT_DISTANCE);
    expect(r.isDragging).toBe(true);
  });

  test("yaw holds while dragging and eases back to 0 within ~4s after release", () => {
    const r = rig();
    r.beginDrag();
    r.drag(200, 0);
    const initial = r.yaw;
    expect(initial).toBeGreaterThan(0);

    r.update(4);
    expect(r.yaw).toBe(initial);

    r.endDrag();
    r.update(YAW_RETURN_SECONDS);
    expect(r.isDragging).toBe(false);
    expect(Math.abs(r.yaw)).toBeLessThanOrEqual(Math.abs(initial) * 0.011);

    r.update(YAW_RETURN_SECONDS);
    expect(r.yaw).toBe(0);
  });

  test("the yaw ease returns to homeYaw, not blindly to zero", () => {
    const r = rig({ yaw: INSPECT_YAW });
    r.homeYaw = INSPECT_YAW;
    r.beginDrag();
    r.drag(200, 0);
    r.endDrag();
    const initial = r.yaw - INSPECT_YAW;
    expect(Math.abs(initial)).toBeGreaterThan(0.5);

    r.update(YAW_RETURN_SECONDS);
    expect(Math.abs(r.yaw - INSPECT_YAW)).toBeLessThanOrEqual(
      Math.abs(initial) * 0.011
    );
    r.update(YAW_RETURN_SECONDS);
    expect(r.yaw).toBe(INSPECT_YAW);

    // reset() restores the home view, not the historical zero yaw.
    r.beginDrag();
    r.drag(-300, 0);
    r.reset();
    expect(r.yaw).toBe(INSPECT_YAW);
  });

  test("negative and zero dt leave yaw untouched", () => {
    const r = rig();
    r.beginDrag();
    r.drag(50, 0);
    r.endDrag();
    const yaw = r.yaw;
    r.update(0);
    r.update(-1);
    r.update(Number.NaN);
    expect(r.yaw).toBe(yaw);
  });

  test("reset restores the default behind-player view", () => {
    const r = rig();
    r.beginDrag();
    r.drag(120, -60);
    r.zoom(500);
    r.reset();
    expect(r.yaw).toBe(0);
    expect(r.pitch).toBe(DEFAULT_PITCH);
    expect(r.distance).toBe(DEFAULT_DISTANCE);
    expect(r.isDragging).toBe(false);
  });

  test("identical input sequences produce identical output (deterministic)", () => {
    const run = (): [number, number, number] => {
      const r = rig();
      r.beginDrag();
      r.drag(37, -21);
      r.drag(-14, 9);
      r.endDrag();
      r.update(0.25);
      r.zoom(-60);
      r.update(1.5);
      const offset = r.offset();
      return [offset[0], offset[1], offset[2]];
    };
    expect(run()).toEqual(run());
  });
});

describe("mode-aware pitch and drag", () => {
  test("orbit and chase keep the historical clamp", () => {
    for (const mode of ["orbit", "chase"] as const) {
      expect(clampPitchFor(mode, MAX_PITCH + 1)).toBe(MAX_PITCH);
      expect(clampPitchFor(mode, MIN_PITCH - 1)).toBe(MIN_PITCH);
      expect(clampPitchFor(mode, 0.25)).toBe(0.25);
    }
  });

  test("first person allows a full up/down look within [-1.2, 1.2]", () => {
    expect(FIRST_PERSON_MIN_PITCH).toBe(-1.2);
    expect(FIRST_PERSON_MAX_PITCH).toBe(1.2);
    expect(clampPitchFor("firstPerson", 100)).toBe(FIRST_PERSON_MAX_PITCH);
    expect(clampPitchFor("firstPerson", -100)).toBe(FIRST_PERSON_MIN_PITCH);
    expect(clampPitchFor("firstPerson", 0.9)).toBe(0.9);
    expect(clampPitchFor("firstPerson", MAX_PITCH)).toBe(
      FIRST_PERSON_MAX_PITCH
    );
  });

  test("first-person dragging clamps at the new limits", () => {
    const r = rig();
    r.beginDrag();
    r.drag(0, -100000, "firstPerson");
    expect(r.pitch).toBe(FIRST_PERSON_MAX_PITCH);

    r.drag(0, 100000, "firstPerson");
    expect(r.pitch).toBe(FIRST_PERSON_MIN_PITCH);

    r.drag(0, 100000, "orbit");
    expect(r.pitch).toBe(MIN_PITCH);

    r.drag(0, -100000, "chase");
    expect(r.pitch).toBe(MAX_PITCH);
  });

  test("first-person drag is slightly more sensitive on both axes", () => {
    expect(dragScaleFor("firstPerson")).toBe(FIRST_PERSON_DRAG_SCALE);
    expect(dragScaleFor("orbit")).toBe(1);
    expect(dragScaleFor("chase")).toBe(1);
    expect(FIRST_PERSON_DRAG_SCALE).toBeGreaterThan(1);

    const fp = rig();
    fp.beginDrag();
    fp.drag(100, 0, "firstPerson");
    expect(fp.yaw).toBeCloseTo(100 * YAW_SENSITIVITY * FIRST_PERSON_DRAG_SCALE, 10);

    const orbit = rig();
    orbit.beginDrag();
    orbit.drag(100, 0);
    expect(orbit.yaw).toBeCloseTo(100 * YAW_SENSITIVITY, 10);
  });

  test("identical deltas give identical pitch under the mode clamp", () => {
    const fp = rig({ pitch: 0 });
    const orbit = rig({ pitch: 0 });
    fp.drag(0, -10, "firstPerson");
    orbit.drag(0, -10, "orbit");
    expect(fp.pitch / FIRST_PERSON_DRAG_SCALE).toBeCloseTo(orbit.pitch, 10);
  });
});

function doc(meta: { mode?: string; archetype?: string }): GameDoc {
  return { meta } as unknown as GameDoc;
}

describe("resolveCameraMode", () => {
  test("explicit modes map to their camera behavior", () => {
    expect(resolveCameraMode(doc({ mode: "walkthrough" }))).toBe("firstPerson");
    expect(resolveCameraMode(doc({ mode: "drive" }))).toBe("chase");
    expect(resolveCameraMode(doc({ mode: "inspect" }))).toBe("orbit");
    expect(resolveCameraMode(doc({ mode: "machine" }))).toBe("orbit");
    expect(resolveCameraMode(doc({ mode: "explore" }))).toBe("orbit");
    expect(resolveCameraMode(doc({ mode: "game" }))).toBe("orbit");
  });

  test("documents without a mode fall back to the inferred mode", () => {
    expect(resolveCameraMode(doc({ archetype: "explore" }))).toBe("orbit");
    expect(resolveCameraMode(doc({ archetype: "collect-a-thon" }))).toBe(
      "orbit"
    );
    expect(resolveCameraMode(doc({ archetype: "stealth-chase" }))).toBe(
      "orbit"
    );
  });

  test("explicit mode wins over the archetype", () => {
    expect(
      resolveCameraMode(doc({ mode: "walkthrough", archetype: "explore" }))
    ).toBe("firstPerson");
    expect(
      resolveCameraMode(doc({ mode: "drive", archetype: "collect-a-thon" }))
    ).toBe("chase");
  });

  test("inspect defaults stay inside the orbit clamp range", () => {
    expect(INSPECT_DISTANCE).toBeGreaterThanOrEqual(MIN_DISTANCE);
    expect(INSPECT_DISTANCE).toBeLessThanOrEqual(MAX_DISTANCE);
    expect(INSPECT_PITCH).toBeGreaterThanOrEqual(MIN_PITCH);
    expect(INSPECT_PITCH).toBeLessThanOrEqual(MAX_PITCH);
    expect(INSPECT_PITCH).toBeCloseTo(1.05);
  });

  test("inspect assembly diagonal spans the union of the part boxes", () => {
    expect(inspectAssemblyDiagonal([])).toBeUndefined();
    const diagonal = inspectAssemblyDiagonal([
      { position: [10, 0, 0], size: [2, 2, 2] },
      { position: [-4, 1, 3], size: [4, 2, 2] },
    ]);
    // Union: x [-6, 11], y [-1, 2], z [-1, 4] -> [17, 3, 5].
    expect(diagonal).toBeCloseTo(Math.hypot(17, 3, 5), 10);
  });

  test("inspect yaw cancels the default offset slant and looks down +z", () => {
    // Derived from the default offset, not an independent magic angle.
    expect(INSPECT_YAW).toBeCloseTo(
      -Math.atan2(DEFAULT_CAMERA_OFFSET[0], DEFAULT_CAMERA_OFFSET[2]),
      10
    );
    const offset = cameraOffset(INSPECT_YAW, INSPECT_PITCH, 10);
    expect(offset[0]).toBeCloseTo(0, 10);
    expect(offset[2]).toBeGreaterThan(0);
    // Sanity: the default rig yaw really is diagonal (non-zero x).
    expect(cameraOffset(0, INSPECT_PITCH, 10)[0]).toBeGreaterThan(1);
  });

  test("machine framing is a three-quarter view of the same auto-fit assembly", () => {
    // A moderate product-shot elevation, inside the orbit clamp and clearly
    // lower than the top-down inspect pitch.
    expect(MACHINE_PITCH).toBeGreaterThanOrEqual(0.5);
    expect(MACHINE_PITCH).toBeLessThanOrEqual(0.6);
    expect(MACHINE_PITCH).toBeGreaterThanOrEqual(MIN_PITCH);
    expect(MACHINE_PITCH).toBeLessThanOrEqual(MAX_PITCH);
    expect(MACHINE_PITCH).toBeLessThan(INSPECT_PITCH);

    // Derived from the existing pure constants: the straight-on inspect yaw
    // turned 45 degrees onto the +X/+Z diagonal, not an independent magic angle.
    expect(MACHINE_YAW).toBeCloseTo(INSPECT_YAW + Math.PI / 4, 10);
    const offset = cameraOffset(MACHINE_YAW, MACHINE_PITCH, 10);
    expect(offset[0]).toBeCloseTo(offset[2], 10);
    expect(offset[0]).toBeGreaterThan(0);
    expect(offset[1]).toBeGreaterThan(0);
    // Sanity: it is a genuine turn away from the straight-on inspect yaw.
    expect(Math.abs(MACHINE_YAW - INSPECT_YAW)).toBeCloseTo(Math.PI / 4, 10);
  });

  test("machine reuses the inspect auto-fit distance and clamp", () => {
    const arm = [{ position: [1.5, 2.5, 0], size: [5.4, 5, 2.4] }];
    const distance = clampDistance(inspectCameraDistance(arm));
    expect(distance).toBeGreaterThanOrEqual(MIN_DISTANCE);
    expect(distance).toBeLessThanOrEqual(MAX_DISTANCE);
    // Same center/boxes feed the orbit target for both assembly modes.
    expect(inspectAssemblyCenter(arm)).toEqual([1.5, 2.5, 0]);
  });

  test("inspect assembly center is the union bbox center", () => {
    expect(inspectAssemblyCenter([])).toBeUndefined();
    const center = inspectAssemblyCenter([
      { position: [10, 0, 0], size: [2, 2, 2] },
      { position: [-4, 1, 3], size: [4, 2, 2] },
    ]);
    // Union: x [-6, 11], y [-1, 2], z [-1, 4] -> center (2.5, 0.5, 1.5).
    expect(center).toEqual([2.5, 0.5, 1.5]);
  });

  test("inspect fit fills ~three quarters of a 16:9 frame with the board", () => {
    const board = [{ position: [0, 0.4, 0], size: [12, 0.35, 6] }];
    const distance = inspectCameraDistance(board);
    expect(INSPECT_FIT_SCALE).toBeCloseTo(0.6, 10);
    expect(distance).toBeGreaterThan(INSPECT_FIT_MIN_DISTANCE);
    expect(distance).toBeLessThan(9);

    // Perspective camera in app.ts: 60 deg vertical FOV, 16:9 viewport.
    const halfHeight = Math.tan((60 * Math.PI) / 360);
    const halfWidth = halfHeight * (16 / 9);
    const fill = 12 / 2 / (distance * halfWidth);
    expect(fill).toBeGreaterThan(0.65);
    expect(fill).toBeLessThan(0.85);
  });

  test("inspect camera distance auto-fits the bbox diagonal, clamped 8..26", () => {
    expect(inspectCameraDistance([])).toBe(INSPECT_DISTANCE);

    const small = inspectCameraDistance([
      { position: [0, 0, 0], size: [1, 1, 1] },
    ]);
    expect(small).toBe(INSPECT_FIT_MIN_DISTANCE);

    const board = inspectCameraDistance([
      { position: [0, 0.4, 0], size: [12, 0.4, 6] },
    ]);
    const diagonal = Math.hypot(12, 0.4, 6);
    expect(board).toBeCloseTo(
      Math.max(
        INSPECT_FIT_MIN_DISTANCE,
        Math.min(INSPECT_FIT_MAX_DISTANCE, diagonal * INSPECT_FIT_SCALE)
      ),
      10
    );
    expect(board).toBeGreaterThan(INSPECT_FIT_MIN_DISTANCE);
    expect(board).toBeLessThan(INSPECT_FIT_MAX_DISTANCE);

    const huge = inspectCameraDistance([
      { position: [0, 0, 0], size: [100, 10, 100] },
    ]);
    expect(huge).toBe(INSPECT_FIT_MAX_DISTANCE);
  });

  test("part entity boxes convert local parts to world extents", () => {
    const board = {
      id: "board",
      kind: "prop",
      position: [0, 0.4, 0],
      parts: [{ shape: "box", offset: [0, 0, 0], size: [12, 0.35, 6] }],
    } as unknown as Entity;
    const sized = {
      id: "machine",
      kind: "prop",
      position: [3, 0, 0],
      size: [2, 4, 2],
      parts: [{ shape: "box", offset: [0, 0.5, 0], size: [1, 1, 1] }],
    } as unknown as Entity;
    const noParts = {
      id: "rock",
      kind: "prop",
      position: [0, 0, 0],
    } as unknown as Entity;

    const boxes = partEntityBoxes([board, sized, noParts]);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.size[0]).toBeCloseTo(12, 10);
    expect(boxes[0]?.size[1]).toBeCloseTo(0.35, 10);
    expect(boxes[0]?.size[2]).toBeCloseTo(6, 10);
    expect(boxes[0]?.position[1]).toBeCloseTo(0.4, 10);
    // offset [0, 0.5, 0] * scale [2, 4, 2] = world [0, 2, 0], size [2, 4, 2].
    expect(boxes[1]?.position).toEqual([3, 2, 0]);
    expect(boxes[1]?.size).toEqual([2, 4, 2]);
  });
});

describe("vehicle chase predicate", () => {
  test("a props.vehicle player uses the chase camera in any mode", () => {
    expect(resolveCameraMode(doc({ mode: "explore" }), true)).toBe("chase");
    expect(resolveCameraMode(doc({ mode: "inspect" }), true)).toBe("chase");
    expect(resolveCameraMode(doc({ mode: "drive" }), false)).toBe("chase");
    expect(
      resolveCameraMode(doc({ archetype: "collect-a-thon" }), true)
    ).toBe("chase");
    expect(resolveCameraMode(doc({ mode: "explore" }), false)).toBe("orbit");
  });

  test("vehicle input matches chase camera or a props.vehicle player", () => {
    expect(usesVehicleInput("chase", undefined)).toBe(true);
    expect(usesVehicleInput("orbit", true)).toBe(true);
    expect(usesVehicleInput("orbit", false)).toBe(false);
    expect(usesVehicleInput("firstPerson", undefined)).toBe(false);
  });
});

describe("camera focus consumption", () => {
  const idle: FocusCameraState = { active: false, savedDistance: null };

  test("focusing an entity returns its position and eases toward FOCUS_DISTANCE", () => {
    const first = applyCameraFocus(idle, "board", [3, 1, 2], 12, 0.1);
    expect(first.target).toEqual([3, 1, 2]);
    expect(first.state).toEqual({ active: true, savedDistance: 12 });
    expect(first.distance).toBeLessThan(12);
    expect(first.distance).toBeGreaterThan(FOCUS_DISTANCE);

    let step = first;
    for (let i = 0; i < 200; i++) {
      step = applyCameraFocus(
        step.state,
        "board",
        [3, 1, 2],
        step.distance,
        1 / 60
      );
    }
    expect(step.distance).toBeCloseTo(FOCUS_DISTANCE, 4);
    expect(step.distance).toBeGreaterThanOrEqual(FOCUS_DISTANCE);
  });

  test("a focused distance never overshoots when approached from below", () => {
    const step = applyCameraFocus(
      { active: true, savedDistance: 12 },
      "board",
      [0, 0, 0],
      FOCUS_DISTANCE - 2,
      1 / 60
    );
    expect(step.distance).toBeGreaterThan(FOCUS_DISTANCE - 2);
    expect(step.distance).toBeLessThanOrEqual(FOCUS_DISTANCE);
  });

  test("clearing the focus restores the pre-focus distance and target", () => {
    const focused = applyCameraFocus(idle, "board", [3, 1, 2], 14, 0.5);
    expect(focused.state).toEqual({ active: true, savedDistance: 14 });

    const cleared = applyCameraFocus(
      focused.state,
      undefined,
      undefined,
      focused.distance,
      1 / 60
    );
    expect(cleared.target).toBeNull();
    expect(cleared.state).toEqual({ active: false, savedDistance: null });
    expect(cleared.distance).toBe(14);

    const still = applyCameraFocus(cleared.state, undefined, undefined, 10, 0.5);
    expect(still.distance).toBe(10);
    expect(still.target).toBeNull();
  });

  test("an unknown focus id clears like an omitted focus", () => {
    const focused = applyCameraFocus(idle, "board", [1, 0, 0], 10, 0.2);
    const missing = applyCameraFocus(
      focused.state,
      "ghost",
      undefined,
      focused.distance,
      0.2
    );
    expect(missing.target).toBeNull();
    expect(missing.distance).toBe(10);
    expect(missing.state).toEqual({ active: false, savedDistance: null });
  });

  test("non-positive or non-finite dt leaves the distance untouched", () => {
    for (const dt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const step = applyCameraFocus(idle, "board", [0, 1, 0], 12, dt);
      expect(step.distance).toBe(12);
      expect(step.target).toEqual([0, 1, 0]);
    }
  });
});

describe("first-person camera math", () => {
  test("the eye sits one eye-height above the player center", () => {
    expect(firstPersonEye([1, 2, 3])).toEqual([1, 2 + FIRST_PERSON_EYE_HEIGHT, 3]);
  });

  test("yaw 0 and level pitch aim along the default ground forward", () => {
    const eye = firstPersonEye([0, 0, 0]);
    const target = firstPersonLookAt(eye, 0, 0);
    const [fx, fz] = forwardFromYaw(0);
    expect(target[0]).toBeCloseTo(fx, 10);
    expect(target[1]).toBeCloseTo(eye[1], 10);
    expect(target[2]).toBeCloseTo(fz, 10);
    expect(
      Math.hypot(target[0] - eye[0], target[2] - eye[2])
    ).toBeCloseTo(1, 10);
  });

  test("positive pitch looks up and shortens the ground projection", () => {
    const eye = firstPersonEye([0, 0, 0]);
    const level = firstPersonLookAt(eye, 0, 0);
    const up = firstPersonLookAt(eye, 0, 0.5);
    expect(up[1]).toBeGreaterThan(level[1]);
    expect(up[1] - eye[1]).toBeCloseTo(Math.sin(0.5), 10);
    expect(
      Math.hypot(up[0] - eye[0], up[2] - eye[2])
    ).toBeCloseTo(Math.cos(0.5), 10);
  });

  test("yaw turns the look direction around the eye", () => {
    const eye: [number, number, number] = [0, 0, 0];
    const straight = firstPersonLookAt(eye, 0, 0);
    const turned = firstPersonLookAt(eye, Math.PI / 2, 0);
    const [fx, fz] = forwardFromYaw(Math.PI / 2);
    expect(turned[0]).toBeCloseTo(fx, 10);
    expect(turned[2]).toBeCloseTo(fz, 10);
    expect(
      Math.hypot(turned[0] - straight[0], turned[2] - straight[2])
    ).toBeGreaterThan(1);
  });
});

describe("chase camera math", () => {
  test("heading 0 places the camera behind +Z at the chase height", () => {
    expect(chaseCameraPosition([2, 0, 3], 0)).toEqual([
      2,
      CHASE_HEIGHT,
      3 - CHASE_DISTANCE,
    ]);
  });

  test("the camera stays behind the heading direction", () => {
    const position = chaseCameraPosition([0, 0, 0], Math.PI / 2);
    expect(position[0]).toBeCloseTo(-CHASE_DISTANCE, 10);
    expect(position[1]).toBe(CHASE_HEIGHT);
    expect(position[2]).toBeCloseTo(0, 10);

    const offset = Math.hypot(position[0], position[2]);
    expect(offset).toBeCloseTo(CHASE_DISTANCE, 10);
  });
});
