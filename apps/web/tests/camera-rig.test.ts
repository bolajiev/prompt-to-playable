import { describe, expect, test } from "vitest";
import { NEUTRAL_INPUT } from "@prompt-to-playable/engine";
import {
  cameraOffset,
  CameraRig,
  clampDistance,
  clampPitch,
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_DISTANCE,
  DEFAULT_PITCH,
  forwardFromYaw,
  MAX_DISTANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  MIN_PITCH,
  PITCH_SENSITIVITY,
  YAW_RETURN_SECONDS,
  YAW_SENSITIVITY,
  ZOOM_SENSITIVITY,
  type CameraRigOptions,
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
