import { resolveMode } from "@prompt-to-playable/engine";
import type { Entity, GameDoc } from "@prompt-to-playable/schema";

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

/** First-person look limits (radians), roughly 69 degrees up and down. */
export const FIRST_PERSON_MIN_PITCH = -1.2;
export const FIRST_PERSON_MAX_PITCH = 1.2;

/**
 * Mode-aware pitch clamp. First person looks freely up/down within
 * `[FIRST_PERSON_MIN_PITCH, FIRST_PERSON_MAX_PITCH]`; orbit (and chase, which
 * ignores drag) keeps the historical orbit clamp.
 */
export function clampPitchFor(mode: CameraMode, pitch: number): number {
  if (mode === "firstPerson") {
    return Math.max(
      FIRST_PERSON_MIN_PITCH,
      Math.min(FIRST_PERSON_MAX_PITCH, pitch)
    );
  }
  return clampPitch(pitch);
}

/** First-person look is slightly faster than orbit drag. */
export const FIRST_PERSON_DRAG_SCALE = 1.2;

/** Per-mode pointer-drag scale applied to both yaw and pitch deltas. */
export function dragScaleFor(mode: CameraMode): number {
  return mode === "firstPerson" ? FIRST_PERSON_DRAG_SCALE : 1;
}

/**
 * Inspect scenes frame their content top-down: a steep pitch, a yaw that looks
 * straight down the board's z axis and an orbit distance auto-fitted to the
 * assembly's bounding box. `INSPECT_DISTANCE` is the fallback when the
 * document has no parts to measure.
 */
export const INSPECT_DISTANCE = 15;
export const INSPECT_PITCH = 1.05;
/**
 * Rig yaw that cancels the default offset's `(6, 8, 12)` horizontal slant, so
 * the camera sits on the +Z axis and looks straight along the board's z axis
 * (the default offset's azimuth is `atan2(6, 12)` around +Z, so the straight
 * view is its negation). Derived from `DEFAULT_CAMERA_OFFSET`, never
 * hardcoded.
 */
export const INSPECT_YAW = -DEFAULT_AZIMUTH;
/**
 * Multiplier applied to the assembly bbox diagonal to get the orbit distance.
 * At `INSPECT_PITCH` and a 16:9 frame, `0.6` puts a 12-unit-wide board across
 * roughly three quarters of the viewport (the previous `1.1` left it at about
 * 40%, with the assembly adrift in the middle of the scene).
 */
export const INSPECT_FIT_SCALE = 0.6;
/** Auto-fit distance clamps: closer than this overwhelms, farther loses detail. */
export const INSPECT_FIT_MIN_DISTANCE = 8;
export const INSPECT_FIT_MAX_DISTANCE = 26;

/**
 * Machine scenes reuse the inspect assembly framing (bbox-centered orbit,
 * hidden player, auto-fitted clamped distance) but are viewed in perspective
 * instead of straight down: `MACHINE_PITCH` is a classic product-shot
 * elevation (~31 degrees, well clear of the top-down `INSPECT_PITCH`), and
 * `MACHINE_YAW` is the straight-on inspect yaw turned a quarter turn so the
 * camera sits exactly on the +X/+Z diagonal - the textbook three-quarter
 * view. Derived from the existing pure constants, never hardcoded.
 */
export const MACHINE_PITCH = 0.55;
export const MACHINE_YAW = INSPECT_YAW + Math.PI / 4;

/** Axis-aligned footprint of one entity that participates in the camera fit. */
export interface InspectBoundsBox {
  position: readonly [number, number, number];
  size: readonly [number, number, number];
}

/** Union AABB of a list of framing boxes, or `undefined` when it is empty. */
function inspectAssemblyBounds(
  boxes: readonly InspectBoundsBox[]
): { min: [number, number, number]; max: [number, number, number] } | undefined {
  if (boxes.length === 0) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis += 1) {
      const half = Math.abs(box.size[axis]) / 2;
      const center = box.position[axis];
      min[axis] = Math.min(min[axis], center - half);
      max[axis] = Math.max(max[axis], center + half);
    }
  }
  return { min, max };
}

/**
 * Diagonal of the union of the given AABBs, or `undefined` when the list is
 * empty. Sizes are treated as absolute full extents (the engine convention), so
 * each box spans `position ± size / 2`.
 */
export function inspectAssemblyDiagonal(
  boxes: readonly InspectBoundsBox[]
): number | undefined {
  const bounds = inspectAssemblyBounds(boxes);
  if (!bounds) return undefined;
  return Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );
}

/**
 * Center of the union of the given AABBs, or `undefined` when the list is
 * empty. The inspect orbit target: framing the parts assembly (not an authored
 * player spawn that can sit far off the board) keeps the model centered in the
 * frame under drag and zoom.
 */
export function inspectAssemblyCenter(
  boxes: readonly InspectBoundsBox[]
): [number, number, number] | undefined {
  const bounds = inspectAssemblyBounds(boxes);
  if (!bounds) return undefined;
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

/**
 * Orbit distance that frames an inspect assembly from its boxes: the bbox
 * diagonal times `INSPECT_FIT_SCALE`, clamped to
 * `[INSPECT_FIT_MIN_DISTANCE, INSPECT_FIT_MAX_DISTANCE]`.
 * Falls back to `INSPECT_DISTANCE` when there is nothing to measure.
 */
export function inspectCameraDistance(
  boxes: readonly InspectBoundsBox[]
): number {
  const diagonal = inspectAssemblyDiagonal(boxes);
  if (diagonal === undefined) return INSPECT_DISTANCE;
  return Math.max(
    INSPECT_FIT_MIN_DISTANCE,
    Math.min(INSPECT_FIT_MAX_DISTANCE, diagonal * INSPECT_FIT_SCALE)
  );
}

/**
 * Framing boxes of every entity that carries parts: each part contributes
 * `position + (offset ± size / 2) * scale` in world space, where the entity
 * scale is `size ?? scale ?? [1, 1, 1]` (parts on a sized entity are authored
 * in entity-local fractions). Part rotations are ignored - this is a framing
 * box, not a collision hull.
 *
 * `worldPositions` optionally overrides each entity's origin with an engine
 * runtime position: parented entities author their local pose, so their
 * resolved world pose (from the loaded engine state) is what actually frames
 * the visible assembly.
 */
export function partEntityBoxes(
  entities: readonly Entity[],
  worldPositions?: ReadonlyMap<string, readonly [number, number, number]>
): InspectBoundsBox[] {
  const boxes: InspectBoundsBox[] = [];
  for (const entity of entities) {
    if (!entity.parts || entity.parts.length === 0) continue;
    const scale = entity.size ?? entity.scale ?? [1, 1, 1];
    const origin = worldPositions?.get(entity.id) ?? entity.position;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const part of entity.parts) {
      const offset = part.offset ?? [0, 0, 0];
      const size = part.size ?? [1, 1, 1];
      for (let axis = 0; axis < 3; axis += 1) {
        const center = origin[axis] + offset[axis] * scale[axis];
        const half = Math.abs(size[axis] * scale[axis]) / 2;
        min[axis] = Math.min(min[axis], center - half);
        max[axis] = Math.max(max[axis], center + half);
      }
    }
    boxes.push({
      position: [
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
      ],
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    });
  }
  return boxes;
}

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
 * Mode -> camera mapping. inspect / explore / game / machine / world keep the
 * orbit rig (with different defaults), walkthrough becomes first person and
 * drive becomes a heading-following chase camera. A player flagged
 * `props.vehicle` uses the chase camera in every mode, matching the engine's
 * vehicle controller. Documents without an explicit `meta.mode` resolve through
 * the regular backward-compatible inference (explore archetype -> explore,
 * every other archetype -> game), so they stay orbit.
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
 * once the drag ends it eases exponentially back to the rig's home orientation
 * (`YAW_RETURN_SECONDS` to ~1%), which defaults to the behind-player view but
 * can be set to `INSPECT_YAW` (straight-on board) or `MACHINE_YAW`
 * (three-quarter assembly) for the assembly framings.
 * `update(dt)` takes seconds.
 */
export class CameraRig {
  yaw: number;
  pitch: number;
  distance: number;
  /**
   * Yaw the ease-back returns to. `0` is the historical behind-player view;
   * inspect mode sets `INSPECT_YAW` (straight-on board) and machine mode
   * `MACHINE_YAW` (three-quarter assembly), so a drag relaxes back to the
   * framing instead of the default diagonal.
   */
  homeYaw = 0;
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

  /**
   * Applies a pointer delta (pixels). Any drag marks the rig as dragging. The
   * camera mode selects the pitch clamp and drag scale: first person looks
   * further up/down and slightly faster, orbit keeps the historical feel.
   */
  drag(dx: number, dy: number, mode: CameraMode = "orbit"): void {
    const scale = dragScaleFor(mode);
    if (Number.isFinite(dx)) this.yaw += dx * scale * YAW_SENSITIVITY;
    if (Number.isFinite(dy)) {
      this.pitch = clampPitchFor(
        mode,
        this.pitch - dy * scale * PITCH_SENSITIVITY
      );
    }
    this.dragging = true;
  }

  /** Applies a wheel delta (positive scrolls out); clamps the distance. */
  zoom(delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.distance = clampDistance(this.distance + delta * ZOOM_SENSITIVITY);
  }

  /**
   * Advances the yaw ease-back toward `homeYaw`. No-op while dragging or for
   * non-positive dt.
   */
  update(dt: number): void {
    if (this.dragging || !(dt > 0) || !Number.isFinite(dt)) return;
    const delta = (this.yaw - this.homeYaw) * Math.exp(-YAW_RETURN_RATE * dt);
    this.yaw =
      Math.abs(delta) < YAW_RETURN_EPSILON ? this.homeYaw : this.homeYaw + delta;
  }

  /** Restores the home view (behind-player unless `homeYaw` says otherwise). */
  reset(): void {
    this.yaw = this.homeYaw;
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
