import { DEFAULT_INTERACT_RANGE } from "@prompt-to-playable/engine";
import type { GameState } from "@prompt-to-playable/engine";
import type { GameMode } from "@prompt-to-playable/schema";

/** Control hint shown for inspect (and any other click-to-learn) scenes. */
export const INSPECT_HINT = "Click parts for info · drag to orbit";
/** Control hint shown while walking through a scene in first person. */
export const WALKTHROUGH_HINT = "WASD move · drag to look · E interact";
/** Control hint shown while driving a vehicle. */
export const DRIVE_HINT = "WASD drive";
/** Control hint shared by game and explore scenes (objectives live in the HUD). */
export const DEFAULT_HINT = "WASD move · Space jump · E interact";
/** Control hint for machine scenes driven from the sidebar controls. */
export const MACHINE_HINT = "Drag to orbit · use the controls to drive the machine";
/** Control hint for open world scenes with sidebar spawn/change controls. */
export const WORLD_HINT = "Explore freely — use the world controls";

/** Pure view model for the mode-specific HUD copy. */
export interface ModeHudViewModel {
  lines: string[];
  crosshair: boolean;
  speedKmh?: number;
  lap?: number;
  time?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Base copy for the contextual interact chip. */
export const INTERACT_PROMPT = "Press E to interact";

function isActive(state: GameState, id: string): boolean {
  const runtime = state.entityRuntime[id];
  if (runtime) return runtime.active;
  return state.entities.find((entity) => entity.id === id)?.active ?? false;
}

function positionOf(
  state: GameState,
  entity: GameState["entities"][number]
): readonly [number, number, number] {
  return state.entityRuntime[entity.id]?.position ?? entity.position;
}

function distance(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Contextual "press E" copy for the nearest in-range interactable, mirroring
 * the engine's interact selection exactly: active player, active entities whose
 * kind or runtime tags say `interactable`, 3D center distance within the
 * entity's `props.interactRange ?? DEFAULT_INTERACT_RANGE`, nearest wins with
 * entity-list order breaking ties. Returns `null` when nothing is selectable.
 */
export function interactPrompt(state: GameState): string | null {
  const player = state.entities.find(
    (entity) => entity.kind === "player" && isActive(state, entity.id)
  );
  if (!player) return null;

  const playerPos = positionOf(state, player);
  let target: GameState["entities"][number] | undefined;
  let targetDistance = Infinity;

  for (const entity of state.entities) {
    if (entity.id === player.id || !isActive(state, entity.id)) continue;

    const tags = state.entityRuntime[entity.id]?.tags ?? entity.tags;
    if (entity.kind !== "interactable" && !tags.includes("interactable")) {
      continue;
    }

    const range =
      typeof entity.props?.interactRange === "number"
        ? entity.props.interactRange
        : DEFAULT_INTERACT_RANGE;
    const d = distance(playerPos, positionOf(state, entity));
    if (d <= range && d < targetDistance) {
      target = entity;
      targetDistance = d;
    }
  }

  if (!target) return null;
  return target.name ? `${INTERACT_PROMPT} — ${target.name}` : INTERACT_PROMPT;
}

/**
 * Mode -> HUD copy. The mode-specific lines fully describe the controls for
 * that mode; `crosshair` tells the app whether to show the reticle and the
 * drive fields are resolved from the player runtime and scratch state. The
 * sidebar objectives / explore hint stay owned by `Hud`.
 */
export function hudForMode(mode: GameMode, state: GameState): ModeHudViewModel {
  switch (mode) {
    case "inspect":
      return { lines: [INSPECT_HINT], crosshair: false };
    case "walkthrough":
      return { lines: [WALKTHROUGH_HINT], crosshair: true };
    case "machine":
      return { lines: [MACHINE_HINT], crosshair: false };
    case "world":
      return { lines: [WORLD_HINT], crosshair: false };
    case "drive": {
      const player = state.entities.find((entity) => entity.kind === "player");
      const runtime = player ? state.entityRuntime[player.id] : undefined;
      const speed = finiteNumber(runtime?.speed) ?? 0;
      return {
        lines: [DRIVE_HINT],
        crosshair: false,
        speedKmh: Math.round(Math.abs(speed) * 3.6),
        lap: finiteNumber(state.scratch?.lap),
        time: state.time,
      };
    }
    default:
      return { lines: [DEFAULT_HINT], crosshair: false };
  }
}
