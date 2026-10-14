import type { Entity, Part, PartShape, Vec3 } from "@prompt-to-playable/schema";
import * as THREE from "three";
import { entityColor } from "./scene.js";
import {
  GLASS_OPACITY,
  GLASS_ROUGHNESS,
  textureForName,
} from "./textures.js";

/**
 * Assemblies: `entity.parts` describes primitive parts authored in the
 * entity's local unit space (a 1x1x1 box centered on the origin). The root
 * group is placed/scaled like any other entity view, so `entity.size` scales
 * the whole assembly and physics extents stay exact for entities without
 * parts.
 */

/** userData flag on the parts root group. */
export const PARTS_OBJECT_KEY = "partsObject";
/** userData keys on tintable (color-less) part materials. */
export const PART_TINTABLE_KEY = "partTintable";
export const PART_BASE_COLOR_KEY = "partBaseColor";
/** userData key naming the source shape on each part mesh. */
export const PART_SHAPE_KEY = "partShape";

/** True when the entity carries a non-empty assembly description. */
export function hasParts(entity: Entity): boolean {
  return Array.isArray(entity.parts) && entity.parts.length > 0;
}

/**
 * Unit geometry per part shape: every primitive fits inside the unit cube
 * ([-0.5, 0.5] on each axis) so a part's world extents equal its `size`.
 */
export function createPartGeometry(shape: PartShape): THREE.BufferGeometry {
  switch (shape) {
    case "sphere":
      return new THREE.SphereGeometry(0.5, 24, 16);
    case "cylinder":
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
    case "cone":
      return new THREE.ConeGeometry(0.5, 1, 16);
    case "torus":
      return new THREE.TorusGeometry(0.35, 0.15, 12, 24);
    case "capsule":
      return new THREE.CapsuleGeometry(0.25, 0.5, 4, 12);
    case "wedge":
      return createWedgeGeometry();
    case "plane":
      return new THREE.PlaneGeometry(1, 1);
    case "box":
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

/**
 * Unit wedge (right triangular prism): triangle in XY at z in [-0.5, 0.5],
 * so the bounding box is exactly the unit cube.
 */
function createWedgeGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.5);
  shape.lineTo(0.5, -0.5);
  shape.lineTo(-0.5, 0.5);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    bevelEnabled: false,
  });
  geometry.translate(0, 0, -0.5);
  return geometry;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, 0, 1);
}

/** Numeric emissive (outside the schema) maps to a clamped emissive intensity. */
const MAX_EMISSIVE_INTENSITY = 4;

function applyMaterialEmissive(
  material: THREE.MeshStandardMaterial,
  emissive: string | number | undefined
): void {
  if (typeof emissive === "string") {
    material.emissive.set(emissive);
    material.emissiveIntensity = 1;
  } else if (typeof emissive === "number" && Number.isFinite(emissive)) {
    material.emissive.set(0xffffff);
    material.emissiveIntensity = clamp(emissive, 0, MAX_EMISSIVE_INTENSITY);
  }
}

/**
 * Material for one part: numeric fields are clamped to sane ranges
 * (metalness/roughness/opacity to 0..1, numeric emissive to 0..4), colors are
 * honored, `texture: "glass"` switches to translucent parameters, and every
 * other texture name becomes a cached canvas map when the DOM allows.
 *
 * Color-less parts are tagged tintable and remember their base color so the
 * renderer can re-tint (or restore) them when `runtime.color` changes.
 */
function partMaterial(
  part: Part,
  fallbackColor: string
): THREE.MeshStandardMaterial {
  const params = part.material;
  const base = new THREE.Color(part.color ?? fallbackColor);
  let opacity = clamp01(params?.opacity ?? 1, 1);
  let roughness = clamp01(params?.roughness ?? 0.6, 0.6);
  const metalness = clamp01(params?.metalness ?? 0.1, 0.1);

  if (params?.texture === "glass") {
    if (params.opacity === undefined) opacity = GLASS_OPACITY;
    if (params.roughness === undefined) roughness = GLASS_ROUGHNESS;
  }

  const material = new THREE.MeshStandardMaterial({
    color: base.clone(),
    metalness,
    roughness,
    opacity,
    transparent: opacity < 1,
    depthWrite: opacity >= 1,
  });

  if (part.color === undefined) {
    material.userData[PART_TINTABLE_KEY] = true;
    material.userData[PART_BASE_COLOR_KEY] = base.clone();
  }

  applyMaterialEmissive(material, params?.emissive);

  if (params?.texture === "glass") {
    material.side = THREE.DoubleSide;
  } else {
    const map =
      typeof params?.texture === "string"
        ? textureForName(params.texture)
        : null;
    if (map) material.map = map;
    if (part.shape === "plane") material.side = THREE.DoubleSide;
  }

  return material;
}

function buildPartMesh(part: Part, fallbackColor: string): THREE.Mesh {
  const mesh = new THREE.Mesh(createPartGeometry(part.shape), partMaterial(part, fallbackColor));
  const offset = part.offset ?? ([0, 0, 0] as Vec3);
  const rotation = part.rotation ?? ([0, 0, 0] as Vec3);
  const size = part.size ?? ([1, 1, 1] as Vec3);
  mesh.position.set(offset[0], offset[1], offset[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.scale.set(size[0], size[1], size[2]);
  mesh.userData[PART_SHAPE_KEY] = part.shape;
  return mesh;
}

/**
 * Build the assembly group for an entity: one mesh per part, each scaled by
 * `part.size`, placed at `part.offset`, rotated by `part.rotation`, with its
 * color (explicit part color, else the entity color) and material applied.
 * Pure geometry construction: the caller owns placement and disposal.
 */
export function buildPartsObject(entity: Entity): THREE.Group {
  const group = new THREE.Group();
  group.userData[PARTS_OBJECT_KEY] = true;
  const fallbackColor = entityColor(entity);
  for (const part of entity.parts ?? []) {
    group.add(buildPartMesh(part, fallbackColor));
  }
  return group;
}

/**
 * Apply the entity's root tint to tintable (color-less) part materials, or
 * restore their authored base colors when `color` is null. Parts with an
 * explicit `part.color` are never touched. Idempotent: colors are derived
 * from the stored base, never accumulated.
 */
export function applyPartsColor(
  object: THREE.Object3D,
  color: THREE.ColorRepresentation | null
): void {
  object.traverse((child) => {
    const materials = (child as THREE.Mesh).material;
    if (!materials) return;
    for (const material of Array.isArray(materials) ? materials : [materials]) {
      if (material.userData?.[PART_TINTABLE_KEY] !== true) continue;
      const shaded = material as THREE.MeshStandardMaterial;
      if (color !== null) {
        shaded.color.set(color);
      } else {
        const base = material.userData?.[PART_BASE_COLOR_KEY] as
          | THREE.Color
          | undefined;
        if (base) shaded.color.copy(base);
      }
    }
  });
}
