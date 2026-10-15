import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { FIXED_DT_MS, createEngine } from "@prompt-to-playable/engine";
import type { Engine } from "@prompt-to-playable/engine";
import type {
  Action,
  Control,
  Entity,
  GameDoc,
  Vec3,
} from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import { sanityCheck } from "../server/src/sanity.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export const TICK_BUDGET = 6000;
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

type Axis = 0 | 1 | 2;

function rotationAxisOf(property: string): Axis {
  if (property === "rotation.x") return 0;
  if (property === "rotation.z") return 2;
  return 1;
}

/** Live value of whatever a control drives: scratch var, or entity property. */
function boundControlValue(
  state: ReturnType<Engine["getState"]>,
  control: Control
): unknown {
  const bind = control.bind;
  if (!bind) return undefined;
  if (bind.var !== undefined) {
    const value = state.scratch[bind.var];
    if (value !== undefined) return value;
  }
  if (bind.entity === undefined || bind.property === undefined) return undefined;
  const runtime = state.entityRuntime[bind.entity];
  if (!runtime) return undefined;
  if (bind.property === "visible") return runtime.visible;
  if (bind.property === "color") return runtime.color;
  if (bind.property === "emissive") return runtime.emissive;
  const axis = rotationAxisOf(bind.property);
  return bind.property.startsWith("rotation.")
    ? runtime.rotation?.[axis]
    : runtime.position[axis];
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
      expect(
        colorAction?.type,
        `click rule for ${clicked.id} should include a setColor action`
      ).toBe("setColor");
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

    const solidProps = doc.entities.filter(
      (entity) => entity.kind === "prop" && entity.solid === true
    );
    expect(
      solidProps.length,
      "walkthrough houses must ship solid wall props so the player cannot walk through them"
    ).toBeGreaterThanOrEqual(4);

    const playerStart: Vec3 = [
      ...engine.getState().entityRuntime[player.id].position,
    ] as Vec3;
    const before = [...engine.getState().entityRuntime[door.id].position] as Vec3;

    const moveBudget = Math.floor(TICK_BUDGET / 2);
    const inward = Math.sign(playerStart[2] - door.position[2]) || -1;
    const awayTarget: Vec3 = [
      door.position[0],
      playerStart[1],
      door.position[2] + inward * 8,
    ];
    const walkedAway = approach(engine, player.id, awayTarget, moveBudget);
    expect(walkedAway).toBe(true);
    const awayPosition: Vec3 = [
      ...engine.getState().entityRuntime[player.id].position,
    ] as Vec3;
    expect(xzDistance(awayPosition, playerStart)).toBeGreaterThan(1.0);
    expect(xzDistance(awayPosition, door.position)).toBeGreaterThanOrEqual(2.5);

    const doorDepth = door.size?.[2] ?? 0.3;
    const returnTarget: Vec3 = [
      door.position[0],
      playerStart[1],
      door.position[2] + inward * (doorDepth / 2 + 0.55),
    ];
    const returned = approach(engine, player.id, returnTarget, moveBudget);
    expect(returned).toBe(true);
    const backPosition: Vec3 = [
      ...engine.getState().entityRuntime[player.id].position,
    ] as Vec3;
    const doorRange =
      typeof door.props?.interactRange === "number"
        ? door.props.interactRange
        : 2.5;
    expect(xzDistance(backPosition, door.position)).toBeLessThanOrEqual(
      doorRange
    );

    const pressInteract = (): void => {
      engine.step(FIXED_DT_MS, { interact: false });
      engine.step(FIXED_DT_MS, { interact: true });
      engine.step(FIXED_DT_MS, { interact: false });
      for (let tick = 0; tick < 120; tick += 1) {
        engine.step(FIXED_DT_MS);
      }
    };

    const doorActions = actionsOf(doc, "interact", door.id);
    expect(
      doorActions.some(
        (action) =>
          action.type === "openDoor" ||
          (action.type === "animate" && action.kind === "slide")
      )
    ).toBe(true);

    pressInteract();
    let state = engine.getState();
    const afterOpen = state.entityRuntime[door.id];
    expect(afterOpen).toBeDefined();
    const openTravel = afterOpen ? xzDistance(afterOpen.position, before) : 0;
    expect(
      openTravel,
      "first interact should slide the door toward its open position"
    ).toBeGreaterThan(0.5);
    expect(state.scratch.doorOpen).toBe(1);

    pressInteract();
    state = engine.getState();
    const afterClose = state.entityRuntime[door.id];
    expect(afterClose).toBeDefined();
    const closeTravel = afterClose ? xzDistance(afterClose.position, before) : 0;
    expect(
      closeTravel,
      "second interact should slide the door back toward closed"
    ).toBeLessThan(openTravel / 2);
    expect(state.scratch.doorOpen).toBe(0);

    const backWall = [...solidProps].sort(
      (a, b) => a.position[2] - b.position[2]
    )[0];
    expect(backWall?.size).toBeDefined();
    if (backWall?.size) {
      const throughWall: Vec3 = [
        backWall.position[0],
        playerStart[1],
        backWall.position[2] - 3,
      ];
      const reachedThrough = approach(engine, player.id, throughWall, 300);
      expect(
        reachedThrough,
        "the player must not walk through the solid back wall"
      ).toBe(false);
      const stopped = engine.getState().entityRuntime[player.id].position;
      const innerFace = backWall.position[2] + backWall.size[2] / 2;
      expect(
        stopped[2],
        "the solid wall must stop the player on the room side"
      ).toBeGreaterThan(innerFace);
    }

    state = engine.getState();
    expect(state.ticks).toBeLessThanOrEqual(TICK_BUDGET);
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

  test("machine: sliders sweep joints, the grip toggle flips, WAVE animates and parts open panels", () => {
    const doc = loadFixture("kit-machine.json");
    expect(doc.meta.archetype).toBe("explore");
    expect(doc.meta.mode).toBe("machine");
    expect(validateGame(doc).ok).toBe(true);
    expect(sanityCheck(doc).ok).toBe(true);
    expect(doc.objectives).toEqual([]);

    const controls = doc.controls ?? [];
    expect(controls.length).toBeGreaterThanOrEqual(4);
    expect(controls.length).toBeLessThanOrEqual(8);

    const engine = createEngine();
    engine.load(doc);

    // 1. Sweep a joint slider min -> max: the bound rotation changes
    // monotonically and stays finite.
    const sliders = controls.filter(
      (control) =>
        control.type === "slider" &&
        control.bind?.entity !== undefined &&
        (control.bind.property ?? "").startsWith("rotation.")
    );
    expect(sliders.length).toBeGreaterThan(0);
    const slider =
      sliders.find(
        (control) => control.min !== undefined && control.max !== undefined
      ) ?? sliders[0];
    const sliderEntity = String(slider.bind?.entity);
    const axis = rotationAxisOf(String(slider.bind?.property));
    const scale = slider.bind?.scale ?? 1;
    const min = slider.min ?? -1;
    const max = slider.max ?? 1;
    expect(min).toBeLessThan(max);

    const samples: number[] = [];
    let previous = Number.NaN;
    for (let step = 0; step <= 6; step += 1) {
      const value = min + ((max - min) * step) / 6;
      engine.setControl(slider.id, value);
      const state = engine.step(FIXED_DT_MS);
      const runtime = state.entityRuntime[sliderEntity];
      expect(runtime, `${slider.id} target ${sliderEntity}`).toBeDefined();
      const rotation = runtime?.rotation?.[axis];
      expect(Number.isFinite(rotation)).toBe(true);
      samples.push(rotation as number);
      if (Number.isFinite(previous)) {
        const delta = ((rotation as number) - previous) * Math.sign(scale || 1);
        expect(
          delta,
          `${slider.id} rotation moves monotonically as the slider sweeps`
        ).toBeGreaterThanOrEqual(-1e-9);
      }
      previous = rotation as number;
    }
    expect(
      Math.abs(samples[samples.length - 1] - samples[0]),
      `${slider.id} sweep changes the joint angle`
    ).toBeGreaterThan(0.2);

    // 2. Flip the grip toggle: its bound property flips, and flips back.
    const toggle = controls.find((control) => control.type === "toggle");
    expect(toggle, "machine needs a grip toggle").toBeDefined();
    if (toggle) {
      const closed = boundControlValue(engine.getState(), toggle);
      engine.setControl(toggle.id, 1);
      const opened = boundControlValue(engine.step(FIXED_DT_MS), toggle);
      expect(opened, `${toggle.id} opens something`).not.toEqual(closed);
      engine.setControl(toggle.id, 0);
      const reclosed = boundControlValue(engine.step(FIXED_DT_MS), toggle);
      expect(reclosed).toEqual(closed);
    }

    // 3. Press WAVE: the button's animate action lands on its target entity.
    const wave = controls.find(
      (control) =>
        control.type === "button" &&
        (control.bind?.onPress ?? []).some((action) => action.type === "animate")
    );
    expect(wave, "machine needs a button that animates").toBeDefined();
    if (wave) {
      const animation = (wave.bind?.onPress ?? []).find(
        (action) => action.type === "animate"
      );
      engine.pressControl(wave.id);
      const state = engine.step(FIXED_DT_MS);
      expect(
        state.events.some(
          (event) => event.type === "controlPressed" && event.controlId === wave.id
        )
      ).toBe(true);
      if (animation?.type === "animate") {
        expect(
          state.entityRuntime[animation.entity]?.animations.some(
            (entry) => entry.kind === animation.kind
          ),
          `${wave.id} starts a ${animation.kind} animation on ${animation.entity}`
        ).toBe(true);
      }
    }

    // 4. Click a labeled part with a click rule: a panel appears.
    const candidates = clickableLabeledEntities(doc);
    expect(candidates.length).toBeGreaterThan(0);
    const panelRule = doc.rules.find(
      (rule) =>
        rule.on.event === "click" &&
        rule.then.some((action) => action.type === "showPanel") &&
        doc.entities.some(
          (entity) => entity.id === rule.on.entity && entity.label !== undefined
        )
    );
    expect(panelRule, "machine needs a labeled part with a panel rule").toBeDefined();
    if (panelRule?.on.entity) {
      engine.pushEvent({ type: "click", targetId: panelRule.on.entity });
      const state = engine.step(FIXED_DT_MS);
      const panel = state.ui.panels.find(
        (item) => item.entity === panelRule.on.entity
      );
      expect(panel, `clicking ${panelRule.on.entity} opens its panel`).toBeDefined();
      expect(panel?.title.length ?? 0).toBeGreaterThan(0);
      expect(panel?.body.length ?? 0).toBeGreaterThan(0);
    }
  });
});
