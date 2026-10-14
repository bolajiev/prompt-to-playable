import { describe, expect, test } from "vitest";
import type { GameState } from "@prompt-to-playable/engine";
import {
  DEFAULT_HINT,
  DRIVE_HINT,
  hudForMode,
  INSPECT_HINT,
  WALKTHROUGH_HINT,
} from "../src/ui/mode-hud.js";

interface DriveOverrides {
  speed?: unknown;
  lap?: unknown;
  time?: number;
  withPlayer?: boolean;
}

function driveState(overrides: DriveOverrides = {}): GameState {
  const withPlayer = overrides.withPlayer ?? true;
  const entities = withPlayer
    ? [{ id: "car", kind: "player", position: [0, 0, 0] }]
    : [{ id: "crate", kind: "prop", position: [0, 0, 0] }];
  return {
    status: "running",
    time: overrides.time ?? 12.34,
    entities,
    entityRuntime: withPlayer
      ? { car: { speed: overrides.speed, position: [0, 0, 0] } }
      : {},
    scratch: overrides.lap === undefined ? {} : { lap: overrides.lap },
    doc: { meta: { title: "Race", archetype: "collect-a-thon" } },
  } as unknown as GameState;
}

describe("hudForMode", () => {
  test("inspect teaches clicking and orbiting without a crosshair", () => {
    const view = hudForMode("inspect", driveState());
    expect(view.lines).toEqual([INSPECT_HINT]);
    expect(view.crosshair).toBe(false);
    expect(view.speedKmh).toBeUndefined();
    expect(view.lap).toBeUndefined();
    expect(view.time).toBeUndefined();
  });

  test("walkthrough shows the crosshair and first-person controls", () => {
    const view = hudForMode("walkthrough", driveState());
    expect(view.lines).toEqual([WALKTHROUGH_HINT]);
    expect(view.crosshair).toBe(true);
  });

  test("drive reports speed in km/h, lap and time", () => {
    const view = hudForMode(
      "drive",
      driveState({ speed: 5, lap: 2, time: 12.34 })
    );
    expect(view.lines).toEqual([DRIVE_HINT]);
    expect(view.crosshair).toBe(false);
    expect(view.speedKmh).toBe(18);
    expect(view.lap).toBe(2);
    expect(view.time).toBe(12.34);
  });

  test("drive rounds speed and treats reverse as positive", () => {
    expect(hudForMode("drive", driveState({ speed: -4.17 })).speedKmh).toBe(15);
    expect(hudForMode("drive", driveState({ speed: 4.17 })).speedKmh).toBe(15);
  });

  test("drive degrades safely without a player, speed or lap", () => {
    const view = hudForMode("drive", driveState({ withPlayer: false }));
    expect(view.speedKmh).toBe(0);
    expect(view.lap).toBeUndefined();
    expect(view.time).toBe(12.34);
  });

  test("drive ignores non-numeric scratch laps and speeds", () => {
    const view = hudForMode(
      "drive",
      driveState({ speed: "fast", lap: "two" })
    );
    expect(view.speedKmh).toBe(0);
    expect(view.lap).toBeUndefined();
  });

  test("game and explore keep the shared control hint", () => {
    for (const mode of ["game", "explore"] as const) {
      const view = hudForMode(mode, driveState());
      expect(view.lines).toEqual([DEFAULT_HINT]);
      expect(view.crosshair).toBe(false);
    }
  });
});
