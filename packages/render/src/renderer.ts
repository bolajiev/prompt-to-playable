import type { GameState } from "@prompt-to-playable/engine";
import type { Entity } from "@prompt-to-playable/schema";
import * as THREE from "three";
import {
  diffEntities,
  EMISSIVE_STRENGTH,
  entityColor,
  entityTransform,
  TRANSLUCENT_KINDS,
  TRANSLUCENT_OPACITY,
  type EntityTransform,
} from "./scene.js";

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

  dispose(): void {
    for (const view of this.views.values()) {
      this.adapter.detach(view);
      this.adapter.dispose(view);
    }
    this.views.clear();
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

/** Materializes entities as Three.js objects attached to a target Object3D. */
export class ThreeViewAdapter implements ViewAdapter<THREE.Object3D> {
  constructor(private readonly target: THREE.Object3D) {}

  create(entity: Entity): THREE.Object3D {
    const mesh = new THREE.Mesh(geometryForKind(entity.kind), materialForEntity(entity));
    mesh.name = entity.id;
    mesh.userData.entityId = entity.id;
    mesh.userData.kind = entity.kind;
    return mesh;
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
    view.position.set(
      transform.position[0],
      transform.position[1],
      transform.position[2]
    );
    view.rotation.set(
      transform.rotation[0],
      transform.rotation[1],
      transform.rotation[2]
    );
    view.scale.set(
      transform.scale[0],
      transform.scale[1],
      transform.scale[2]
    );
    view.visible = transform.visible;
    view.userData.kind = entity.kind;

    const material = (view as THREE.Mesh).material;
    const color = new THREE.Color(entityColor(entity));
    const emissive = EMISSIVE_STRENGTH[entity.kind];
    const applyColor = (target: THREE.Material): void => {
      const shaded = target as THREE.MeshStandardMaterial;
      shaded.color?.set(color);
      if (emissive !== undefined && shaded.emissive) {
        shaded.emissive.copy(color).multiplyScalar(emissive);
      }
    };
    if (Array.isArray(material)) {
      material.forEach(applyColor);
    } else if (material && "color" in material) {
      applyColor(material);
    }
  }

  dispose(view: THREE.Object3D): void {
    const mesh = view as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else {
      material?.dispose?.();
    }
  }
}

/**
 * Engine -> renderer adapter. Consumes immutable GameState snapshots and
 * reconciles the Three.js scene. It never imports or calls engine mutators.
 */
export class Renderer {
  readonly camera: THREE.Camera;
  private readonly reconciler: EntityReconciler<THREE.Object3D>;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.camera = camera;
    this.reconciler = new EntityReconciler(new ThreeViewAdapter(scene));
  }

  get entityCount(): number {
    return this.reconciler.size;
  }

  reconcile(state: GameState): void {
    this.reconciler.reconcile(state);
  }

  dispose(): void {
    this.reconciler.dispose();
  }
}
