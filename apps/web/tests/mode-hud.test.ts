import { describe, expect, test } from "vitest";
import type { GameState } from "@prompt-to-playable/engine";
import {
  DEFAULT_HINT,
  DRIVE_HINT,
  hudForMode,
  INSPECT_HINT,
  INTERACT_PROMPT,
  interactPrompt,
  MACHINE_HINT,
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

  test("machine points at the sidebar controls instead of WASD", () => {
    const view = hudForMode("machine", driveState());
    expect(view.lines).toEqual([MACHINE_HINT]);
    expect(view.crosshair).toBe(false);
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

type TestEntity = Record<string, unknown>;
type TestRuntime = Record<string, Record<string, unknown>>;

function interactState(
  entities: TestEntity[],
  entityRuntime: TestRuntime = {}
): GameState {
  return {
    status: "running",
    time: 0,
    entities,
    entityRuntime,
    doc: { meta: { title: "Interact" } },
  } as unknown as GameState;
}

function player(position: unknown = [0, 0, 0]): TestEntity {
  return { id: "player", kind: "player", position, active: true };
}

function lever(id: string, position: unknown, extra: TestEntity = {}): TestEntity {
  return { id, kind: "interactable", position, active: true, ...extra };
}

describe("interactPrompt", () => {
  test("prompts for an interactable inside the default range", () => {
    const state = interactState([player(), lever("lever", [1, 0, 0])]);
    expect(interactPrompt(state)).toBe(INTERACT_PROMPT);
  });

  test("uses the full 3D center distance", () => {
    const near = interactState([player(), lever("lamp", [0, 2.4, 0])]);
    const far = interactState([player(), lever("lamp", [0, 2.6, 0])]);
    expect(interactPrompt(near)).toBe(INTERACT_PROMPT);
    expect(interactPrompt(far)).toBeNull();
  });

  test("returns null when every interactable is out of range", () => {
    const state = interactState([
      player(),
      lever("lever", [3, 0, 0]),
      lever("button", [0, 0, -2.6]),
    ]);
    expect(interactPrompt(state)).toBeNull();
  });

  test("skips inactive entities and inactive players", () => {
    const inactiveEntity = interactState([
      player(),
      lever("lever", [1, 0, 0], { active: false }),
    ]);
    expect(interactPrompt(inactiveEntity)).toBeNull();

    const inactiveRuntime = interactState(
      [player(), lever("lever", [1, 0, 0], { active: true })],
      { lever: { active: false } }
    );
    expect(interactPrompt(inactiveRuntime)).toBeNull();

    const inactivePlayer = interactState([player(), lever("lever", [1, 0, 0])]);
    inactivePlayer.entities[0].active = false;
    expect(interactPrompt(inactivePlayer)).toBeNull();
  });

  test("no player means no prompt", () => {
    expect(interactPrompt(interactState([lever("lever", [0, 0, 0])]))).toBeNull();
  });

  test("selects the nearest of several in-range interactables", () => {
    const state = interactState([
      player(),
      lever("far", [2, 0, 0], { name: "Far Lever" }),
      lever("near", [0.5, 0, 0], { name: "Near Lever" }),
    ]);
    expect(interactPrompt(state)).toBe(`${INTERACT_PROMPT} — Near Lever`);
  });

  test("ties resolve in entity-list order like the engine", () => {
    const state = interactState([
      player(),
      lever("first", [1, 0, 0], { name: "First" }),
      lever("second", [-1, 0, 0], { name: "Second" }),
    ]);
    expect(interactPrompt(state)).toBe(`${INTERACT_PROMPT} — First`);
  });

  test("matches kind interactable or the interactable tag", () => {
    const byKind = interactState([player(), lever("lever", [1, 0, 0])]);
    expect(interactPrompt(byKind)).toBe(INTERACT_PROMPT);

    const byTag = interactState([
      player(),
      { id: "crate", kind: "prop", position: [1, 0, 0], tags: ["interactable"], active: true },
    ]);
    expect(interactPrompt(byTag)).toBe(INTERACT_PROMPT);

    const unmarked = interactState([
      player(),
      { id: "crate", kind: "prop", position: [1, 0, 0], tags: [], active: true },
    ]);
    expect(interactPrompt(unmarked)).toBeNull();
  });

  test("runtime tags override the authored tags", () => {
    const stripped = interactState(
      [player(), { id: "crate", kind: "prop", position: [1, 0, 0], tags: ["interactable"], active: true }],
      { crate: { tags: [], active: true } }
    );
    expect(interactPrompt(stripped)).toBeNull();

    const tagged = interactState(
      [player(), { id: "crate", kind: "prop", position: [1, 0, 0], tags: [], active: true }],
      { crate: { tags: ["interactable"], active: true } }
    );
    expect(interactPrompt(tagged)).toBe(INTERACT_PROMPT);
  });

  test("props.interactRange overrides the default per entity", () => {
    const wide = interactState([
      player(),
      lever("gate", [4, 0, 0], { props: { interactRange: 5 } }),
    ]);
    expect(interactPrompt(wide)).toBe(INTERACT_PROMPT);

    const narrow = interactState([
      player(),
      lever("button", [1, 0, 0], { props: { interactRange: 0.5 } }),
    ]);
    expect(interactPrompt(narrow)).toBeNull();
  });

  test("runtime positions drive distance and the player eye", () => {
    const moved = interactState(
      [player(), lever("lever", [9, 9, 9])],
      {
        player: { position: [4, 0, 0], active: true },
        lever: { position: [4.5, 0, 0], active: true },
      }
    );
    expect(interactPrompt(moved)).toBe(INTERACT_PROMPT);
  });

  test("appends the entity name when one is present", () => {
    const state = interactState([
      player(),
      lever("door", [1, 0, 0], { name: "Front Door" }),
    ]);
    expect(interactPrompt(state)).toBe(`${INTERACT_PROMPT} — Front Door`);
  });
});
