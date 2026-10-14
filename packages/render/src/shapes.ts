import type { Entity } from "@prompt-to-playable/schema";
import * as THREE from "three";

/**
 * Shape vocabulary for decorative `prop` entities. `props.shape` selects a
 * multi-part primitive group; anything missing, unknown or non-string falls
 * back to the plain unit box, so props without a shape keep the geometry every
 * rendered entity has always used (1x1x1 extents = physics full extents).
 */
export const PROP_SHAPES = [
  "tree",
  "rock",
  "campfire",
  "pillar",
  "statue",
  "lamp",
  "table",
  "flower",
  "building",
] as const;

export type PropShape = (typeof PROP_SHAPES)[number];

/** Resolved shape id: a vocabulary entry, or the box fallback. */
export type ResolvedPropShape = PropShape | "box";

export const DEFAULT_PROP_SHAPE: ResolvedPropShape = "box";

const PROP_SHAPE_SET: ReadonlySet<string> = new Set<string>(PROP_SHAPES);

/**
 * Pure `props.shape` resolution. Returns a vocabulary id or "box"; never
 * throws and never inspects anything but the `shape` entry.
 */
export function resolvePropShape(
  props: Entity["props"] | undefined
): ResolvedPropShape {
  const shape = props?.shape;
  if (typeof shape !== "string") return DEFAULT_PROP_SHAPE;
  return PROP_SHAPE_SET.has(shape) ? (shape as PropShape) : DEFAULT_PROP_SHAPE;
}

/** userData keys used to re-tint shape parts when the entity color changes. */
export const PROP_TINT_KEY = "propTint";
export const PROP_EMISSIVE_KEY = "propEmissive";

/** Per-part material: base color scaled by `tint`, emissive when requested. */
function shapeMaterial(
  base: THREE.Color,
  tint: number,
  emissive = 0
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: base.clone().multiplyScalar(tint),
    roughness: 0.7,
    metalness: 0.05,
  });
  material.userData[PROP_TINT_KEY] = tint;
  if (emissive > 0) {
    material.emissive.copy(base).multiplyScalar(emissive);
    material.userData[PROP_EMISSIVE_KEY] = emissive;
  }
  return material;
}

function part(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0]
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  return mesh;
}

/**
 * Build the multi-part primitive group for a resolved shape. Parts stay inside
 * the unit cube ([-0.5, 0.5] on every axis) so the entity's absolute extents
 * scale the whole shape, and every part owns fresh geometry; materials are
 * shared between identical parts within one group, never across entities, so
 * disposal can release a removed entity's resources unconditionally.
 */
export function createShapeObject(
  shape: PropShape,
  color: THREE.ColorRepresentation
): THREE.Group {
  const base = new THREE.Color(color);
  const group = new THREE.Group();
  group.userData.propShape = shape;

  switch (shape) {
    case "tree": {
      const trunk = shapeMaterial(base, 0.45);
      const foliage = shapeMaterial(base, 1);
      group.add(
        part(
          new THREE.CylinderGeometry(0.08, 0.12, 0.5, 8),
          trunk,
          [0, -0.25, 0]
        ),
        part(new THREE.ConeGeometry(0.32, 0.6, 12), foliage, [0, 0.2, 0])
      );
      break;
    }
    case "rock": {
      const stone = shapeMaterial(base, 1);
      const mesh = part(
        new THREE.DodecahedronGeometry(0.45),
        stone,
        [0, -0.05, 0]
      );
      mesh.scale.set(1, 0.8, 1);
      group.add(mesh);
      break;
    }
    case "campfire": {
      const log = shapeMaterial(base, 0.4);
      const ember = shapeMaterial(base, 1, 0.9);
      for (let i = 0; i < 3; i += 1) {
        group.add(
          part(
            new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8),
            log,
            [0, -0.44, 0],
            [0, (i * Math.PI) / 3, Math.PI / 2]
          )
        );
      }
      group.add(
        part(new THREE.SphereGeometry(0.14, 12, 8), ember, [0, -0.28, 0])
      );
      break;
    }
    case "pillar": {
      const stone = shapeMaterial(base, 1);
      group.add(
        part(new THREE.CylinderGeometry(0.22, 0.28, 1, 16), stone, [0, 0, 0])
      );
      break;
    }
    case "statue": {
      const pedestal = shapeMaterial(base, 0.55);
      const figure = shapeMaterial(base, 1);
      group.add(
        part(new THREE.BoxGeometry(0.6, 0.24, 0.6), pedestal, [0, -0.38, 0]),
        part(
          new THREE.CapsuleGeometry(0.16, 0.42, 4, 12),
          figure,
          [0, 0.06, 0]
        )
      );
      break;
    }
    case "lamp": {
      const pole = shapeMaterial(base, 0.4);
      const bulb = shapeMaterial(base, 1, 0.8);
      group.add(
        part(
          new THREE.CylinderGeometry(0.035, 0.05, 0.86, 8),
          pole,
          [0, -0.07, 0]
        ),
        part(new THREE.SphereGeometry(0.08, 12, 8), bulb, [0, 0.4, 0])
      );
      break;
    }
    case "table": {
      const top = shapeMaterial(base, 1);
      const legs = shapeMaterial(base, 0.6);
      group.add(part(new THREE.BoxGeometry(0.9, 0.08, 0.6), top, [0, 0.3, 0]));
      for (const x of [-0.38, 0.38]) {
        for (const z of [-0.24, 0.24]) {
          group.add(
            part(new THREE.BoxGeometry(0.07, 0.76, 0.07), legs, [x, -0.12, z])
          );
        }
      }
      break;
    }
    case "flower": {
      const stem = shapeMaterial(base, 0.5);
      const head = shapeMaterial(base, 1, 0.35);
      group.add(
        part(
          new THREE.CylinderGeometry(0.025, 0.035, 0.7, 6),
          stem,
          [0, -0.15, 0]
        ),
        part(new THREE.IcosahedronGeometry(0.16), head, [0, 0.32, 0])
      );
      break;
    }
    case "building": {
      const body = shapeMaterial(base, 0.85);
      const windows = shapeMaterial(base, 1, 0.25);
      group.add(part(new THREE.BoxGeometry(0.9, 0.9, 0.9), body, [0, 0, 0]));
      for (const x of [-0.25, 0.25]) {
        for (const z of [-0.45, 0.45]) {
          group.add(
            part(new THREE.BoxGeometry(0.16, 0.2, 0.02), windows, [x, 0.08, z])
          );
        }
      }
      break;
    }
  }

  return group;
}

/**
 * Re-tint a shape group (entity color changed on update). Only materials
 * tagged by `createShapeObject` are touched, so unrelated children such as
 * highlight rings are never affected.
 */
export function applyShapeColor(
  object: THREE.Object3D,
  color: THREE.ColorRepresentation
): void {
  const base = new THREE.Color(color);
  object.traverse((child) => {
    const materials = (child as THREE.Mesh).material;
    if (!materials) return;
    for (const material of Array.isArray(materials) ? materials : [materials]) {
      const tint = material.userData?.[PROP_TINT_KEY];
      if (typeof tint !== "number") continue;
      const shaded = material as THREE.MeshStandardMaterial;
      shaded.color.copy(base).multiplyScalar(tint);
      const emissive = material.userData?.[PROP_EMISSIVE_KEY];
      if (typeof emissive === "number") {
        shaded.emissive.copy(base).multiplyScalar(emissive);
      }
    }
  });
}
