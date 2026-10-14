import { SeededRng } from "@prompt-to-playable/shared";
import type { Vec3 } from "@prompt-to-playable/schema";
import * as THREE from "three";

/**
 * Pooled, deterministic particle system for gameplay feedback. The pool logic
 * (spawn / integrate / expire) is a pure data structure testable in node; the
 * `ParticleSystem` wrapper mirrors it into a single scene-level `THREE.Points`
 * object so particles never become children of entity meshes (physics extents
 * stay untouched). No `Math.random` is used anywhere: spawn directions follow a
 * golden-angle spiral and jitter comes from a seeded local generator.
 */

export type ParticleBurstKind = "collect" | "win" | "lose";

export interface BurstProfile {
  /** Particles per burst. */
  count: number;
  /** Base launch speed (world units / second). */
  speed: number;
  /** Fractional speed jitter (0.5 = +/- 25%). */
  speedSpread: number;
  /** Fraction of the launch speed applied upward. */
  upward: number;
  /** Downward acceleration (world units / second^2). */
  gravity: number;
  /** Base lifetime in seconds. */
  life: number;
  /** Fractional lifetime jitter (0.4 = +/- 20%). */
  lifeSpread: number;
  /** Candidate colors, cycled deterministically across the burst. */
  palette: readonly string[];
}

export const BURST_PROFILES: Record<ParticleBurstKind, BurstProfile> = {
  collect: {
    count: 22,
    speed: 3.2,
    speedSpread: 0.5,
    upward: 0.9,
    gravity: 6.5,
    life: 0.65,
    lifeSpread: 0.4,
    palette: ["#facc15", "#fde68a", "#f59e0b"],
  },
  win: {
    count: 96,
    speed: 5.5,
    speedSpread: 0.7,
    upward: 1.1,
    gravity: 3.4,
    life: 2.2,
    lifeSpread: 0.5,
    palette: ["#facc15", "#4ade80", "#60a5fa", "#f472b6", "#a78bfa", "#fb923c"],
  },
  lose: {
    count: 40,
    speed: 3.6,
    speedSpread: 0.6,
    upward: 0.8,
    gravity: 7.5,
    life: 0.8,
    lifeSpread: 0.4,
    palette: ["#ef4444", "#f87171", "#fca5a5"],
  },
};

/** Golden angle (radians): successive particles fan out without clustering. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Default fixed seed for the local spawn generator (never the engine RNG). */
export const DEFAULT_PARTICLE_SEED = 0x5eed;
/** Upper bound on live particles per scene. */
export const PARTICLE_CAPACITY = 768;
/** Name of the single scene-level particle object. */
export const PARTICLE_SYSTEM_NAME = "__particles";

export interface BurstOptions {
  /** Replace the profile palette with one color (e.g. the collected entity's). */
  color?: string;
  /** Replace the profile palette entirely. */
  palette?: readonly string[];
  /** Local generator seed; the same seed replays the same burst. */
  seed?: number;
}

/** Parse `#rrggbb` into 0..1 RGB; invalid input falls back to white. */
export function parseHexColor(hex: string): [number, number, number] {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return [1, 1, 1];
  const value = match[1];
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
}

/**
 * Fixed-capacity structure-of-arrays particle pool. Spawning appends compact
 * slots; expiry swap-removes, so the first `activeCount` slots are always live.
 * Identical call sequences with identical seeds yield identical arrays.
 */
export class ParticlePool {
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly gravities: Float32Array;
  private readonly lives: Float32Array;
  private readonly maxLives: Float32Array;
  private readonly colors: Float32Array;
  private count = 0;

  constructor(readonly capacity: number = PARTICLE_CAPACITY) {
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.gravities = new Float32Array(capacity);
    this.lives = new Float32Array(capacity);
    this.maxLives = new Float32Array(capacity);
    this.colors = new Float32Array(capacity * 3);
  }

  get activeCount(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
  }

  /**
   * Emit one burst at `origin`. Deterministic layout: particle `i` flies along
   * angle `i * GOLDEN_ANGLE` at a radius `sqrt((i + 0.5) / count)` of the disc,
   * with speed/lifetime jitter drawn from a seed-local `SeededRng`.
   */
  spawn(kind: ParticleBurstKind, origin: Vec3, options: BurstOptions = {}): number {
    const profile = BURST_PROFILES[kind];
    const rng = new SeededRng(options.seed ?? DEFAULT_PARTICLE_SEED);
    const palette =
      options.palette ??
      (options.color !== undefined ? [options.color] : profile.palette);
    let spawned = 0;

    for (let index = 0; index < profile.count; index += 1) {
      if (this.count >= this.capacity) break;
      const angle = index * GOLDEN_ANGLE;
      const radius = Math.sqrt((index + 0.5) / profile.count);
      const speed =
        profile.speed * radius * (1 + (rng.next() - 0.5) * profile.speedSpread);
      const vx = Math.cos(angle) * speed;
      const vz = Math.sin(angle) * speed;
      const vy = speed * profile.upward * (0.4 + 0.6 * rng.next());
      const life = profile.life * (1 + (rng.next() - 0.5) * profile.lifeSpread);
      const color = parseHexColor(palette[index % palette.length]);
      this.append(origin, vx, vy, vz, profile.gravity, life, color);
      spawned += 1;
    }
    return spawned;
  }

  /**
   * Integrate live particles by `dt` seconds and expire finished ones.
   * Returns the number of particles that expired. Non-positive deltas no-op.
   */
  update(dt: number): number {
    if (!(dt > 0) || !Number.isFinite(dt)) return 0;
    let expired = 0;
    let index = 0;
    while (index < this.count) {
      const remaining = this.lives[index] - dt;
      if (remaining <= 0) {
        this.swapRemove(index);
        expired += 1;
        continue;
      }
      this.lives[index] = remaining;
      const offset = index * 3;
      this.positions[offset] += this.velocities[offset] * dt;
      this.positions[offset + 1] += this.velocities[offset + 1] * dt;
      this.positions[offset + 2] += this.velocities[offset + 2] * dt;
      this.velocities[offset + 1] -= this.gravities[index] * dt;
      index += 1;
    }
    return expired;
  }

  positionAt(index: number): Vec3 {
    const offset = index * 3;
    return [
      this.positions[offset],
      this.positions[offset + 1],
      this.positions[offset + 2],
    ];
  }

  velocityAt(index: number): Vec3 {
    const offset = index * 3;
    return [
      this.velocities[offset],
      this.velocities[offset + 1],
      this.velocities[offset + 2],
    ];
  }

  colorAt(index: number): [number, number, number] {
    const offset = index * 3;
    return [this.colors[offset], this.colors[offset + 1], this.colors[offset + 2]];
  }

  lifeAt(index: number): number {
    return this.lives[index];
  }

  maxLifeAt(index: number): number {
    return this.maxLives[index];
  }

  /** Remaining life fraction in (0, 1]; 0 for an invalid slot. */
  alphaAt(index: number): number {
    if (index < 0 || index >= this.count || this.maxLives[index] <= 0) return 0;
    return this.lives[index] / this.maxLives[index];
  }

  /**
   * Copy live particles into renderer-facing position/color arrays, fading the
   * color toward black as particles age (additive blending reads this as alpha).
   */
  writeTo(positions: Float32Array, colors: Float32Array): void {
    for (let index = 0; index < this.count; index += 1) {
      const offset = index * 3;
      const alpha = this.alphaAt(index);
      positions[offset] = this.positions[offset];
      positions[offset + 1] = this.positions[offset + 1];
      positions[offset + 2] = this.positions[offset + 2];
      colors[offset] = this.colors[offset] * alpha;
      colors[offset + 1] = this.colors[offset + 1] * alpha;
      colors[offset + 2] = this.colors[offset + 2] * alpha;
    }
  }

  private append(
    origin: Vec3,
    vx: number,
    vy: number,
    vz: number,
    gravity: number,
    life: number,
    color: [number, number, number]
  ): void {
    const index = this.count;
    const offset = index * 3;
    this.positions[offset] = origin[0];
    this.positions[offset + 1] = origin[1];
    this.positions[offset + 2] = origin[2];
    this.velocities[offset] = vx;
    this.velocities[offset + 1] = vy;
    this.velocities[offset + 2] = vz;
    this.gravities[index] = gravity;
    this.lives[index] = life;
    this.maxLives[index] = life;
    this.colors[offset] = color[0];
    this.colors[offset + 1] = color[1];
    this.colors[offset + 2] = color[2];
    this.count += 1;
  }

  private swapRemove(index: number): void {
    const last = this.count - 1;
    if (index !== last) {
      const target = index * 3;
      const source = last * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        this.positions[target + axis] = this.positions[source + axis];
        this.velocities[target + axis] = this.velocities[source + axis];
        this.colors[target + axis] = this.colors[source + axis];
      }
      this.gravities[index] = this.gravities[last];
      this.lives[index] = this.lives[last];
      this.maxLives[index] = this.maxLives[last];
    }
    this.count = last;
  }
}

/**
 * Scene-level view of a `ParticlePool`: one pooled `THREE.Points` object named
 * `__particles` with dynamic position/color attributes. Particles live at the
 * scene root, outside every entity mesh, so physics extents tests stay exact.
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  private readonly pool: ParticlePool;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;

  constructor(private readonly scene: THREE.Scene, capacity: number = PARTICLE_CAPACITY) {
    this.pool = new ParticlePool(capacity);
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage)
    );
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage)
    );
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.PointsMaterial({
      size: 0.16,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = PARTICLE_SYSTEM_NAME;
    this.points.frustumCulled = false;
    this.points.userData.effectLayer = true;
    this.points.userData.visualOnly = true;
    scene.add(this.points);
  }

  get activeCount(): number {
    return this.pool.activeCount;
  }

  burst(kind: ParticleBurstKind, origin: Vec3, options: BurstOptions = {}): number {
    const spawned = this.pool.spawn(kind, origin, options);
    this.sync();
    return spawned;
  }

  update(dt: number): number {
    const expired = this.pool.update(dt);
    this.sync();
    return expired;
  }

  clear(): void {
    this.pool.clear();
    this.sync();
  }

  dispose(): void {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }

  private sync(): void {
    this.pool.writeTo(this.positions, this.colors);
    this.geometry.setDrawRange(0, this.pool.activeCount);
    const position = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const color = this.geometry.getAttribute("color") as THREE.BufferAttribute;
    position.needsUpdate = true;
    color.needsUpdate = true;
  }
}
