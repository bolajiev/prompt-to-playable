import { resolveMode } from "@prompt-to-playable/engine";
import type { GameDoc } from "@prompt-to-playable/schema";

/**
 * Third-person orbit camera rig: pure spherical math plus a tiny stateful
 * class. It contains no DOM or Three.js access, so orbit behavior is testable
 * in a plain node environment; `app.ts` forwards pointer/wheel deltas into
 * `drag`/`zoom` and consumes `desiredPosition`/`forwardGround`.
 *
 * Conventions:
 * - `yaw` rotates the camera horizontally around the player. `yaw === 0` is
 *   the default behind-player view whose offset is exactly `(6, 8, 12)`, so
 *   the camera-relative input basis is unchanged from the pre-rig app.
 * - `pitch` is the elevation angle above the horizontal plane. Larger pitch
 *   raises the camera; the default reproduces the `(6, 8, 12)` offset.
 * - `distance` is the full spherical radius from the player.
 */
export const DEFAULT_CAMERA_OFFSET: readonly [number, number, number] = [6, 8, 12];
const DEFAULT_HORIZONTAL = Math.hypot(
  DEFAULT_CAMERA_OFFSET[0],
  DEFAULT_CAMERA_OFFSET[2]
);
/** Radius of the default offset, used as the initial zoom distance. */
export const DEFAULT_DISTANCE = Math.hypot(DEFAULT_HORIZONTAL, DEFAULT_CAMERA_OFFSET[1]);
/** Pitch (radians) that reproduces the default offset's height ratio. */
export const DEFAULT_PITCH = Math.asin(DEFAULT_CAMERA_OFFSET[1] / DEFAULT_DISTANCE);
/** Azimuth (radians from +Z toward +X) of the default offset direction. */
const DEFAULT_AZIMUTH = Math.atan2(DEFAULT_CAMERA_OFFSET[0], DEFAULT_CAMERA_OFFSET[2]);

export const MIN_PITCH = -0.15 * Math.PI;
export const MAX_PITCH = 0.42 * Math.PI;
export const MIN_DISTANCE = 6;
export const MAX_DISTANCE = 28;

/** Radians of yaw per pixel of horizontal drag. */
export const YAW_SENSITIVITY = 0.006;
/** Radians of pitch per pixel of vertical drag (dragging up raises the camera). */
export const PITCH_SENSITIVITY = 0.004;
/** Distance units per unit of wheel delta. */
export const ZOOM_SENSITIVITY = 0.01;
/** Seconds after which the eased yaw has decayed to ~1% of its value. */
export const YAW_RETURN_SECONDS = 4;
export const YAW_RETURN_RATE = Math.log(100) / YAW_RETURN_SECONDS;
/** Yaw magnitudes below this snap to exactly 0. */
export const YAW_RETURN_EPSILON = 1e-3;

export function clampPitch(pitch: number): number {
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch));
}

export function clampDistance(distance: number): number {
  return Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, distance));
}

/**
 * Spherical offset of the camera relative to the player. `yaw === 0`,
 * `pitch === DEFAULT_PITCH`, `distance === DEFAULT_DISTANCE` yields
 * `DEFAULT_CAMERA_OFFSET` exactly.
 */
export function cameraOffset(
  yaw: number,
  pitch: number,
  distance: number
): [number, number, number] {
  const azimuth = DEFAULT_AZIMUTH + yaw;
  const horizontal = distance * Math.cos(pitch);
  return [
    horizontal * Math.sin(azimuth),
    distance * Math.sin(pitch),
    horizontal * Math.cos(azimuth),
  ];
}

/**
 * Camera ground-forward unit vector `[x, z]` (camera toward player on XZ),
 * the basis `toWorldInput` expects. Independent of pitch and distance. At
 * `yaw === 0` this is the historical `(-0.4472, -0.8944)` basis.
 */
export function forwardFromYaw(yaw: number): [number, number] {
  const azimuth = DEFAULT_AZIMUTH + yaw;
  return [-Math.sin(azimuth), -Math.cos(azimuth)];
}

/** Camera behavior selected for a resolved game mode. */
export type CameraMode = "orbit" | "firstPerson" | "chase";

/** Inspect scenes frame their content tighter than the default orbit view. */
export const INSPECT_DISTANCE = 10;
export const INSPECT_PITCH = 0.35;

/** First-person eye height above the player AABB center. */
export const FIRST_PERSON_EYE_HEIGHT = 1.6;
/** Chase camera sits this far behind the vehicle. */
export const CHASE_DISTANCE = 8;
/** Chase camera sits this high above the vehicle. */
export const CHASE_HEIGHT = 4;

/** Orbit distance the camera eases toward while a camera focus is active. */
export const FOCUS_DISTANCE = 8;
/** Exponential ease rate (per second) of the focus distance. */
export const FOCUS_DISTANCE_RATE = 5;

/**
 * Mode -> camera mapping. inspect / explore / game keep the orbit rig (with
 * different defaults), walkthrough becomes first person and drive becomes a
 * heading-following chase camera. A player flagged `props.vehicle` uses the
 * chase camera in every mode, matching the engine's vehicle controller.
 * Documents without an explicit `meta.mode` resolve through the regular
 * backward-compatible inference (explore archetype -> explore, every other
 * archetype -> game), so they stay orbit.
 */
export function resolveCameraMode(doc: GameDoc, vehicle = false): CameraMode {
  if (vehicle) return "chase";
  switch (resolveMode(doc)) {
    case "walkthrough":
      return "firstPerson";
    case "drive":
      return "chase";
    default:
      return "orbit";
  }
}

/**
 * Vehicle input predicate: chase camera (drive mode or `props.vehicle`) or a
 * player flagged `props.vehicle` consumes raw throttle/steer.
 */
export function usesVehicleInput(
  cameraMode: CameraMode,
  vehicle: boolean | undefined
): boolean {
  return cameraMode === "chase" || vehicle === true;
}

/** Camera eye position for first person: player center + eye height. */
export function firstPersonEye(
  position: readonly [number, number, number]
): [number, number, number] {
  return [position[0], position[1] + FIRST_PERSON_EYE_HEIGHT, position[2]];
}

/**
 * First-person look target one unit from the eye along the rig yaw/pitch.
 * `pitch > 0` (drag up) looks up; yaw 0 aims along the default ground forward.
 */
export function firstPersonLookAt(
  eye: readonly [number, number, number],
  yaw: number,
  pitch: number
): [number, number, number] {
  const [fx, fz] = forwardFromYaw(yaw);
  const horizontal = Math.cos(pitch);
  return [
    eye[0] + fx * horizontal,
    eye[1] + Math.sin(pitch),
    eye[2] + fz * horizontal,
  ];
}

/**
 * Chase camera position behind a vehicle whose heading points along
 * `[sin(heading), 0, cos(heading)]` (engine convention, 0 = +Z).
 */
export function chaseCameraPosition(
  position: readonly [number, number, number],
  heading: number
): [number, number, number] {
  return [
    position[0] - Math.sin(heading) * CHASE_DISTANCE,
    position[1] + CHASE_HEIGHT,
    position[2] - Math.cos(heading) * CHASE_DISTANCE,
  ];
}

/** Orbit focus bookkeeping carried across frames by `applyCameraFocus`. */
export interface FocusCameraState {
  /** True while a focus id is set and its position is known. */
  active: boolean;
  /** Rig distance to restore when the focus clears. */
  savedDistance: number | null;
}

/** One frame of focus consumption: next state, rig distance and look target. */
export interface FocusCameraStep {
  state: FocusCameraState;
  /** Rig distance for this frame (eases toward `FOCUS_DISTANCE`). */
  distance: number;
  /** World point to orbit/look at, or null for normal player follow. */
  target: [number, number, number] | null;
}

/**
 * Pure focus consumption step for the orbit camera. A defined focus id plus a
 * known position keeps the focus active and eases the rig distance toward
 * `FOCUS_DISTANCE`; the first focused frame remembers the pre-focus distance.
 * Clearing the focus (or an unknown entity id) restores that distance and
 * returns `target: null`, so the caller resumes player follow. Non-positive
 * or non-finite `dtSeconds` leaves the distance untouched.
 */
export function applyCameraFocus(
  state: FocusCameraState,
  focusId: string | undefined,
  position: readonly [number, number, number] | undefined,
  distance: number,
  dtSeconds: number
): FocusCameraStep {
  if (focusId === undefined || position === undefined) {
    return {
      state: { active: false, savedDistance: null },
      distance:
        state.active && state.savedDistance !== null
          ? state.savedDistance
          : distance,
      target: null,
    };
  }

  const savedDistance =
    state.active && state.savedDistance !== null
      ? state.savedDistance
      : distance;
  const eased =
    dtSeconds > 0 && Number.isFinite(dtSeconds)
      ? distance +
        (FOCUS_DISTANCE - distance) *
          (1 - Math.exp(-FOCUS_DISTANCE_RATE * dtSeconds))
      : distance;

  return {
    state: { active: true, savedDistance },
    distance: eased,
    target: [position[0], position[1], position[2]],
  };
}

export interface CameraRigOptions {
  yaw?: number;
  pitch?: number;
  distance?: number;
}

/**
 * Stateful orbit rig. Pointer and wheel events are injected via `drag`/`zoom`
 * (the app owns the DOM listeners). While a drag is active the yaw stays put;
 * once the drag ends it eases exponentially back to the default behind-player
 * orientation (`YAW_RETURN_SECONDS` to ~1%). `update(dt)` takes seconds.
 */
export class CameraRig {
  yaw: number;
  pitch: number;
  distance: number;
  private dragging = false;

  constructor(options: CameraRigOptions = {}) {
    this.yaw = options.yaw ?? 0;
    this.pitch = options.pitch ?? DEFAULT_PITCH;
    this.distance = clampDistance(options.distance ?? DEFAULT_DISTANCE);
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  beginDrag(): void {
    this.dragging = true;
  }

  endDrag(): void {
    this.dragging = false;
  }

  /** Applies a pointer delta (pixels). Any drag marks the rig as dragging. */
  drag(dx: number, dy: number): void {
    if (Number.isFinite(dx)) this.yaw += dx * YAW_SENSITIVITY;
    if (Number.isFinite(dy)) {
      this.pitch = clampPitch(this.pitch - dy * PITCH_SENSITIVITY);
    }
    this.dragging = true;
  }

  /** Applies a wheel delta (positive scrolls out); clamps the distance. */
  zoom(delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.distance = clampDistance(this.distance + delta * ZOOM_SENSITIVITY);
  }

  /** Advances the yaw ease-back. No-op while dragging or for non-positive dt. */
  update(dt: number): void {
    if (this.dragging || !(dt > 0) || !Number.isFinite(dt)) return;
    this.yaw *= Math.exp(-YAW_RETURN_RATE * dt);
    if (Math.abs(this.yaw) < YAW_RETURN_EPSILON) this.yaw = 0;
  }

  /** Restores the default behind-player view. */
  reset(): void {
    this.yaw = 0;
    this.pitch = DEFAULT_PITCH;
    this.distance = DEFAULT_DISTANCE;
    this.dragging = false;
  }

  /** Current camera offset relative to the player. */
  offset(): [number, number, number] {
    return cameraOffset(this.yaw, this.pitch, this.distance);
  }

  /** World-space camera position for a player position. */
  desiredPosition(
    target: readonly [number, number, number]
  ): [number, number, number] {
    const [ox, oy, oz] = this.offset();
    return [target[0] + ox, target[1] + oy, target[2] + oz];
  }

  /** Camera ground-forward unit vector for `toWorldInput`. */
  forwardGround(): [number, number] {
    return forwardFromYaw(this.yaw);
  }
}
