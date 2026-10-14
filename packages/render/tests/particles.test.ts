import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as THREE from "three";
import type { Vec3 } from "@prompt-to-playable/schema";
import {
  BURST_PROFILES,
  DEFAULT_PARTICLE_SEED,
  GOLDEN_ANGLE,
  parseHexColor,
  PARTICLE_SYSTEM_NAME,
  ParticlePool,
  ParticleSystem,
} from "../src/particles.js";

const ORIGIN: Vec3 = [2, 3, -1];

function snapshot(pool: ParticlePool, count = 4): string {
  const rows: unknown[] = [];
  for (let index = 0; index < count && index < pool.activeCount; index += 1) {
    rows.push({
      position: pool.positionAt(index),
      velocity: pool.velocityAt(index),
      life: pool.lifeAt(index),
      color: pool.colorAt(index),
    });
  }
  return JSON.stringify(rows);
}

describe("ParticlePool spawn", () => {
  test("spawns the full burst profile and reports the active count", () => {
    const pool = new ParticlePool(64);
    const spawned = pool.spawn("collect", ORIGIN);
    expect(spawned).toBe(BURST_PROFILES.collect.count);
    expect(pool.activeCount).toBe(spawned);
  });

  test("starts every particle at the burst origin", () => {
    const pool = new ParticlePool(64);
    pool.spawn("win", ORIGIN);
    for (let index = 0; index < pool.activeCount; index += 1) {
      expect(pool.positionAt(index)).toEqual(ORIGIN);
    }
  });

  test("is deterministic for the same seed and differs for another seed", () => {
    const first = new ParticlePool(128);
    const second = new ParticlePool(128);
    const other = new ParticlePool(128);
    first.spawn("win", ORIGIN, { seed: 42 });
    second.spawn("win", ORIGIN, { seed: 42 });
    other.spawn("win", ORIGIN, { seed: 43 });

    expect(snapshot(first)).toBe(snapshot(second));
    expect(snapshot(first)).not.toBe(snapshot(other));
    expect(DEFAULT_PARTICLE_SEED).toBe(0x5eed);
  });

  test("fans directions along the golden angle, radius sqrt-distributed", () => {
    const pool = new ParticlePool(64);
    pool.spawn("collect", ORIGIN);
    for (let index = 0; index < 5; index += 1) {
      const [vx, , vz] = pool.velocityAt(index);
      const direction = Math.atan2(vz, vx);
      const expected = wrap(index * GOLDEN_ANGLE);
      expect(Math.cos(direction)).toBeCloseTo(Math.cos(expected), 5);
      expect(Math.sin(direction)).toBeCloseTo(Math.sin(expected), 5);
    }
    const firstRadius = Math.hypot(
      pool.velocityAt(0)[0],
      pool.velocityAt(0)[2]
    );
    const lastRadius = Math.hypot(
      pool.velocityAt(BURST_PROFILES.collect.count - 2)[0],
      pool.velocityAt(BURST_PROFILES.collect.count - 2)[2]
    );
    expect(lastRadius).toBeGreaterThan(firstRadius);
  });

  test("honors a single-color override and a palette override", () => {
    const expectColor = (
      actual: [number, number, number],
      expected: [number, number, number]
    ): void => {
      for (let channel = 0; channel < 3; channel += 1) {
        expect(actual[channel]).toBeCloseTo(expected[channel], 5);
      }
    };

    const pool = new ParticlePool(64);
    pool.spawn("collect", ORIGIN, { color: "#123456" });
    const expected = parseHexColor("#123456");
    for (let index = 0; index < pool.activeCount; index += 1) {
      expectColor(pool.colorAt(index), expected);
    }

    const palettePool = new ParticlePool(64);
    palettePool.spawn("win", ORIGIN, { palette: ["#ff0000", "#00ff00"] });
    expectColor(palettePool.colorAt(0), parseHexColor("#ff0000"));
    expectColor(palettePool.colorAt(1), parseHexColor("#00ff00"));
    expectColor(palettePool.colorAt(2), parseHexColor("#ff0000"));
  });

  test("never exceeds capacity and reports truncation", () => {
    const pool = new ParticlePool(30);
    const spawned = pool.spawn("win", ORIGIN);
    expect(spawned).toBe(30);
    expect(pool.activeCount).toBe(30);
    expect(pool.spawn("win", ORIGIN)).toBe(0);
    expect(pool.activeCount).toBe(30);
  });
});

describe("ParticlePool update / expiry", () => {
  test("non-positive dt is a no-op", () => {
    const pool = new ParticlePool(64);
    pool.spawn("collect", ORIGIN);
    expect(pool.update(0)).toBe(0);
    expect(pool.update(-1)).toBe(0);
    expect(pool.activeCount).toBe(BURST_PROFILES.collect.count);
  });

  test("integrates positions and applies gravity", () => {
    const pool = new ParticlePool(64);
    pool.spawn("collect", ORIGIN);
    const velocity = pool.velocityAt(0);
    pool.update(0.1);

    const position = pool.positionAt(0);
    expect(position[0]).toBeCloseTo(ORIGIN[0] + velocity[0] * 0.1, 5);
    expect(position[1]).toBeCloseTo(ORIGIN[1] + velocity[1] * 0.1, 5);
    expect(position[2]).toBeCloseTo(ORIGIN[2] + velocity[2] * 0.1, 5);
    expect(pool.velocityAt(0)[1]).toBeLessThan(velocity[1]);
    expect(pool.lifeAt(0)).toBeCloseTo(pool.maxLifeAt(0) - 0.1, 5);
  });

  test("expires particles by age and keeps slots compact", () => {
    const pool = new ParticlePool(256);
    const spawned = pool.spawn("collect", ORIGIN);
    const longest = Math.max(
      ...Array.from({ length: spawned }, (_, index) => pool.maxLifeAt(index))
    );

    expect(pool.update(longest / 2)).toBe(0);
    expect(pool.activeCount).toBeGreaterThan(0);

    const remaining = pool.activeCount;
    const expired = pool.update(longest);
    expect(expired).toBe(remaining);
    expect(pool.activeCount).toBe(0);
  });

  test("expiry and integration are deterministic", () => {
    const run = (): string => {
      const pool = new ParticlePool(256);
      pool.spawn("win", ORIGIN, { seed: 7 });
      pool.update(0.3);
      pool.update(0.9);
      return snapshot(pool, 10);
    };
    expect(run()).toBe(run());
  });

  test("writeTo fades colors by remaining life and copies positions", () => {
    const pool = new ParticlePool(64);
    pool.spawn("lose", ORIGIN);
    const halfLife = pool.maxLifeAt(0) / 2;
    pool.update(halfLife);

    const positions = new Float32Array(pool.capacity * 3);
    const colors = new Float32Array(pool.capacity * 3);
    pool.writeTo(positions, colors);

    expect(positions[0]).toBeCloseTo(pool.positionAt(0)[0], 5);
    const alpha = pool.alphaAt(0);
    expect(alpha).toBeCloseTo(0.5, 5);
    const base = pool.colorAt(0);
    expect(colors[0]).toBeCloseTo(base[0] * alpha, 5);
    expect(colors[1]).toBeCloseTo(base[1] * alpha, 5);
    expect(colors[2]).toBeCloseTo(base[2] * alpha, 5);
  });
});

describe("ParticleSystem", () => {
  function newScene(): THREE.Scene {
    return new THREE.Scene();
  }

  test("owns one scene-level Points object outside entity meshes", () => {
    const scene = newScene();
    const marker = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    marker.name = "player";
    scene.add(marker);

    const system = new ParticleSystem(scene);
    expect(scene.getObjectByName(PARTICLE_SYSTEM_NAME)).toBe(system.points);
    expect(system.points.userData.visualOnly).toBe(true);
    expect(system.points.parent).toBe(scene);
    expect(system.points.frustumCulled).toBe(false);

    system.dispose();
    expect(scene.getObjectByName(PARTICLE_SYSTEM_NAME)).toBeUndefined();
    expect(scene.children).toEqual([marker]);
  });

  test("burst, update and expiry stay in sync with the draw range", () => {
    const scene = newScene();
    const system = new ParticleSystem(scene);
    const spawned = system.burst("win", ORIGIN);
    expect(spawned).toBe(BURST_PROFILES.win.count);
    expect(system.activeCount).toBe(spawned);
    expect(system.points.geometry.drawRange.count).toBe(spawned);

    const attribute = system.points.geometry.getAttribute(
      "position"
    ) as THREE.BufferAttribute;
    expect(attribute.getX(0)).toBeCloseTo(ORIGIN[0], 5);
    expect(attribute.getY(0)).toBeCloseTo(ORIGIN[1], 5);
    expect(attribute.getZ(0)).toBeCloseTo(ORIGIN[2], 5);

    const expired = system.update(10);
    expect(expired).toBe(spawned);
    expect(system.activeCount).toBe(0);
    expect(system.points.geometry.drawRange.count).toBe(0);

    system.dispose();
  });

  test("clear empties the pool without removing the system", () => {
    const scene = newScene();
    const system = new ParticleSystem(scene);
    system.burst("collect", ORIGIN);
    system.clear();
    expect(system.activeCount).toBe(0);
    expect(scene.getObjectByName(PARTICLE_SYSTEM_NAME)).toBe(system.points);
    system.dispose();
  });
});

describe("particle purity", () => {
  test("particles module never uses Math.random", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/particles.ts", import.meta.url)),
      "utf8"
    );
    expect(source).not.toMatch(/Math\s*\.\s*random\s*\(/);
  });

  test("parseHexColor handles shorthand and invalid input", () => {
    expect(parseHexColor("#ffffff")).toEqual([1, 1, 1]);
    expect(parseHexColor("000000")).toEqual([0, 0, 0]);
    expect(parseHexColor("not-a-color")).toEqual([1, 1, 1]);
  });
});

function wrap(angle: number): number {
  const tau = Math.PI * 2;
  return ((angle + Math.PI) % tau + tau) % tau - Math.PI;
}
