import * as THREE from "three";

/** Maximum pointer travel (px) for a press/release pair to count as a click. */
export const CLICK_MOVE_TOLERANCE_PX = 6;
/** Maximum press duration (ms) for a press/release pair to count as a click. */
export const CLICK_DURATION_LIMIT_MS = 350;

/** A pointer position plus the time it was observed, used for gestures. */
export interface PointerSample {
  x: number;
  y: number;
  time: number;
}

/**
 * Pure click-vs-drag discrimination: a press/release pair is a click when the
 * pointer moved less than `CLICK_MOVE_TOLERANCE_PX` and was held for less than
 * `CLICK_DURATION_LIMIT_MS`. Degenerate samples (missing / non-finite values,
 * negative duration) are never clicks.
 */
export function isClickGesture(
  down: PointerSample | null | undefined,
  up: PointerSample | null | undefined
): boolean {
  if (!down || !up) return false;
  const values = [down.x, down.y, down.time, up.x, up.y, up.time];
  if (values.some((value) => !Number.isFinite(value))) return false;
  const duration = up.time - down.time;
  if (duration < 0 || duration >= CLICK_DURATION_LIMIT_MS) return false;
  return (
    Math.hypot(up.x - down.x, up.y - down.y) < CLICK_MOVE_TOLERANCE_PX
  );
}

/**
 * Nearest entity id along an already-configured ray. Hits come back sorted by
 * distance; each hit's ancestors are searched so meshes inside an entity view
 * (parts groups, label sprites, the highlight ring) resolve to the owning
 * entity's id. Hits without any `userData.entityId` ancestor (ground, lights,
 * particles, effects) are skipped, so scenery in front of an entity is
 * harmless. Hits whose object or any ancestor is hidden (`visible === false`)
 * are skipped entirely, so invisible entities are never pickable.
 */
export function intersectEntity(
  raycaster: THREE.Raycaster,
  objects: readonly THREE.Object3D[]
): string | null {
  const hits = raycaster.intersectObjects(objects as THREE.Object3D[], true);
  for (const hit of hits) {
    let object: THREE.Object3D | null = hit.object;
    let hidden = false;
    let entityId: string | null = null;
    while (object !== null) {
      if (object.visible === false) {
        hidden = true;
        break;
      }
      const id = object.userData?.entityId;
      if (entityId === null && typeof id === "string" && id.length > 0) {
        entityId = id;
      }
      object = object.parent;
    }
    if (!hidden && entityId !== null) return entityId;
  }
  return null;
}

/** Normalized device coordinates in [-1, 1] on both axes. */
export interface NdcCoords {
  x: number;
  y: number;
}

/**
 * Configure `raycaster` from a camera and an NDC point (screen center by
 * default) and return the nearest entity id under it, if any.
 */
export function pickEntityId(
  raycaster: THREE.Raycaster,
  camera: THREE.Camera,
  objects: readonly THREE.Object3D[],
  ndc: NdcCoords = { x: 0, y: 0 }
): string | null {
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  return intersectEntity(raycaster, objects);
}

/** Engine hover edge produced by a hovered-id change. */
export interface HoverEdgeEvent {
  type: "hoverEnter" | "hoverLeave";
  targetId: string;
}

/**
 * Hover-edge events for a hovered-id transition: leave for the previous id,
 * then enter for the next. Identical ids produce no events (change-only
 * throttling); `null` means nothing is hovered.
 */
export function hoverEdgeEvents(
  previous: string | null,
  next: string | null
): HoverEdgeEvent[] {
  if (previous === next) return [];
  const events: HoverEdgeEvent[] = [];
  if (previous !== null) events.push({ type: "hoverLeave", targetId: previous });
  if (next !== null) events.push({ type: "hoverEnter", targetId: next });
  return events;
}

/** Outcome of ending a pointer gesture. */
export type GestureOutcome = "click" | "drag" | "cancel";

/**
 * Pure release decision: a cancelled gesture (pointercancel) always aborts
 * without a click; otherwise `isClickGesture` separates clicks from drags.
 */
export function gestureOutcome(
  down: PointerSample | null | undefined,
  up: PointerSample | null | undefined,
  cancelled = false
): GestureOutcome {
  if (cancelled) return "cancel";
  return isClickGesture(down, up) ? "click" : "drag";
}
