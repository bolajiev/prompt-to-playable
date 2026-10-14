import type { Vec3 } from "@prompt-to-playable/schema";

/**
 * Pure, deterministic animation phase functions used by the entity adapter
 * and the particle system. Nothing here reads wall-clock time or randomness:
 * callers pass the engine snapshot's `time`/`dt`, so rendering the same state
 * twice produces identical poses.
 */

/** Reference horizontal speed (world units / second) for full bob amplitude. */
export const WALK_SPEED_REFERENCE = 6;
/** Peak vertical bob offset at full speed. */
export const WALK_BOB_AMPLITUDE = 0.09;
/** Bob angular frequency floor (radians / second); rises with speed. */
export const WALK_BOB_BASE_FREQUENCY = 6;
/** Extra bob angular frequency per world unit of speed. */
export const WALK_BOB_FREQUENCY_PER_SPEED = 0.7;
/** Speeds below this count as idle: no walk bob, no facing update. */
export const MOVING_SPEED_EPSILON = 0.05;
/** Exponential rate at which facing yaw eases toward the movement direction. */
export const FACING_LERP_RATE = 12;
/** Idle sway roll amplitude (radians) and angular frequency (radians / second). */
export const IDLE_SWAY_AMPLITUDE = 0.035;
export const IDLE_SWAY_FREQUENCY = 1.7;
/** Collectible spin rate (radians / second). */
export const SPIN_SPEED = Math.PI * 0.9;
/** Emissive pulse period in seconds. */
export const PULSE_PERIOD = 1.6;
/** Distance (world units) at which interactables light up. */
export const INTERACTABLE_RANGE = 2.5;
/** Enemies keep bobbing while patrol speed is low. */
export const ENEMY_BOB_SPEED_FLOOR = 2.5;
/** Deterministic lose-shake envelope: duration (seconds) and amplitude (units). */
export const LOSE_SHAKE_DURATION = 0.45;
export const LOSE_SHAKE_AMPLITUDE = 0.18;
/**
 * Nominal frame duration used to keep effects animating when engine time is
 * frozen (paused / won / lost snapshots are re-reconciled every render frame).
 */
export const NOMINAL_FRAME_DT = 1 / 60;

const TAU = Math.PI * 2;

export interface PlanarVelocity {
  vx: number;
  vz: number;
  speed: number;
}

/**
 * Horizontal velocity between two successive base positions. Non-positive or
 * non-finite deltas yield zero motion so the first frame stays still.
 */
export function planarVelocity(prev: Vec3, next: Vec3, dt: number): PlanarVelocity {
  if (!(dt > 0) || !Number.isFinite(dt)) return { vx: 0, vz: 0, speed: 0 };
  const vx = (next[0] - prev[0]) / dt;
  const vz = (next[2] - prev[2]) / dt;
  return { vx, vz, speed: Math.hypot(vx, vz) };
}

/**
 * Vertical bob offset for a walking entity: amplitude and frequency both rise
 * with horizontal speed, so movement reads as a stride. Idle speeds give zero.
 */
export function walkBob(speed: number, time: number): number {
  const clampedSpeed = Math.max(0, speed);
  if (clampedSpeed <= 0) return 0;
  const intensity = Math.min(clampedSpeed / WALK_SPEED_REFERENCE, 1);
  const frequency =
    WALK_BOB_BASE_FREQUENCY + clampedSpeed * WALK_BOB_FREQUENCY_PER_SPEED;
  return intensity * WALK_BOB_AMPLITUDE * Math.sin(frequency * time);
}

/** Small roll angle for idle entities; zero at `time = 0`. */
export function idleSway(time: number): number {
  return IDLE_SWAY_AMPLITUDE * Math.sin(time * IDLE_SWAY_FREQUENCY);
}

/** Constrain an angle to (-pi, pi]. */
export function wrapAngle(angle: number): number {
  return ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

/**
 * Ease `current` toward `target` along the shortest arc. `factor` is clamped
 * to [0, 1]: 0 keeps the current yaw, 1 snaps to the target.
 */
export function approachYaw(current: number, target: number, factor: number): number {
  const clamped = Math.min(1, Math.max(0, factor));
  return current + wrapAngle(target - current) * clamped;
}

/** Yaw (radians about +Y) that points an entity's local +Z along (vx, vz). */
export function movementYaw(vx: number, vz: number): number {
  return Math.atan2(vx, vz);
}

/** Collectible spin angle; linear in time, so it is trivially deterministic. */
export function spinPhase(time: number): number {
  return time * SPIN_SPEED;
}

/** Symmetric 0..1 emissive pulse (0.5 at `time = 0`). */
export function pulse(time: number): number {
  return 0.5 + 0.5 * Math.sin((time / PULSE_PERIOD) * TAU);
}

/**
 * Deterministic camera shake offset during [0, LOSE_SHAKE_DURATION): a decaying
 * sum of fixed sine waves. Zero before the shake and after it ends.
 */
export function shakeOffset(age: number): Vec3 {
  if (!(age >= 0) || age >= LOSE_SHAKE_DURATION) return [0, 0, 0];
  const decay = 1 - age / LOSE_SHAKE_DURATION;
  return [
    LOSE_SHAKE_AMPLITUDE * decay * Math.sin(age * 47),
    LOSE_SHAKE_AMPLITUDE * 0.6 * decay * Math.sin(age * 53 + 1.3),
    LOSE_SHAKE_AMPLITUDE * decay * Math.sin(age * 41 + 2.1),
  ];
}
