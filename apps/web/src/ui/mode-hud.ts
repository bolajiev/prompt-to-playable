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
