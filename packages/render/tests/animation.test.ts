import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Vec3 } from "@prompt-to-playable/schema";
import {
  approachYaw,
  FACING_LERP_RATE,
  idleSway,
  IDLE_SWAY_AMPLITUDE,
  INTERACTABLE_RANGE,
  LOSE_SHAKE_AMPLITUDE,
  LOSE_SHAKE_DURATION,
  movementYaw,
  NOMINAL_FRAME_DT,
  planarVelocity,
  pulse,
  shakeOffset,
  spinPhase,
  SPIN_SPEED,
  walkBob,
  WALK_BOB_AMPLITUDE,
  WALK_BOB_BASE_FREQUENCY,
  WALK_BOB_FREQUENCY_PER_SPEED,
  wrapAngle,
} from "../src/animation.js";

describe("planarVelocity", () => {
  test("derives vx/vz/speed from successive positions", () => {
    const velocity = planarVelocity([0, 0, 0], [3, 5, 4], 0.5);
    expect(velocity.vx).toBeCloseTo(6);
    expect(velocity.vz).toBeCloseTo(8);
    expect(velocity.speed).toBeCloseTo(10);
  });

  test("ignores vertical motion and non-positive dt", () => {
    expect(planarVelocity([0, 0, 0], [0, 9, 0], 1).speed).toBe(0);
    for (const dt of [0, -1, Number.NaN]) {
      expect(planarVelocity([1, 0, 1], [5, 0, 5], dt)).toEqual({
        vx: 0,
        vz: 0,
        speed: 0,
      });
    }
  });
});

describe("walkBob", () => {
  test("is zero when idle or at time zero", () => {
    expect(walkBob(0, 1.234)).toBe(0);
    expect(walkBob(-3, 1.234)).toBe(0);
    expect(walkBob(6, 0)).toBe(0);
  });

  test("amplitude and frequency scale with speed and stay bounded", () => {
    const frequency = (speed: number): number =>
      WALK_BOB_BASE_FREQUENCY + speed * WALK_BOB_FREQUENCY_PER_SPEED;
    const quarterPeriod = (speed: number): number => Math.PI / 2 / frequency(speed);
    const slow = walkBob(2, quarterPeriod(2));
    const fast = walkBob(6, quarterPeriod(6));
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow);

    for (let time = 0; time < 4; time += 0.13) {
      expect(Math.abs(walkBob(6, time))).toBeLessThanOrEqual(WALK_BOB_AMPLITUDE + 1e-9);
    }
  });

  test("is deterministic for identical inputs", () => {
    expect(walkBob(3.7, 2.25)).toBe(walkBob(3.7, 2.25));
  });
});

describe("idleSway", () => {
  test("is zero at time zero and bounded, deterministic", () => {
    expect(idleSway(0)).toBe(0);
    expect(idleSway(1.1)).toBe(idleSway(1.1));
    for (let time = 0; time < 5; time += 0.21) {
      expect(Math.abs(idleSway(time))).toBeLessThanOrEqual(IDLE_SWAY_AMPLITUDE + 1e-9);
    }
  });
});

describe("wrapAngle / approachYaw", () => {
  test("factor 0 keeps the current yaw, factor 1 snaps to the target", () => {
    expect(approachYaw(0.4, 2.2, 0)).toBeCloseTo(0.4);
    expect(approachYaw(0.4, 2.2, 1)).toBeCloseTo(2.2);
    expect(approachYaw(0.4, 2.2, 5)).toBeCloseTo(2.2);
    expect(approachYaw(0.4, 2.2, -1)).toBeCloseTo(0.4);
  });

  test("eases along the shortest arc across the +/-pi seam", () => {
    const current = 3;
    const target = -3;
    const next = approachYaw(current, target, 1);
    expect(Math.abs(wrapAngle(next - target))).toBeLessThan(1e-9);
    expect(Math.abs(next - current)).toBeLessThan(Math.PI);
  });

  test("wrapAngle preserves direction and bounds the angle", () => {
    for (const angle of [-7, -Math.PI, 0, 1.5, Math.PI, 9.3]) {
      const wrapped = wrapAngle(angle);
      expect(wrapped).toBeGreaterThan(-Math.PI - 1e-9);
      expect(wrapped).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(Math.cos(wrapped)).toBeCloseTo(Math.cos(angle), 9);
      expect(Math.sin(wrapped)).toBeCloseTo(Math.sin(angle), 9);
    }
  });
});

describe("movementYaw", () => {
  test("maps world directions to yaw about +Y", () => {
    expect(movementYaw(0, 1)).toBeCloseTo(0);
    expect(movementYaw(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(movementYaw(0, -1)).toBeCloseTo(Math.PI);
    expect(movementYaw(-1, 0)).toBeCloseTo(-Math.PI / 2);
  });
});

describe("spinPhase / pulse", () => {
  test("spin is linear in time and deterministic", () => {
    expect(spinPhase(0)).toBe(0);
    expect(spinPhase(2) - spinPhase(1)).toBeCloseTo(SPIN_SPEED);
    expect(spinPhase(1.234)).toBe(spinPhase(1.234));
  });

  test("pulse stays in [0, 1] with a full period and 0.5 at time zero", () => {
    expect(pulse(0)).toBeCloseTo(0.5);
    expect(pulse(1.6 / 4)).toBeCloseTo(1);
    expect(pulse((1.6 * 3) / 4)).toBeCloseTo(0);
    for (let time = 0; time < 4; time += 0.07) {
      const value = pulse(time);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("shakeOffset", () => {
  test("is zero outside the shake window and deterministic inside", () => {
    for (const age of [-0.1, LOSE_SHAKE_DURATION, LOSE_SHAKE_DURATION + 1]) {
      expect(shakeOffset(age)).toEqual([0, 0, 0]);
    }
    const a = shakeOffset(0.05);
    const b = shakeOffset(0.05);
    expect(a).toEqual(b);
    expect(a.some((component) => component !== 0)).toBe(true);
  });

  test("decays as the shake ages", () => {
    const early = Math.hypot(...shakeOffset(0.01)) as number;
    const late = Math.hypot(...shakeOffset(LOSE_SHAKE_DURATION - 0.01)) as number;
    expect(early).toBeGreaterThan(late);
    for (let age = 0; age < LOSE_SHAKE_DURATION; age += 0.02) {
      expect(Math.abs(shakeOffset(age)[0])).toBeLessThanOrEqual(
        LOSE_SHAKE_AMPLITUDE + 1e-9
      );
    }
  });
});

describe("constants and purity", () => {
  test("tuning constants sane", () => {
    expect(INTERACTABLE_RANGE).toBe(2.5);
    expect(FACING_LERP_RATE).toBeGreaterThan(0);
    expect(NOMINAL_FRAME_DT).toBeCloseTo(1 / 60);
  });

  test("animation module never uses Math.random", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/animation.ts", import.meta.url)),
      "utf8"
    );
    expect(source).not.toMatch(/Math\s*\.\s*random\s*\(/);
  });

  test("phase functions do not mutate their inputs", () => {
    const prev: Vec3 = [1, 2, 3];
    const next: Vec3 = [4, 5, 6];
    planarVelocity(prev, next, 0.5);
    expect(prev).toEqual([1, 2, 3]);
    expect(next).toEqual([4, 5, 6]);
  });
});
