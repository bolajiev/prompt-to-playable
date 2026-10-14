import type { Entity, ScratchValue, World } from "@prompt-to-playable/schema";
import type { AABB, Vec3 } from "@prompt-to-playable/shared";
import { DEFAULT_PLAYER_SIZE, FLOOR_Y, resolveXZ, resolveY } from "./collision.js";
import type { InputState } from "./input.js";
import type { EntityRuntime } from "./state.js";

export const DEFAULT_VEHICLE_ACCEL = 10;
export const DEFAULT_VEHICLE_DRAG = 2.2;
export const DEFAULT_VEHICLE_MAX_SPEED = 14;
export const DEFAULT_VEHICLE_STEER_RATE = 1.8;
/** Reserved: cornering grip (unused until lateral slip lands). */
export const DEFAULT_VEHICLE_GRIP = 1;
export const DEFAULT_VEHICLE_REVERSE_FACTOR = 0.4;
/** Speed (units/s) at which steering reaches full authority. */
export const VEHICLE_STEER_SPEED_REFERENCE = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function numberProp(
  props: Record<string, ScratchValue> | undefined,
  key: string
): number | undefined {
  const value = props?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Arcade vehicle controller (pure): throttle is `moveZ`, steer is `moveX`.
 *
 * - `speed` is a scalar own by `runtime.speed`; `heading` (radians, 0 = +Z)
 *   steers toward +X for positive `moveX`, scaled by `min(1, |speed|/6)` so a
 *   parked vehicle cannot spin in place.
 * - Forward motion is `[sin(heading), 0, cos(heading)] * speed * dt`, then the
 *   existing AABB `resolveXZ` runs; a collision on an axis zeroes `speed`
 *   (no bounce). Gravity + floor rest apply; there is no jump.
 * - Props overrides: `maxSpeed`, `accel`, `drag`, `steerRate`, `grip`
 *   (reserved/unused). Deterministic: no randomness, no time source.
 */
export function stepVehicle(
  runtime: EntityRuntime,
  player: Entity,
  input: InputState,
  dt: number,
  solids: AABB[],
  world: World
): EntityRuntime {
  const size = player.size ?? DEFAULT_PLAYER_SIZE;
  const gravity = world.gravity ?? 9.8;
  const bounds = world.bounds;

  const accel = numberProp(player.props, "accel") ?? DEFAULT_VEHICLE_ACCEL;
  const drag = numberProp(player.props, "drag") ?? DEFAULT_VEHICLE_DRAG;
  const maxSpeed =
    numberProp(player.props, "maxSpeed") ?? DEFAULT_VEHICLE_MAX_SPEED;
  const steerRate =
    numberProp(player.props, "steerRate") ?? DEFAULT_VEHICLE_STEER_RATE;
  const topSpeed = Math.max(0, maxSpeed);

  let speed = runtime.speed ?? 0;
  let heading = runtime.heading ?? player.rotation?.[1] ?? 0;

  speed += input.moveZ * accel * dt - drag * speed * dt;
  speed = clamp(speed, -DEFAULT_VEHICLE_REVERSE_FACTOR * topSpeed, topSpeed);

  const steerFactor = Math.min(
    1,
    Math.abs(speed) / VEHICLE_STEER_SPEED_REFERENCE
  );
  heading += input.moveX * steerRate * dt * steerFactor;

  const position: Vec3 = [...runtime.position];
  const velocity: Vec3 = [...runtime.velocity];
  velocity[0] = Math.sin(heading) * speed;
  velocity[2] = Math.cos(heading) * speed;

  position[0] += velocity[0] * dt;
  position[2] += velocity[2] * dt;

  const desiredX = velocity[0];
  const desiredZ = velocity[2];
  const xz = resolveXZ(position, velocity, size, solids);
  position[0] = xz.pos[0];
  position[2] = xz.pos[2];
  velocity[0] = xz.vel[0];
  velocity[2] = xz.vel[2];

  if (
    (desiredX !== 0 && velocity[0] === 0) ||
    (desiredZ !== 0 && velocity[2] === 0)
  ) {
    speed = 0;
    velocity[0] = 0;
    velocity[2] = 0;
  }

  velocity[1] += -gravity * dt;
  position[1] += velocity[1] * dt;

  const y = resolveY(position, velocity, size, solids);
  position[1] = y.pos[1];
  velocity[1] = y.vel[1];
  let grounded = y.grounded;

  const halfHeight = size[1] / 2;
  if (!grounded && position[1] <= FLOOR_Y + halfHeight) {
    position[1] = FLOOR_Y + halfHeight;
    velocity[1] = 0;
    grounded = true;
  }

  const limitX = Math.max(0, bounds[0] / 2 - size[0] / 2);
  const limitZ = Math.max(0, bounds[2] / 2 - size[2] / 2);
  position[0] = clamp(position[0], -limitX, limitX);
  position[2] = clamp(position[2], -limitZ, limitZ);

  return { ...runtime, position, velocity, heading, speed, grounded };
}
