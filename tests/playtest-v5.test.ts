import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { FIXED_DT_MS, createEngine } from "@prompt-to-playable/engine";
import type { Engine } from "@prompt-to-playable/engine";
import type { Action, Entity, GameDoc, Vec3 } from "@prompt-to-playable/schema";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export const TICK_BUDGET = 8000;
export const DOOR_STOP_DISTANCE = 0.4;
export const STUCK_TICKS = 30;
export const REVERSE_TICKS = 60;

function loadFixture(file: string): GameDoc {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as GameDoc;
}

function xzDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= 2 * Math.PI;
  while (value < -Math.PI) value += 2 * Math.PI;
  return value;
}

function actionsOf(doc: GameDoc, event: string, entityId: string): Action[] {
  return doc.rules
    .filter((rule) => rule.on.event === event && rule.on.entity === entityId)
    .flatMap((rule) => rule.then);
}

function clickableLabeledEntities(doc: GameDoc): Entity[] {
  return doc.entities.filter(
    (entity) =>
      entity.label !== undefined &&
      doc.rules.some(
        (rule) => rule.on.event === "click" && rule.on.entity === entity.id
      )
  );
}

function pickDoor(doc: GameDoc): Entity | undefined {
  const interactables = doc.entities.filter(
    (entity) => entity.kind === "interactable" || entity.tags.includes("interactable")
  );
  return (
    interactables.find((entity) => entity.props?.door === true) ??
    interactables.find((entity) =>
      actionsOf(doc, "interact", entity.id).some(
        (action) =>
          action.type === "openDoor" ||
          (action.type === "animate" && action.kind === "slide")
      )
    ) ??
    interactables[0]
  );
}

function approach(
  engine: Engine,
  playerId: string,
  target: Vec3,
  maxTicks: number
): boolean {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const state = engine.getState();
    if (state.status !== "running") return false;
    const position = state.entityRuntime[playerId]?.position;
    if (!position) return false;
    if (xzDistance(position, target) <= DOOR_STOP_DISTANCE) return true;
    const dx = target[0] - position[0];
    const dz = target[2] - position[2];
    const length = Math.hypot(dx, dz) || 1;
    engine.step(FIXED_DT_MS, { moveX: dx / length, moveZ: dz / length });
  }
  return false;
}

describe("live kit fixtures are playable offline", () => {
  test("inspect: clicking a labeled part opens a panel and applies its setColor", () => {
    const doc = loadFixture("kit-pcb.json");
    expect(doc.meta.archetype).toBe("explore");
    expect(doc.meta.mode).toBe("inspect");

    const engine = createEngine();
    engine.load(doc);
    const candidates = clickableLabeledEntities(doc);
    expect(candidates.length).toBeGreaterThan(0);

    let clicked: Entity | undefined;
    let panelState: ReturnType<Engine["getState"]> | undefined;
    for (const entity of candidates) {
      engine.pushEvent({ type: "click", targetId: entity.id });
      const state = engine.step(FIXED_DT_MS);
      if (state.ui.panels.length > 0) {
        clicked = entity;
        panelState = state;
        break;
      }
    }

    expect(panelState).toBeDefined();
    expect(clicked).toBeDefined();
    expect(panelState?.ui.panels[0]?.title.length).toBeGreaterThan(0);
    expect(panelState?.ui.panels[0]?.body.length).toBeGreaterThan(0);
    if (clicked && panelState) {
      const colorAction = actionsOf(doc, "click", clicked.id).find(
        (action) => action.type === "setColor"
      );
      if (colorAction?.type === "setColor") {
        expect(panelState.entityRuntime[clicked.id]?.color).toBe(colorAction.color);
      }
    }
  });

  test("walkthrough: steering to the door and pressing interact opens it", () => {
    const doc = loadFixture("kit-house.json");
    expect(doc.meta.archetype).toBe("explore");
    expect(doc.meta.mode).toBe("walkthrough");

    const engine = createEngine();
    engine.load(doc);
    const player = doc.entities.find((entity) => entity.kind === "player");
    const door = pickDoor(doc);
    expect(player).toBeDefined();
    expect(door).toBeDefined();
    if (!player || !door) return;

    const before = [...engine.getState().entityRuntime[door.id].position] as Vec3;
    const reached = approach(engine, player.id, door.position, TICK_BUDGET);
    expect(reached).toBe(true);

    engine.step(FIXED_DT_MS, { interact: false });
    engine.step(FIXED_DT_MS, { interact: true });
    let state = engine.step(FIXED_DT_MS, { interact: false });
    for (let tick = 0; tick < 120; tick += 1) {
      state = engine.step(FIXED_DT_MS);
    }

    const after = state.entityRuntime[door.id];
    expect(after).toBeDefined();
    const moved = after ? xzDistance(after.position, before) : 0;
    const opened = after?.tags.includes("open") ?? false;
    const doorActions = actionsOf(doc, "interact", door.id);
    expect(
      doorActions.some(
        (action) =>
          action.type === "openDoor" ||
          (action.type === "animate" && action.kind === "slide")
      )
    ).toBe(true);
    expect(
      moved > 0.5 || opened,
      "pressing interact should slide the door or apply the open tag"
    ).toBe(true);
  });

  test(`drive: throttle and checkpoint pursuit wins within ${TICK_BUDGET} ticks`, () => {
    const doc = loadFixture("kit-race.json");
    expect(doc.meta.archetype).toBe("collect-a-thon");
    expect(doc.meta.mode).toBe("drive");

    const engine = createEngine();
    engine.load(doc);
    const player = doc.entities.find((entity) => entity.kind === "player");
    expect(player?.props?.vehicle).toBe(true);
    if (!player) return;

    const checkpoints = doc.entities
      .filter(
        (entity) =>
          entity.kind === "zone" && typeof entity.props?.checkpointIndex === "number"
      )
      .sort(
        (a, b) =>
          (a.props?.checkpointIndex as number) - (b.props?.checkpointIndex as number)
      );
    expect(checkpoints.length).toBeGreaterThanOrEqual(3);

    const objective = doc.objectives.find(
      (item) =>
        item.type === "collect" &&
        (item.targets ?? []).some((target) =>
          checkpoints.some((checkpoint) => checkpoint.id === target)
        )
    );
    expect(objective).toBeDefined();
    if (!objective) return;

    let state = engine.getState();
    let stuck = 0;
    let reversing = 0;
    for (let tick = 0; tick < TICK_BUDGET && state.status === "running"; tick += 1) {
      const progress =
        state.objectives.find((item) => item.id === objective.id)?.progress ?? 0;
      const target = checkpoints[Math.min(progress, checkpoints.length - 1)];
      const runtime = state.entityRuntime[player.id];
      if (!runtime) break;

      let throttle = 1;
      if (stuck > STUCK_TICKS) {
        reversing = REVERSE_TICKS;
        stuck = 0;
      }
      if (reversing > 0) {
        throttle = -0.6;
        reversing -= 1;
      }

      const travelHeading = throttle < 0 ? (runtime.heading ?? 0) + Math.PI : runtime.heading ?? 0;
      const desired = Math.atan2(
        target.position[0] - runtime.position[0],
        target.position[2] - runtime.position[2]
      );
      const steer = clamp(normalizeAngle(desired - travelHeading) * 2, -1, 1);
      if (Math.abs(runtime.speed ?? 0) < 0.25) stuck += 1;
      else stuck = 0;

      state = engine.step(FIXED_DT_MS, { moveX: steer, moveZ: throttle });
    }

    expect(state.status).toBe("won");
    expect(state.ticks).toBeLessThanOrEqual(TICK_BUDGET);
    expect(state.objectives.find((item) => item.id === objective.id)?.status).toBe(
      "done"
    );
  });
});
