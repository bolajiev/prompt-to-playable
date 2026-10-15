import type { GameState, GameStatus } from "@prompt-to-playable/engine";
import type { Entity, Vec3 } from "@prompt-to-playable/schema";
import * as THREE from "three";
import {
  approachYaw,
  ENEMY_BOB_SPEED_FLOOR,
  FACING_LERP_RATE,
  idleSway,
  INTERACTABLE_RANGE,
  LOSE_SHAKE_DURATION,
  MOVING_SPEED_EPSILON,
  movementYaw,
  NOMINAL_FRAME_DT,
  planarVelocity,
  pulse,
  shakeOffset,
  spinPhase,
  walkBob,
} from "./animation.js";
import { ParticleSystem, type ParticleBurstKind } from "./particles.js";
import { buildLabelObject, LABEL_FLAT_NAME } from "./labels.js";
import { applyPartsColor, buildPartsObject, hasParts } from "./parts.js";
import {
  diffEntities,
  EMISSIVE_STRENGTH,
  entityColor,
  entityTransform,
  kindDefaultScale,
  TRANSLUCENT_KINDS,
  TRANSLUCENT_OPACITY,
  type EntityTransform,
} from "./scene.js";
import {
  applyShapeColor,
  createShapeObject,
  resolvePropShape,
} from "./shapes.js";
import { TEXTURE_CLONE_KEY } from "./textures.js";

/**
 * Adapter boundary so reconciliation can be tested without Three.js.
 * Object of type `TView` is the renderer-side handle for one entity.
 */
export interface ViewAdapter<TView> {
  create(entity: Entity): TView;
  attach(view: TView): void;
  detach(view: TView): void;
  apply(view: TView, entity: Entity, transform: EntityTransform): void;
  dispose(view: TView): void;
}

/**
 * Keeps renderer-side views in sync with engine entities, keyed by entity id.
 * It only *reads* the GameState it is given; engine state is never mutated.
 */
export class EntityReconciler<TView> {
  private readonly views = new Map<string, TView>();

  constructor(private readonly adapter: ViewAdapter<TView>) {}

  get size(): number {
    return this.views.size;
  }

  has(id: string): boolean {
    return this.views.has(id);
  }

  /** Current view for an entity id, if any (read-only handle for the owner). */
  get(id: string): TView | undefined {
    return this.views.get(id);
  }

  reconcile(state: GameState): void {
    const { create, update, remove } = diffEntities(
      new Set(this.views.keys()),
      state.entities
    );

    for (const id of remove) {
      const view = this.views.get(id);
      if (view === undefined) continue;
      this.adapter.detach(view);
      this.adapter.dispose(view);
      this.views.delete(id);
    }

    for (const entity of create) {
      const view = this.adapter.create(entity);
      this.adapter.attach(view);
      this.adapter.apply(
        view,
        entity,
        entityTransform(entity, state.entityRuntime[entity.id])
      );
      this.views.set(entity.id, view);
    }

    for (const entity of update) {
      const view = this.views.get(entity.id);
      if (view === undefined) continue;
      this.adapter.apply(
        view,
        entity,
        entityTransform(entity, state.entityRuntime[entity.id])
      );
    }
  }

  /**
   * Detaches and disposes every view, leaving the reconciler reusable. Call
   * when the document identity changes: ids may be reused with different
   * kinds/shapes, so views must be rebuilt rather than patched in place.
   */
  clear(): void {
    for (const view of this.views.values()) {
      this.adapter.detach(view);
      this.adapter.dispose(view);
    }
    this.views.clear();
  }

  dispose(): void {
    this.clear();
  }
}

/**
 * Unit geometry per kind: every shape has a 1x1x1 bounding box so the mesh's
 * extents equal `entityTransform.scale`, which is the physics full extents.
 */
function geometryForKind(kind: Entity["kind"]): THREE.BufferGeometry {
  switch (kind) {
    case "player":
      return new THREE.SphereGeometry(0.5, 24, 16);
    case "enemy":
      return new THREE.ConeGeometry(0.5, 1, 16);
    case "collectible":
      return new THREE.OctahedronGeometry(0.5);
    case "zone":
      return new THREE.BoxGeometry(1, 1, 1);
    case "beam":
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

/**
 * Material per kind: zones use translucent `MeshBasicMaterial` volumes (no
 * depth writes) so content inside them stays visible; every other kind keeps
 * an opaque lit `MeshStandardMaterial`. Collectibles and enemies get a slight
 * emissive lift so they pop against dim scenes.
 */
function materialForEntity(entity: Entity): THREE.Material {
  const color = new THREE.Color(entityColor(entity));
  if (TRANSLUCENT_KINDS.has(entity.kind)) {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: TRANSLUCENT_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.6,
    metalness: 0.1,
  });
  const emissive = EMISSIVE_STRENGTH[entity.kind];
  if (emissive !== undefined) {
    material.emissive.copy(color).multiplyScalar(emissive);
  }
  return material;
}

/** Name of the in-range highlight ring added to interactables. */
export const HIGHLIGHT_RING_NAME = "__highlightRing";
/** Ring radii: outer diameter is exactly 1 unit, so entity Box3 stays exact. */
export const HIGHLIGHT_RING_INNER_RADIUS = 0.34;
export const HIGHLIGHT_RING_OUTER_RADIUS = 0.5;
/** Ring height within the unit box (base of a floor-standing interactable). */
export const HIGHLIGHT_RING_OFFSET_Y = -0.44;
export const HIGHLIGHT_RING_COLOR = "#c4b5fd";
/** Highlight scale range; <= 1 keeps the ring inside the entity's unit box. */
export const HIGHLIGHT_RING_SCALE_MIN = 0.85;
export const HIGHLIGHT_RING_SCALE_MAX = 1;
/** Emissive pulse multipliers per kind (1 = the static EMISSIVE_STRENGTH). */
export const COLLECTIBLE_PULSE_MIN = 0.7;
export const COLLECTIBLE_PULSE_MAX = 1.3;
export const INTERACTABLE_IDLE_PULSE = 0.15;
export const INTERACTABLE_RANGE_PULSE = 0.9;

/** Root scale boost while an entity is highlighted (hover / focus). */
export const HIGHLIGHT_SCALE = 1.06;
/** Root scale amplitude per unit of a `pulse` animation value (0..1). */
export const PULSE_SCALE_AMPLITUDE = 0.06;

/** Read-only per-frame inputs used to animate entity views. */
export interface AnimationContext {
  /** Engine time in seconds; drives all phase functions. */
  time: number;
  /** Seconds since the previous reconcile; drives velocity and yaw easing. */
  dt: number;
  /** Player AABB center from this snapshot, or null when absent. */
  playerPosition: Vec3 | null;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Clamp a runtime pulse value to 0..1; missing/non-finite reads as 0. */
function clampPulse(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Dispose one mesh material. Per-part texture clones (tagged by
 * `textureMapForPart`) own a private GPU upload and are released here; shared
 * cached textures are never disposed, so they survive view disposal.
 */
function disposeMaterial(material: THREE.Material | null | undefined): void {
  if (!material) return;
  const map = (material as THREE.MeshStandardMaterial).map;
  if (map && map.userData?.[TEXTURE_CLONE_KEY] === true) map.dispose();
  material.dispose();
}

/**
 * Materializes entities as Three.js objects. Animation is applied to the ROOT
 * object only (position bob, yaw/roll rotation, emissive modulation), so
 * physics extents derived from the root's Box3 never change. Props with a
 * vocabulary `props.shape` become multi-part Groups whose parts all stay
 * inside the unit cube; interactables also get a `visualOnly` ring child that
 * stays inside the entity's unit box.
 */
export class ThreeViewAdapter implements ViewAdapter<THREE.Object3D> {
  context: AnimationContext = { time: 0, dt: 0, playerPosition: null };
  /** Entity id currently boosted by the hover/focus highlight, if any. */
  highlightId: string | null = null;

  constructor(private readonly target: THREE.Object3D) {}

  create(entity: Entity): THREE.Object3D {
    let view: THREE.Object3D;
    if (hasParts(entity)) {
      view = buildPartsObject(entity);
    } else {
      const shape =
        entity.kind === "prop" ? resolvePropShape(entity.props) : "box";
      view =
        shape === "box"
          ? new THREE.Mesh(
              geometryForKind(entity.kind),
              materialForEntity(entity)
            )
          : createShapeObject(
              shape,
              entityColor(entity),
              entity.size ?? entity.scale ?? kindDefaultScale(entity.kind)
            );
    }
    view.name = entity.id;
    view.userData.entityId = entity.id;
    view.userData.kind = entity.kind;
    if (entity.kind === "interactable") this.attachHighlightRing(view);
    if (entity.label) {
      const label = buildLabelObject(entity.label);
      label.userData.entityId = entity.id;
      view.add(label);
    }
    return view;
  }

  attach(view: THREE.Object3D): void {
    this.target.add(view);
  }

  detach(view: THREE.Object3D): void {
    this.target.remove(view);
  }

  apply(
    view: THREE.Object3D,
    entity: Entity,
    transform: EntityTransform
  ): void {
    const previous = view.userData.basePosition as Vec3 | undefined;
    const motion = previous
      ? planarVelocity(previous, transform.position, this.context.dt)
      : { vx: 0, vz: 0, speed: 0 };
    view.userData.basePosition = [...transform.position] as Vec3;

    let offsetY = 0;
    let yaw = (view.userData.yaw as number | undefined) ?? transform.rotation[1];
    let roll = transform.rotation[2];
    let emissiveScale = 1;

    switch (entity.kind) {
      case "player": {
        if (motion.speed >= MOVING_SPEED_EPSILON) {
          offsetY = walkBob(motion.speed, this.context.time);
          yaw = this.easedYaw(yaw, motion.vx, motion.vz);
        } else {
          roll = transform.rotation[2] + idleSway(this.context.time);
        }
        view.userData.yaw = yaw;
        break;
      }
      case "enemy": {
        offsetY = walkBob(
          Math.max(motion.speed, ENEMY_BOB_SPEED_FLOOR),
          this.context.time
        );
        if (motion.speed >= MOVING_SPEED_EPSILON) {
          yaw = this.easedYaw(yaw, motion.vx, motion.vz);
        }
        view.userData.yaw = yaw;
        break;
      }
      case "collectible": {
        yaw = transform.rotation[1] + spinPhase(this.context.time);
        emissiveScale =
          COLLECTIBLE_PULSE_MIN +
          (COLLECTIBLE_PULSE_MAX - COLLECTIBLE_PULSE_MIN) * pulse(this.context.time);
        break;
      }
      case "interactable": {
        const inRange =
          this.context.playerPosition !== null &&
          distance(this.context.playerPosition, transform.position) <=
            INTERACTABLE_RANGE;
        emissiveScale =
          1 +
          (inRange ? INTERACTABLE_RANGE_PULSE : INTERACTABLE_IDLE_PULSE) *
            pulse(this.context.time);
        this.updateHighlightRing(view, inRange);
        break;
      }
      default:
        break;
    }

    view.position.set(
      transform.position[0],
      transform.position[1] + offsetY,
      transform.position[2]
    );
    view.rotation.set(transform.rotation[0], yaw, roll);
    view.userData.baseScale = [
      transform.scale[0],
      transform.scale[1],
      transform.scale[2],
    ] as Vec3;
    view.userData.pulseScale =
      1 + PULSE_SCALE_AMPLITUDE * clampPulse(transform.pulse);
    this.applyViewScale(view);
    view.visible = transform.visible;
    view.userData.kind = entity.kind;

    if (view.userData.partsObject === true) {
      applyPartsColor(view, transform.color ?? null);
      return;
    }

    const color = new THREE.Color(entityColor(entity, transform.color));
    if (view.userData.propShape !== undefined) {
      applyShapeColor(view, color);
    } else {
      const material = (view as THREE.Mesh).material;
      const emissive = EMISSIVE_STRENGTH[entity.kind];
      const applyColor = (target: THREE.Material): void => {
        const shaded = target as THREE.MeshStandardMaterial;
        shaded.color?.set(color);
        if (emissive !== undefined && shaded.emissive) {
          shaded.emissive.copy(color).multiplyScalar(emissive * emissiveScale);
        }
      };
      if (Array.isArray(material)) {
        material.forEach(applyColor);
      } else if (material && "color" in material) {
        applyColor(material);
      }
    }
  }

  dispose(view: THREE.Object3D): void {
    view.traverse((object) => {
      if ((object as THREE.Sprite).isSprite) {
        const sprite = object as THREE.Sprite;
        sprite.material.map?.dispose();
        sprite.material.dispose();
        return;
      }
      if (object.name === LABEL_FLAT_NAME) {
        const label = object as THREE.Mesh<
          THREE.BufferGeometry,
          THREE.MeshBasicMaterial
        >;
        label.geometry?.dispose?.();
        label.material?.map?.dispose();
        label.material?.dispose?.();
        return;
      }
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach(disposeMaterial);
      } else {
        disposeMaterial(material);
      }
    });
  }

  /**
   * Re-apply the stored base scale with the current pulse and highlight
   * factors. Called by `Renderer.setHighlight` for an immediate visual flip
   * without waiting for the next reconcile.
   */
  refreshHighlight(view: THREE.Object3D): void {
    this.applyViewScale(view);
  }

  /** Root scale = base extents x pulse factor x highlight factor. */
  private applyViewScale(view: THREE.Object3D): void {
    const base = view.userData.baseScale as Vec3 | undefined;
    if (!base) return;
    const pulseScale = (view.userData.pulseScale as number | undefined) ?? 1;
    const highlightScale =
      view.userData.entityId === this.highlightId ? HIGHLIGHT_SCALE : 1;
    const factor = pulseScale * highlightScale;
    view.scale.set(base[0] * factor, base[1] * factor, base[2] * factor);
  }

  /** Frame-rate independent yaw easing factor from the current delta. */
  private easedYaw(current: number, vx: number, vz: number): number {
    const dt = this.context.dt;
    const factor = dt > 0 ? 1 - Math.exp(-FACING_LERP_RATE * dt) : 0;
    return approachYaw(current, movementYaw(vx, vz), factor);
  }

  private attachHighlightRing(mesh: THREE.Object3D): void {
    const geometry = new THREE.RingGeometry(
      HIGHLIGHT_RING_INNER_RADIUS,
      HIGHLIGHT_RING_OUTER_RADIUS,
      32
    );
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(HIGHLIGHT_RING_COLOR),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(geometry, material);
    ring.name = HIGHLIGHT_RING_NAME;
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = HIGHLIGHT_RING_OFFSET_Y;
    ring.visible = false;
    ring.userData.visualOnly = true;
    mesh.add(ring);
  }

  private updateHighlightRing(view: THREE.Object3D, inRange: boolean): void {
    const ring = view.getObjectByName(HIGHLIGHT_RING_NAME) as
      | THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
      | undefined;
    if (!ring) return;
    ring.visible = inRange;
    if (!inRange) return;
    const glow = pulse(this.context.time);
    ring.material.opacity = 0.35 + 0.45 * glow;
    const scale =
      HIGHLIGHT_RING_SCALE_MIN +
      (HIGHLIGHT_RING_SCALE_MAX - HIGHLIGHT_RING_SCALE_MIN) * glow;
    ring.scale.set(scale, scale, scale);
  }
}

interface TrackedEntity {
  position: Vec3;
  color: string;
}

function entityPosition(state: GameState, entity: Entity): Vec3 {
  const runtime = state.entityRuntime[entity.id];
  const position = runtime?.position ?? entity.position;
  return [position[0], position[1], position[2]];
}

function playerPosition(state: GameState): Vec3 | null {
  const player = state.entities.find((entity) => entity.kind === "player");
  if (!player) return null;
  return entityPosition(state, player);
}

function effectOrigin(position: Vec3 | null): Vec3 {
  if (!position) return [0, 3, 0];
  return [position[0], position[1] + 1.6, position[2]];
}

/**
 * Engine -> renderer adapter. Consumes immutable GameState snapshots and
 * reconciles the Three.js scene. It never imports or calls engine mutators.
 *
 * Beyond entity reconciliation it drives:
 * - entity animation (bob / idle sway / facing yaw / spin / emissive pulse)
 *   via the view adapter, without touching the root mesh's extents;
 * - a pooled scene-level particle system: collect bursts when a tracked entity
 *   disappears, win confetti and a lose burst + camera shake on status flips;
 * - a short deterministic lose camera shake.
 *
 * Effect tracking resets whenever `state.doc` changes identity (a new game or
 * an edit), so reloading a document never emits spurious bursts.
 */
export class Renderer {
  readonly camera: THREE.Camera;
  private readonly scene: THREE.Scene;
  private readonly adapter: ThreeViewAdapter;
  private readonly reconciler: EntityReconciler<THREE.Object3D>;

  private particles: ParticleSystem | null = null;
  private trackedDoc: GameState["doc"] | null = null;
  private readonly tracked = new Map<string, TrackedEntity>();
  private lastStatus: GameStatus | null = null;
  private lastTime: number | null = null;
  private loseShakeAge: number | null = null;
  private appliedShake: Vec3 | null = null;
  private highlightId: string | null = null;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.camera = camera;
    this.scene = scene;
    this.adapter = new ThreeViewAdapter(scene);
    this.reconciler = new EntityReconciler(this.adapter);
  }

  get entityCount(): number {
    return this.reconciler.size;
  }

  get particleCount(): number {
    return this.particles?.activeCount ?? 0;
  }

  /** Entity id currently highlighted, if any. */
  get highlightedId(): string | null {
    return this.highlightId;
  }

  /**
   * Highlight an entity by id (hover / focus) or clear with `null`. The
   * highlighted view is boosted to `HIGHLIGHT_SCALE` on its root; the effect
   * is derived from the stored base scale, so repeated calls with the same id
   * are idempotent and never accumulate. Unknown ids are remembered and apply
   * when the entity appears.
   */
  setHighlight(id: string | null): void {
    const next = id ?? null;
    if (next === this.highlightId) return;
    const previous = this.highlightId;
    this.highlightId = next;
    this.adapter.highlightId = next;
    if (previous !== null) {
      const view = this.reconciler.get(previous);
      if (view) this.adapter.refreshHighlight(view);
    }
    if (next !== null) {
      const view = this.reconciler.get(next);
      if (view) this.adapter.refreshHighlight(view);
    }
  }

  reconcile(state: GameState): void {
    const sameDoc = this.trackedDoc === state.doc;
    const dt = this.frameDelta(state, sameDoc);
    const removals = sameDoc ? this.collectRemovals(state) : [];

    if (!sameDoc) {
      this.tracked.clear();
      this.particles?.clear();
      this.loseShakeAge = null;
      this.undoCameraShake();
      this.reconciler.clear();
      this.highlightId = null;
      this.adapter.highlightId = null;
      this.trackedDoc = state.doc;
    }

    const player = playerPosition(state);
    this.adapter.context = { time: state.time, dt, playerPosition: player };
    this.reconciler.reconcile(state);

    if (sameDoc) {
      for (const gone of removals) {
        this.burst("collect", gone.position, { color: gone.color });
      }
      if (this.lastStatus !== null && this.lastStatus !== state.status) {
        if (state.status === "won") {
          this.burst("win", effectOrigin(player));
        } else if (state.status === "lost") {
          this.burst("lose", effectOrigin(player));
          this.loseShakeAge = 0;
        }
      }
    }
    this.lastStatus = state.status;

    this.tracked.clear();
    for (const entity of state.entities) {
      this.tracked.set(entity.id, {
        position: entityPosition(state, entity),
        color: entityColor(entity),
      });
    }

    this.particles?.update(dt);
    if (this.loseShakeAge !== null) {
      this.loseShakeAge += dt;
      if (this.loseShakeAge >= LOSE_SHAKE_DURATION) this.loseShakeAge = null;
    }
    this.applyCameraShake();
  }

  dispose(): void {
    this.undoCameraShake();
    this.particles?.dispose();
    this.particles = null;
    this.reconciler.dispose();
  }

  /**
   * Seconds since the previous snapshot. While the game runs this follows
   * engine time (zero when a render frame coincides with no engine step); when
   * time is frozen (won/lost) a nominal frame keeps effects animating.
   */
  private frameDelta(state: GameState, sameDoc: boolean): number {
    const previous = this.lastTime;
    this.lastTime = state.time;
    if (!sameDoc || previous === null) return 0;
    const delta = state.time - previous;
    if (delta > 0) return delta;
    return state.status === "running" ? 0 : NOMINAL_FRAME_DT;
  }

  private collectRemovals(state: GameState): TrackedEntity[] {
    if (this.tracked.size === 0) return [];
    const present = new Set<string>(state.entities.map((entity) => entity.id));
    const gone: TrackedEntity[] = [];
    for (const [id, tracked] of this.tracked) {
      if (!present.has(id)) gone.push(tracked);
    }
    return gone;
  }

  private burst(
    kind: ParticleBurstKind,
    origin: Vec3,
    options?: { color?: string }
  ): void {
    if (!this.particles) this.particles = new ParticleSystem(this.scene);
    this.particles.burst(kind, origin, options);
  }

  private applyCameraShake(): void {
    this.undoCameraShake();
    if (this.loseShakeAge === null) return;
    const offset = shakeOffset(this.loseShakeAge);
    if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) return;
    this.camera.position.x += offset[0];
    this.camera.position.y += offset[1];
    this.camera.position.z += offset[2];
    this.appliedShake = offset;
  }

  private undoCameraShake(): void {
    if (!this.appliedShake) return;
    this.camera.position.x -= this.appliedShake[0];
    this.camera.position.y -= this.appliedShake[1];
    this.camera.position.z -= this.appliedShake[2];
    this.appliedShake = null;
  }
}
