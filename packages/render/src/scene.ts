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
 * Map an engine entity (plus optional runtime overrides) to renderer transform
 * data. Returns fresh arrays so the renderer can never alias engine state.
 */
export function entityTransform(
  entity: Entity,
  runtime?: EntityRuntimeTransform
): EntityTransform {
  const position = runtime?.position ?? entity.position;
  const rotation = runtime?.rotation ?? entity.rotation ?? [0, 0, 0];
  const scale = entity.scale ?? entity.size ?? [1, 1, 1];
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
