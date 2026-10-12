import {
  DEFAULT_PLAYER_SIZE,
  DEFAULT_ZONE_SIZE,
} from "@prompt-to-playable/engine";
import type { Entity, Vec3 } from "@prompt-to-playable/schema";

export interface EntityDiff {
  create: Entity[];
  update: Entity[];
  remove: string[];
}

/**
 * Pure reconciliation plan: compare the ids currently known to the renderer
 * with the entities present in the latest engine state. Never touches Three.js
 * or engine internals, so it is fully testable in node.
 */
export function diffEntities(
  prevIds: ReadonlySet<string>,
  next: readonly Entity[]
): EntityDiff {
  const create: Entity[] = [];
  const update: Entity[] = [];
  const seen = new Set<string>();

  for (const entity of next) {
    seen.add(entity.id);
    if (prevIds.has(entity.id)) update.push(entity);
    else create.push(entity);
  }

  const remove: string[] = [];
  for (const id of prevIds) {
    if (!seen.has(id)) remove.push(id);
  }

  return { create, update, remove };
}

export interface EntityRuntimeTransform {
  position?: Vec3;
  rotation?: Vec3;
  active?: boolean;
}

export interface EntityTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
}

/**
 * Absolute full extents the engine assumes per kind when an entity has no
 * explicit size, mirroring physics defaults: player [0.6, 1.8, 0.6],
 * zone [2, 2, 2], everything else [1, 1, 1].
 */
export const DEFAULT_KIND_SCALE: Record<string, Vec3> = {
  player: [...DEFAULT_PLAYER_SIZE] as Vec3,
  zone: [...DEFAULT_ZONE_SIZE] as Vec3,
};

export function kindDefaultScale(kind: Entity["kind"]): Vec3 {
  return DEFAULT_KIND_SCALE[kind] ?? [1, 1, 1];
}

/**
 * Map an engine entity (plus optional runtime overrides) to renderer transform
 * data. Returns fresh arrays so the renderer can never alias engine state.
 * Scale is the entity's absolute full extents, so meshes built from unit
 * geometry match the physics AABB exactly.
 */
export function entityTransform(
  entity: Entity,
  runtime?: EntityRuntimeTransform
): EntityTransform {
  const position = runtime?.position ?? entity.position;
  const rotation = runtime?.rotation ?? entity.rotation ?? [0, 0, 0];
  const scale = entity.size ?? entity.scale ?? kindDefaultScale(entity.kind);
  const active = runtime?.active ?? entity.active;

  return {
    position: [...position] as Vec3,
    rotation: [...rotation] as Vec3,
    scale: [...scale] as Vec3,
    visible: active !== false,
  };
}

export const KIND_COLORS: Record<string, string> = {
  player: "#4ade80",
  enemy: "#f87171",
  collectible: "#facc15",
  zone: "#60a5fa",
  interactable: "#a78bfa",
  prop: "#94a3b8",
  exitDoor: "#fbbf24",
  platform: "#64748b",
  beam: "#38bdf8",
  spawn: "#e879f9",
};

export function entityColor(entity: Entity): string {
  if (entity.color) return entity.color;
  return KIND_COLORS[entity.kind] ?? "#cccccc";
}
