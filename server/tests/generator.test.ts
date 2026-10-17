import { describe, expect, test, vi } from "vitest";
import { validateGame } from "@prompt-to-playable/schema";
import type { GameDoc, Vec3 } from "@prompt-to-playable/schema";
import {
  ARCHETYPE_EXAMPLES,
  CHARACTER_COMPOSITION_BLOCK,
  KIT_ARCHETYPES,
  KIT_SCHEMA_ARCHETYPE,
  buildGenerationPrompt,
  generate,
} from "../src/generator.js";
import type { KitArchetype } from "../src/generator.js";
import { hasWinPath, requiresWinPath, sanityCheck } from "../src/sanity.js";
import { createCorpusLlm, evaluatePrompts } from "../../scripts/eval-corpus.js";
import type { CorpusEntry } from "../../scripts/eval-corpus.js";

type LlmCall = (prompt: string) => Promise<string>;

const KIT_LABELS: readonly KitArchetype[] = [
  "inspect",
  "walkthrough",
  "drive",
  "machine",
];

function integerCheckpoints(doc: GameDoc): number[] {
  return doc.entities
    .filter(
      (entity) => entity.kind === "zone" && typeof entity.props?.checkpointIndex === "number"
    )
    .map((entity) => entity.props?.checkpointIndex as number)
    .sort((a, b) => a - b);
}

interface PlanBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function planBounds(entity: { position: number[]; size?: number[] }): PlanBounds {
  if (!entity.size) throw new Error("entity has no size to bound");
  return {
    minX: entity.position[0] - entity.size[0] / 2,
    maxX: entity.position[0] + entity.size[0] / 2,
    minZ: entity.position[2] - entity.size[2] / 2,
    maxZ: entity.position[2] + entity.size[2] / 2,
  };
}

function planOverlap(a: PlanBounds, b: PlanBounds): { x: number; z: number } {
  return {
    x: Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX),
    z: Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ),
  };
}

describe("kit few-shot examples", () => {
  test("every classification label has a schema-valid, sane example", () => {
    expect(Object.keys(ARCHETYPE_EXAMPLES).sort()).toEqual([...KIT_ARCHETYPES].sort());
    for (const label of KIT_ARCHETYPES) {
      const example = ARCHETYPE_EXAMPLES[label];
      expect(validateGame(example).ok, label).toBe(true);
      expect(sanityCheck(example).ok, label).toBe(true);
      expect(example.meta.archetype, label).toBe(KIT_SCHEMA_ARCHETYPE[label]);
      if (KIT_LABELS.includes(label)) {
        expect(example.meta.mode, label).toBe(label);
      }
    }
  });

  test("inspect example is a heypcb-grade PCB assembly", () => {
    const doc = ARCHETYPE_EXAMPLES.inspect;
    expect(doc.meta.mode).toBe("inspect");
    expect(doc.objectives).toEqual([]);
    expect(requiresWinPath(doc)).toBe(false);
    expect(doc.entities.length).toBeLessThanOrEqual(14);
    expect(doc.rules.length).toBeLessThanOrEqual(8);

    const board = doc.entities.find((entity) => entity.id === "board");
    expect(board, "board").toBeDefined();
    expect(
      board?.size,
      "board plate stays unsized so flat silkscreen labels keep their aspect"
    ).toBeUndefined();
    expect(board?.color).toBe("#1b4d2e");
    const plate = board?.parts?.[0];
    expect(plate?.material?.texture).toBe("circuit");
    const plateSize = plate?.size ?? [0, 0, 0];
    expect(plateSize[0] / plateSize[2]).toBeGreaterThan(1.5);
    expect(plateSize[0] / plateSize[2]).toBeLessThan(2.5);
    expect(plateSize[1]).toBeLessThanOrEqual(0.5);

    const labels = doc.entities.filter((entity) => entity.label !== undefined);
    expect(labels.length).toBeGreaterThanOrEqual(6);
    for (const entity of labels) {
      expect(entity.label?.flat, `${entity.id} label is flat silkscreen`).toBe(true);
    }
    expect(board?.label?.text.length ?? 0).toBeGreaterThan(0);

    const chips = doc.entities.filter((entity) => entity.props?.shape === "chip");
    expect(chips.length).toBeGreaterThanOrEqual(3);
    for (const chip of chips) {
      expect(chip.size, chip.id).toBeDefined();
      expect(chip.label?.text, chip.id).toBeDefined();
    }
    const designators = chips.map((chip) => chip.label?.text ?? "");
    expect(new Set(designators).size).toBe(designators.length);

    expect(
      doc.entities.filter((entity) => entity.props?.shape === "header").length
    ).toBeGreaterThanOrEqual(1);
    expect(
      doc.entities.filter((entity) => entity.props?.shape === "capacitor").length
    ).toBeGreaterThanOrEqual(2);
    const leds = doc.entities.filter((entity) => entity.props?.shape === "led");
    expect(leds.length).toBeGreaterThanOrEqual(3);
    for (const led of leds) {
      expect(led.color, led.id).toBeDefined();
    }
    const mountRings = doc.entities
      .flatMap((entity) => entity.parts ?? [])
      .filter((part) => part.shape === "torus");
    expect(mountRings.length).toBeGreaterThanOrEqual(4);

    const clickRules = doc.rules.filter((rule) => rule.on.event === "click");
    expect(clickRules.length).toBeGreaterThanOrEqual(2);
    const actionTypes = clickRules.flatMap((rule) =>
      rule.then.map((action) => action.type)
    );
    expect(actionTypes).toContain("showPanel");
    expect(actionTypes).toContain("setColor");
    expect(actionTypes).toContain("cameraFocus");
    expect(actionTypes).toContain("hidePanel");

    const panelRules = clickRules.filter((rule) =>
      rule.then.some((action) => action.type === "showPanel")
    );
    const panelBodies: string[] = [];
    for (const rule of panelRules) {
      expect(
        rule.then.some((action) => action.type === "setColor"),
        `${rule.id} should emphasize the clicked part`
      ).toBe(true);
      for (const action of rule.then) {
        if (action.type !== "showPanel") continue;
        panelBodies.push(action.body);
        expect(action.title.length, `${rule.id} panel title`).toBeGreaterThan(0);
      }
    }
    expect(panelBodies.some((body) => /pin/i.test(body))).toBe(true);

    // Every clickable part frames itself, so the first click on ANY component
    // (u1..u3, the header, the LED) moves the camera to that part. A
    // rule-level `focused` guard would swallow the panel on later clicks.
    expect(panelRules.length).toBeGreaterThanOrEqual(5);
    for (const rule of panelRules) {
      expect(rule.if, `${rule.id} must not gate its panel behind a guard`).toBeUndefined();
      const focus = rule.then.find((action) => action.type === "cameraFocus");
      expect(focus, `${rule.id} frames the clicked part`).toBeDefined();
      if (focus?.type === "cameraFocus") {
        expect(focus.entity, `${rule.id} focus target`).toBe(rule.on.entity);
      }
      const flagged = rule.then.find(
        (action) =>
          action.type === "setVar" &&
          action.key === "focused" &&
          action.value === 1
      );
      expect(flagged, `${rule.id} records the focused scratch flag`).toBeDefined();
    }

    const animated = doc.rules
      .flatMap((rule) => rule.then)
      .find((action) => action.type === "animate");
    expect(animated?.type === "animate" && animated.kind).toBe("pulse");

    const resetRule = clickRules.find((rule) =>
      rule.then.some((action) => action.type === "hidePanel")
    );
    expect(resetRule, "reset pad clears the panels").toBeDefined();
    expect(
      resetRule?.then.some(
        (action) =>
          action.type === "setVar" && action.key === "focused" && action.value === 0
      ),
      "reset pad clears the focused scratch flag"
    ).toBe(true);
  });

  test("walkthrough example has solid wall props, a sliding door and a toggling lamp", () => {
    const doc = ARCHETYPE_EXAMPLES.walkthrough;
    expect(doc.meta.mode).toBe("walkthrough");
    expect(doc.objectives).toEqual([]);
    expect(requiresWinPath(doc)).toBe(false);
    expect(doc.entities.length).toBeLessThanOrEqual(16);
    expect(doc.rules.length).toBeLessThanOrEqual(10);

    const walls = doc.entities.filter(
      (entity) => entity.kind === "prop" && entity.solid === true
    );
    expect(walls.length).toBeGreaterThanOrEqual(4);
    for (const wall of walls) {
      expect(wall.size, wall.id).toBeDefined();
      expect(wall.parts?.[0]?.offset, wall.id).toEqual([0, 0, 0]);
    }
    const frontWalls = walls.filter((wall) => wall.position[2] > 0);
    expect(frontWalls.length).toBeGreaterThanOrEqual(2);

    const wallById = new Map(walls.map((wall) => [wall.id, wall]));
    const back = wallById.get("wall-back");
    const left = wallById.get("wall-left");
    const right = wallById.get("wall-right");
    expect(back, "wall-back").toBeDefined();
    expect(left, "wall-left").toBeDefined();
    expect(right, "wall-right").toBeDefined();
    // Walls extend one thickness past the room corners instead of ending flush
    // with each other, so every corner seam is a real overlap, not a zero-width
    // gap the player could squeeze through.
    expect(back?.size?.[0]).toBeCloseTo(12.6);
    expect(back?.position[0]).toBe(0);
    expect(left?.size?.[2]).toBeCloseTo(10.6);
    expect(right?.size?.[2]).toBeCloseTo(10.6);
    expect(wallById.get("wall-front-left")?.size?.[0]).toBeCloseTo(5.3);
    expect(wallById.get("wall-front-right")?.size?.[0]).toBeCloseTo(5.3);

    const wallThickness = 0.3;
    const cornerPairs: ReadonlyArray<readonly [string, string]> = [
      ["wall-back", "wall-left"],
      ["wall-back", "wall-right"],
      ["wall-front-left", "wall-left"],
      ["wall-front-right", "wall-right"],
    ];
    for (const [firstId, secondId] of cornerPairs) {
      const first = wallById.get(firstId);
      const second = wallById.get(secondId);
      expect(first, firstId).toBeDefined();
      expect(second, secondId).toBeDefined();
      if (!first || !second) continue;
      const shared = planOverlap(planBounds(first), planBounds(second));
      expect(shared.x, `${firstId}/${secondId} x overlap`).toBeGreaterThanOrEqual(
        wallThickness - 1e-9
      );
      expect(shared.z, `${firstId}/${secondId} z overlap`).toBeGreaterThanOrEqual(
        wallThickness - 1e-9
      );
    }

    const door = doc.entities.find((entity) => entity.id === "front-door");
    expect(door?.kind).toBe("interactable");
    expect(door?.props?.door).toBe(true);
    expect(door?.solid).toBe(true);
    expect(door?.size).toBeDefined();
    if (door?.size && frontWalls.length >= 2) {
      const ordered = [...frontWalls].sort(
        (a, b) => a.position[0] - b.position[0]
      );
      const leftEdge = ordered[0].position[0] + ordered[0].size![0] / 2;
      const rightEdge = ordered[1].position[0] - ordered[1].size![0] / 2;
      const gap = rightEdge - leftEdge;
      expect(gap).toBeGreaterThan(0);
      expect(door.size[0]).toBeLessThanOrEqual(gap + 1e-6);
      expect(door.size[0]).toBeGreaterThan(gap / 2);
    }

    const doorRules = doc.rules.filter(
      (rule) => rule.on.event === "interact" && rule.on.entity === "front-door"
    );
    expect(doorRules.length).toBeGreaterThanOrEqual(2);
    const branch = (right: number) =>
      doorRules.find((rule) => {
        if (!rule.if || rule.if.op !== "==") return false;
        const left = rule.if.left;
        return (
          typeof left === "object" &&
          left !== null &&
          "var" in left &&
          left.var === "doorOpen" &&
          rule.if.right === right
        );
      });
    const openRule = branch(0);
    const closeRule = branch(1);
    expect(openRule, "open branch gated on doorOpen == 0").toBeDefined();
    expect(closeRule, "close branch gated on doorOpen == 1").toBeDefined();
    const slide = openRule?.then.find((action) => action.type === "animate");
    expect(slide?.type === "animate" && slide.kind).toBe("slide");
    expect(slide?.type === "animate" && Array.isArray(slide.to)).toBe(true);
    expect(openRule?.then.some((action) => action.type === "openDoor")).toBe(true);
    expect(
      closeRule?.then.some((action) => action.type === "setVar" && action.key === "doorOpen" && action.value === 0)
    ).toBe(true);

    const lamp = doc.entities.find((entity) => entity.id === "floor-lamp");
    expect(lamp?.kind).toBe("interactable");
    expect(lamp?.solid).not.toBe(true);
    const lampRules = doc.rules.filter((rule) => rule.on.entity === "floor-lamp");
    const lampActions = lampRules.flatMap((rule) => rule.then.map((action) => action.type));
    expect(lampActions).toContain("setVisible");
    expect(lampActions).toContain("setColor");
    const glow = doc.entities.find((entity) => entity.id === "lamp-glow");
    expect(glow?.parts?.length).toBeGreaterThanOrEqual(1);
  });

  test("machine example is an interactive five-axis arm driven by controls", () => {
    const doc = ARCHETYPE_EXAMPLES.machine;
    expect(doc.meta.mode).toBe("machine");
    expect(doc.meta.archetype).toBe("explore");
    expect(doc.objectives).toEqual([]);
    expect(requiresWinPath(doc)).toBe(false);
    expect(doc.entities.length).toBeLessThanOrEqual(14);
    expect(doc.rules.length).toBeLessThanOrEqual(8);
    expect(doc.controls?.length ?? 0).toBeLessThanOrEqual(8);

    // Five labeled segments, every one a real part assembly with a flat label.
    const labels = new Map(
      doc.entities
        .filter((entity) => entity.label !== undefined)
        .map((entity) => [entity.label?.text, entity])
    );
    for (const name of ["BASE", "SHOULDER", "ELBOW", "WRIST", "GRIP"]) {
      const entity = labels.get(name);
      expect(entity, `${name} segment`).toBeDefined();
      expect(entity?.label?.flat, `${name} label is flat silkscreen`).toBe(true);
      expect(entity?.parts?.length, `${name} parts`).toBeGreaterThanOrEqual(1);
    }

    // Four joint sliders, each driving the rotation of an existing segment.
    const sliderBinds = (doc.controls ?? [])
      .filter((control) => control.type === "slider")
      .map((control) => ({ control, entity: control.bind?.entity, property: control.bind?.property }));
    expect(sliderBinds).toHaveLength(4);
    const entityIds = new Set(doc.entities.map((entity) => entity.id));
    for (const { control, entity, property } of sliderBinds) {
      expect(entity, `${control.id} binds an entity`).toBeDefined();
      expect(entityIds.has(String(entity)), `${control.id} target exists`).toBe(true);
      expect(property, `${control.id} drives a rotation`).toMatch(/^rotation\.[xyz]$/);
      const scale = Math.abs(control.bind?.scale ?? 1);
      expect(scale, `${control.id} scale ~1.2`).toBeGreaterThanOrEqual(0.8);
      expect(scale, `${control.id} scale ~1.2`).toBeLessThanOrEqual(1.7);
      expect(control.min, `${control.id} min`).toBeDefined();
      expect(control.max, `${control.id} max`).toBeDefined();
      expect(control.min as number).toBeLessThan(control.max as number);
    }
    const sliderTargets = new Set(sliderBinds.map((entry) => entry.entity));
    for (const joint of ["arm-base", "arm-shoulder", "arm-elbow", "arm-wrist"]) {
      expect(sliderTargets.has(joint), `${joint} has a joint slider`).toBe(true);
    }

    // The grip toggle opens the moving jaw and mirrors its value into scratch.
    const grip = doc.controls?.find((control) => control.type === "toggle");
    expect(grip, "grip toggle").toBeDefined();
    expect(grip?.bind?.entity).toBe("arm-grip");
    expect(grip?.bind?.property).toBe("rotation.z");
    expect(grip?.bind?.var).toBe("grip");
    expect(Math.abs(grip?.bind?.scale ?? 0)).toBeGreaterThan(0);

    // HOME and WAVE run onPress actions: a grip animation and scratch flags.
    const buttons = (doc.controls ?? []).filter(
      (control) => control.type === "button"
    );
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    const buttonActions = buttons.flatMap(
      (control) => control.bind?.onPress ?? []
    );
    expect(
      buttonActions.some(
        (action) => action.type === "animate" && action.entity === "arm-grip"
      ),
      "a button animates the gripper"
    ).toBe(true);
    expect(
      buttonActions.some(
        (action) => action.type === "setVar" && action.key === "homed"
      ),
      "HOME records the homed flag"
    ).toBe(true);
    expect(
      buttonActions.some(
        (action) => action.type === "setVar" && action.key === "waved"
      ),
      "WAVE records the waved flag"
    ).toBe(true);

    // Three labeled parts open "what it does" panels and frame themselves.
    const panelRules = doc.rules.filter((rule) =>
      rule.then.some((action) => action.type === "showPanel")
    );
    expect(panelRules).toHaveLength(3);
    for (const rule of panelRules) {
      expect(rule.on.event).toBe("click");
      const target = doc.entities.find((entity) => entity.id === rule.on.entity);
      expect(target?.label, `${rule.id} clicks a labeled part`).toBeDefined();
      const first = rule.then[0];
      expect(first?.type, `${rule.id} frames the part first`).toBe("cameraFocus");
      const panel = rule.then.find((action) => action.type === "showPanel");
      expect(panel?.type === "showPanel" && panel.title.length).toBeTruthy();
      expect(panel?.type === "showPanel" && panel.body.length).toBeTruthy();
    }

    // Forward kinematics: base -> shoulder -> elbow -> wrist -> grip, each
    // joint parented onto the segment below it and mounted at the link tip.
    const byId = new Map(doc.entities.map((entity) => [entity.id, entity]));
    const chain: ReadonlyArray<readonly [string, string, Vec3]> = [
      ["arm-shoulder", "arm-base", [0, 1.22, 0]],
      ["arm-elbow", "arm-shoulder", [0, 2.5, 0]],
      ["arm-wrist", "arm-elbow", [2.6, 0, 0]],
      ["arm-grip", "arm-wrist", [1.2, -0.12, 0]],
    ];
    for (const [id, parent, attach] of chain) {
      const entity = byId.get(id);
      expect(entity, `${id} exists`).toBeDefined();
      expect(entity?.parent, `${id} is parented`).toBe(parent);
      expect(entity?.attach, `${id} attach`).toEqual(attach);
      // A parented entity's authored position is its LOCAL pose.
      expect(entity?.position, `${id} local position`).toEqual([0, 0, 0]);
    }
    expect(byId.get("arm-base")?.parent).toBeUndefined();

    // Rest-pose world offsets resolved by walking the chain (no rotations at
    // rest): shoulder on the turret, elbow at the upper-link tip, wrist at the
    // forearm tip, gripper at the tool plate.
    const worldOf = (id: string): Vec3 => {
      const entity = byId.get(id);
      expect(entity, `${id} exists`).toBeDefined();
      const local = entity?.position ?? [0, 0, 0];
      const attach = entity?.attach ?? [0, 0, 0];
      if (!entity?.parent) {
        return [local[0], local[1], local[2]];
      }
      const parent = worldOf(entity.parent);
      return [
        parent[0] + local[0] + attach[0],
        parent[1] + local[1] + attach[1],
        parent[2] + local[2] + attach[2],
      ];
    };
    const shoulderWorld = worldOf("arm-shoulder");
    const elbowWorld = worldOf("arm-elbow");
    const wristWorld = worldOf("arm-wrist");
    const gripWorld = worldOf("arm-grip");
    expect(shoulderWorld[1]).toBeCloseTo(1.82, 6);
    expect(elbowWorld[1]).toBeCloseTo(4.32, 6);
    expect(wristWorld[0]).toBeCloseTo(2.6, 6);
    expect(wristWorld[1]).toBeCloseTo(4.32, 6);
    expect(gripWorld[0]).toBeCloseTo(3.8, 6);
    expect(gripWorld[1]).toBeCloseTo(4.2, 6);

    // Each joint carries the link geometry that reaches the next joint.
    const shoulderLink = byId.get("arm-shoulder")?.parts?.[1];
    expect(shoulderLink?.shape).toBe("capsule");
    expect(
      (shoulderLink?.offset?.[1] ?? 0) + (shoulderLink?.size?.[1] ?? 0) / 2
    ).toBeCloseTo(2.5, 1);
    const forearm = byId.get("arm-elbow")?.parts?.[1];
    expect(forearm?.shape).toBe("capsule");
    expect(
      (forearm?.offset?.[0] ?? 0) + (forearm?.size?.[1] ?? 0) / 2
    ).toBeCloseTo(2.6, 1);

    // Every segment still extends away from its own origin with real parts.
    for (const id of ["arm-base", "arm-shoulder", "arm-elbow", "arm-wrist", "arm-grip"]) {
      const entity = byId.get(id);
      expect(entity, id).toBeDefined();
      const reach = (entity?.parts ?? []).reduce(
        (max, part) => Math.max(max, Math.hypot(...(part.offset ?? [0, 0, 0]))),
        0
      );
      expect(reach, `${id} geometry extends from its pivot`).toBeGreaterThan(0.3);
    }
  });

  test("machine example stands up at a readable world scale", () => {
    const doc = ARCHETYPE_EXAMPLES.machine;
    const segments = doc.entities.filter((entity) =>
      entity.id.startsWith("arm-")
    );
    expect(segments).toHaveLength(5);

    const byId = new Map(doc.entities.map((entity) => [entity.id, entity]));
    const worldOf = (id: string): Vec3 => {
      const entity = byId.get(id);
      const local = entity?.position ?? [0, 0, 0];
      const attach = entity?.attach ?? [0, 0, 0];
      if (!entity?.parent) return [local[0], local[1], local[2]];
      const parent = worldOf(entity.parent);
      return [
        parent[0] + local[0] + attach[0],
        parent[1] + local[1] + attach[1],
        parent[2] + local[2] + attach[2],
      ];
    };

    // Union AABB of every segment part in the rest pose. Segments are unsized,
    // so part offsets and sizes are world units; parts rotated a quarter turn
    // swap their extents on the rotated axes.
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const quarterTurn = (angle: number): boolean =>
      Math.abs(Math.abs(angle) - Math.PI / 2) < 0.01;
    for (const entity of segments) {
      expect(
        entity.size,
        `${entity.id} parts are authored in world units`
      ).toBeUndefined();
      const origin = worldOf(entity.id);
      for (const part of entity.parts ?? []) {
        const offset = part.offset ?? [0, 0, 0];
        const raw = part.size ?? [1, 1, 1];
        const rotation = part.rotation ?? [0, 0, 0];
        const size: Vec3 = quarterTurn(rotation[2])
          ? [raw[1], raw[0], raw[2]]
          : quarterTurn(rotation[0]) || quarterTurn(rotation[1])
            ? [raw[2], raw[1], raw[0]]
            : [raw[0], raw[1], raw[2]];
        for (let axis = 0; axis < 3; axis += 1) {
          const center = origin[axis] + offset[axis];
          min[axis] = Math.min(min[axis], center - size[axis] / 2);
          max[axis] = Math.max(max[axis], center + size[axis] / 2);
        }
      }
    }
    const spanX = max[0] - min[0];
    const spanY = max[1] - min[1];
    const spanZ = max[2] - min[2];
    const diagonal = Math.hypot(spanX, spanY, spanZ);
    expect(
      Math.max(spanX, spanY, spanZ),
      "the arm spans a readable fraction of the frame"
    ).toBeGreaterThanOrEqual(5.5);
    expect(diagonal).toBeGreaterThanOrEqual(6.5);
    expect(diagonal).toBeLessThanOrEqual(8.5);
    expect(min[1], "the rig stands on the ground plane").toBeGreaterThanOrEqual(0);

    // Base turret about 1.2 units in radius.
    const base = doc.entities.find((entity) => entity.id === "arm-base");
    const baseCylinder = base?.parts?.[0];
    expect(baseCylinder?.shape).toBe("cylinder");
    expect((baseCylinder?.size?.[0] ?? 0) / 2).toBeCloseTo(1.2, 1);

    // The shoulder pivot is raised and the upper link stands up to the elbow.
    const shoulderWorld = worldOf("arm-shoulder");
    const elbowWorld = worldOf("arm-elbow");
    const wristWorld = worldOf("arm-wrist");
    expect(shoulderWorld[1]).toBeGreaterThanOrEqual(1.5);
    expect(elbowWorld[1]).toBeGreaterThan(shoulderWorld[1]);
    const upperLink = elbowWorld[1] - shoulderWorld[1];
    expect(upperLink).toBeGreaterThanOrEqual(2.5);
    expect(upperLink).toBeLessThanOrEqual(3);
    const forearmReach = wristWorld[0] - elbowWorld[0];
    expect(forearmReach).toBeGreaterThanOrEqual(2.5);
    expect(forearmReach).toBeLessThanOrEqual(3.2);
  });

  test("world example is an open sandbox with spawning controls and composed characters", () => {
    const doc = ARCHETYPE_EXAMPLES.world;
    expect(doc.meta.mode).toBe("world");
    expect(doc.meta.archetype).toBe("explore");
    expect(doc.objectives).toEqual([]);
    expect(requiresWinPath(doc)).toBe(false);
    expect(hasWinPath(doc)).toBe(false);
    expect(doc.world.bounds[0]).toBeGreaterThanOrEqual(40);
    expect(doc.world.bounds[2]).toBeGreaterThanOrEqual(40);
    expect(doc.entities.length).toBeLessThanOrEqual(24);
    expect(doc.rules.length).toBeLessThanOrEqual(12);

    const byId = new Map(doc.entities.map((entity) => [entity.id, entity]));

    // 3-6 NPCs: peaceful idle/patrol enemies plus composed characters.
    const enemies = doc.entities.filter((entity) => entity.kind === "enemy");
    expect(enemies.length).toBeGreaterThanOrEqual(1);
    for (const enemy of enemies) {
      expect(["idle", "patrol"]).toContain(enemy.state);
      expect(enemy.sight, `${enemy.id} stays peaceful`).toBeUndefined();
    }

    // Two composed characters: a root prop with parented head/arms/legs.
    const roots = ["robot-torso", "deer-body"];
    for (const rootId of roots) {
      const root = byId.get(rootId);
      expect(root, rootId).toBeDefined();
      expect(root?.parent, `${rootId} is a root`).toBeUndefined();
      expect(root?.parts?.length ?? 0, `${rootId} parts`).toBeGreaterThanOrEqual(2);
      expect(root?.label?.flat, `${rootId} carries a flat name label`).toBe(true);
      const limbs = doc.entities.filter((entity) => entity.parent === rootId);
      expect(limbs.length, `${rootId} limbs`).toBeGreaterThanOrEqual(3);
      for (const limb of limbs) {
        expect(limb.parts?.length ?? 0, limb.id).toBeGreaterThanOrEqual(1);
        expect(limb.position, `${limb.id} local pose`).toEqual([0, 0, 0]);
      }
    }

    // The humanoid carries TWO arms and TWO legs as parented entities; the
    // animal carries four parented legs plus a parented head.
    for (const limbId of [
      "robot-arm-l",
      "robot-arm-r",
      "robot-leg-l",
      "robot-leg-r",
      "deer-head",
      "deer-leg-fl",
      "deer-leg-fr",
      "deer-leg-bl",
      "deer-leg-br",
    ]) {
      const limb = byId.get(limbId);
      expect(limb, limbId).toBeDefined();
      expect(limb?.parent, `${limbId} parent`).toBe(
        limbId.startsWith("deer") ? "deer-body" : "robot-torso"
      );
    }

    // Characters stand on the ground (feet at y = 0) at player scale.
    const footClearance = (rootId: string, legId: string): number => {
      const root = byId.get(rootId);
      const leg = byId.get(legId);
      const part = leg?.parts?.[0];
      return (
        (root?.position[1] ?? 0) +
        (leg?.attach?.[1] ?? 0) +
        (part?.offset?.[1] ?? 0) -
        (part?.size?.[1] ?? 0) / 2
      );
    };
    expect(footClearance("robot-torso", "robot-leg-l")).toBeCloseTo(0, 5);
    expect(footClearance("deer-body", "deer-leg-fl")).toBeCloseTo(0, 5);
    const robotTop =
      (byId.get("robot-torso")?.position[1] ?? 0) +
      (byId.get("robot-head")?.attach?.[1] ?? 0) +
      0.23;
    const deerTop =
      (byId.get("deer-body")?.position[1] ?? 0) +
      (byId.get("deer-head")?.attach?.[1] ?? 0) +
      0.31;
    for (const [label, top] of [
      ["robot", robotTop],
      ["deer", deerTop],
    ] as const) {
      expect(top, `${label} height`).toBeGreaterThanOrEqual(1.8);
      expect(top, `${label} height`).toBeLessThanOrEqual(2.6);
    }

    // Idle bob starts on the character roots from one guarded tick rule.
    const bobTargets = doc.rules
      .flatMap((rule) => rule.then)
      .filter((action) => action.type === "animate" && action.kind === "bob")
      .map((action) => (action.type === "animate" ? action.entity : ""));
    for (const rootId of roots) expect(bobTargets).toContain(rootId);
    const bobRule = doc.rules.find((rule) => rule.id === "characters-awake");
    expect(bobRule?.on.event).toBe("tick");
    expect(bobRule?.if).toBeDefined();

    // 4-6 controls with at least two spawn buttons that add NEW entities.
    const controls = doc.controls ?? [];
    expect(controls.length).toBeGreaterThanOrEqual(4);
    expect(controls.length).toBeLessThanOrEqual(6);
    const existing = new Set(doc.entities.map((entity) => entity.id));
    const spawnButtons = controls.filter(
      (control) =>
        control.type === "button" &&
        (control.bind?.onPress ?? []).some(
          (action) => action.type === "spawn" && !existing.has(action.entity.id)
        )
    );
    expect(spawnButtons.length).toBeGreaterThanOrEqual(2);
    expect(controls.some((control) => control.type === "toggle")).toBe(true);
    const slider = controls.find((control) => control.type === "slider");
    expect(slider?.bind?.entity).toBe("windmill-rotor");
    expect(slider?.bind?.property).toBe("rotation.y");

    // 2-3 labeled click props open info panels.
    const panelRules = doc.rules.filter(
      (rule) =>
        rule.on.event === "click" &&
        rule.then.some((action) => action.type === "showPanel")
    );
    expect(panelRules.length).toBeGreaterThanOrEqual(2);
    expect(panelRules.length).toBeLessThanOrEqual(3);
    for (const rule of panelRules) {
      const target = doc.entities.find((entity) => entity.id === rule.on.entity);
      expect(target?.label, `${rule.id} clicks a labeled prop`).toBeDefined();
    }
  });

  test("drive example is a winnable, ordered checkpoint race", () => {
    const doc = ARCHETYPE_EXAMPLES.drive;
    expect(doc.meta.mode).toBe("drive");
    expect(requiresWinPath(doc)).toBe(true);
    expect(hasWinPath(doc)).toBe(true);

    const player = doc.entities.find((entity) => entity.kind === "player");
    expect(player?.props?.vehicle).toBe(true);
    expect(typeof player?.props?.maxSpeed).toBe("number");

    const indexes = integerCheckpoints(doc);
    expect(indexes.length).toBeGreaterThanOrEqual(3);
    expect(indexes).toEqual(indexes.map((_value, position) => position));

    const collect = doc.objectives.find((objective) => objective.type === "collect");
    expect(collect?.count).toBe(indexes.length);
    expect(doc.objectives.some((objective) => objective.type === "timeLimit")).toBe(true);
    expect(doc.scratch.lap).toBe(0);

    const winRule = doc.rules.find((rule) =>
      rule.then.some((action) => action.type === "win")
    );
    expect(winRule?.on.event).toBe("objectiveComplete");
    const gated = doc.rules.filter((rule) => {
      if (rule.on.event !== "playerEnter") return false;
      if (!rule.if || rule.if.op !== "==") return false;
      const left = rule.if.left;
      return typeof left === "object" && left !== null && "var" in left && left.var === "cp";
    });
    expect(gated.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildGenerationPrompt kit catalogs", () => {
  test("inspect prompt teaches parts, labels, panels and no win path", () => {
    const text = buildGenerationPrompt("a 3D PCB I can inspect", "inspect");
    expect(text).toContain('"mode": "inspect"');
    expect(text).toContain('"parts"');
    expect(text).toContain('"label"');
    expect(text).toContain("showPanel");
    expect(text).toContain("setColor");
    expect(text).toContain("cameraFocus");
    expect(text).toContain("hidePanel");
    expect(text).toContain('"click"');
    expect(text).toContain('"texture": "circuit"');
    expect(text).toContain('"chip"');
    expect(text).toContain('"header"');
    expect(text).toContain('"capacitor"');
    expect(text).toContain('"led"');
    expect(text).toContain('"hole"');
    expect(text).toContain('"flat": true');
    expect(text).toContain("silkscreen");
    expect(text).toContain("rows and columns");
    expect(text.replace(/\s+/g, " ")).toContain(
      "gaps of at least one component size"
    );
    expect(text).toContain("first click on ANY part");
    expect(text).toContain("camera auto-fits");
    expect(text).toContain("Seat components on the mask");
    expect(text).toContain("Budget: at most 14 entities and 8 rules");
    expect(text).not.toContain("The game must be winnable through its rules alone.");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.inspect, null, 2));
  });

  test("walkthrough prompt teaches solid walls, slide doors and variation", () => {
    const text = buildGenerationPrompt("a house I can walk through", "walkthrough");
    expect(text).toContain('"mode": "walkthrough"');
    expect(text).toContain('"solid": true');
    expect(text).toContain("per entity AABB, never per part");
    expect(text).toContain("door-width gap");
    expect(text).toContain("MUST OVERLAP at every corner");
    expect(text).toContain("zero-width corner seam");
    expect(text).toContain('"props": { "door": true }');
    expect(text).toContain('"kind":"slide"');
    expect(text).toContain("openDoor");
    expect(text).toContain("doorOpen");
    expect(text).toContain("lampOn");
    expect(text).toContain("setVisible");
    expect(text).toContain("Budget: at most 16 entities and 10 rules");
    expect(text).toContain("do not copy the few-shot document verbatim");
    expect(text).not.toContain("The game must be winnable through its rules alone.");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.walkthrough, null, 2));
  });

  test("every archetype prompt carries its loosened entity and rule budget", () => {
    const budgets: ReadonlyArray<readonly [KitArchetype, string]> = [
      ["inspect", "Budget: at most 14 entities and 8 rules"],
      ["walkthrough", "Budget: at most 16 entities and 10 rules"],
      ["drive", "Budget: at most 14 entities and 10 rules"],
      ["machine", "Budget: at most 14 entities, 8 rules and 8 controls"],
      ["world", "Budget: at most 24 entities, 12 rules and 6 controls"],
      ["explore", "Budget: at most 14 entities and 6 rules"],
      ["collect-a-thon", "Budget: at most 14 entities and 8 rules"],
      ["puzzle-switch", "Budget: at most 14 entities and 8 rules"],
      ["platformer-lite", "Budget: at most 14 entities and 8 rules"],
      ["stealth-chase", "Budget: at most 14 entities and 8 rules"],
    ];
    for (const [archetype, budget] of budgets) {
      expect(buildGenerationPrompt("make something", archetype), archetype).toContain(
        budget
      );
    }
  });

  test("every prompt asks for readable JSON instead of terse output", () => {
    for (const archetype of KIT_ARCHETYPES) {
      const text = buildGenerationPrompt("make something", archetype);
      expect(text, archetype).toContain("Prefer readable, well-formed JSON");
      expect(text, archetype).not.toContain("Prefer terse JSON");
    }
  });

  test("drive prompt teaches vehicle props, ordered checkpoints and winnability", () => {
    const text = buildGenerationPrompt("a car racing game", "drive");
    expect(text).toContain('"mode": "drive"');
    expect(text).toContain('"props": { "vehicle": true');
    expect(text).toContain("checkpointIndex");
    expect(text).toContain("timeLimit");
    expect(text).toContain("The race must be winnable through its rules.");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.drive, null, 2));
    expect(text).not.toContain("MUST be an empty array: []");
  });

  test("machine prompt teaches joint pivots, binds, labels and panels", () => {
    const text = buildGenerationPrompt(
      "a robotic arm with joint sliders I can control",
      "machine"
    );
    expect(text).toContain('"mode": "machine"');
    expect(text).toContain('"controls"');
    expect(text).toContain("rotation.z");
    expect(text).toContain('"scale"');
    expect(text).toContain("onPress");
    expect(text).toContain('"toggle"');
    expect(text).toContain('"button"');
    expect(text).toContain("showPanel");
    expect(text).toContain("cameraFocus");
    expect(text).toContain('"flat": true');
    expect(text).toContain("controlPressed");
    expect(text).toContain("rotates about its entity origin");
    expect(text).toContain("FORWARD KINEMATICS");
    expect(text).toContain('"parent"');
    expect(text).toContain('"attach"');
    expect(text).toContain("Budget: at most 14 entities, 8 rules and 8 controls");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.machine, null, 2));
    expect(text).toContain("MUST be an empty array: []");
    expect(text).not.toContain("The game must be winnable through its rules alone.");
    expect(text).not.toContain("The race must be winnable through its rules.");
  });

  test("world prompt teaches large bounds, character composition and spawn buttons", () => {
    const text = buildGenerationPrompt(
      "an open world island with trees, animals and buttons to spawn things",
      "world"
    );
    expect(text).toContain('"mode": "world"');
    expect(text).toContain('"controls"');
    expect(text).toContain("LARGE bounds");
    expect(text).toContain("composed character");
    expect(text).toContain("parent chain");
    expect(text).toContain("spawn");
    expect(text).toContain("controlPressed");
    expect(text).toContain("MUST be an empty array: []");
    expect(text).toContain("Budget: at most 24 entities, 12 rules and 6 controls");
    expect(text).toContain(JSON.stringify(ARCHETYPE_EXAMPLES.world, null, 2));
    expect(text).not.toContain("The game must be winnable through its rules alone.");
    expect(text).not.toContain("The race must be winnable through its rules.");
  });

  test("world prompt carries the shared character composition block", () => {
    const text = buildGenerationPrompt("a sandbox island", "world");
    expect(text).toContain(CHARACTER_COMPOSITION_BLOCK.join("\n"));
    expect(text).toContain("TWO arms and TWO legs");
    expect(text).toContain("Robot variant");
    expect(text).toContain("Animal variant");
    expect(text).toContain("antenna");
    expect(text).toContain("FOUR parented legs");
    expect(text).toContain("idle bob");
    expect(text).toContain('"state": "patrol"');
    expect(text).toContain("root y = leg attach + leg length");
    expect(text).toContain("1.8-2.5 units tall");
    expect(text).toContain("flat label");

    // Other kits stay free of the world-only character block.
    const machine = buildGenerationPrompt("a robotic arm", "machine");
    expect(machine).not.toContain("TWO arms and TWO legs");
  });

  test("game and explore prompts keep their existing requirements", () => {
    const collect = buildGenerationPrompt("collect gems", "collect-a-thon");
    expect(collect).toContain("The game must be winnable through its rules alone.");
    expect(collect).not.toContain("MUST be an empty array: []");

    const explore = buildGenerationPrompt("a quiet clearing", "explore");
    expect(explore).toContain("MUST be an empty array: []");
    expect(explore).not.toContain("The game must be winnable through its rules alone.");
    expect(explore).toContain("MUST NOT include");
  });
});

describe("generate over kit labels", () => {
  test("sends the kit prompt and parses a fenced kit document", async () => {
    const doc = ARCHETYPE_EXAMPLES.inspect;
    const llm = vi.fn<LlmCall>(
      async () => `Here:\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\``
    );
    const result = await generate("a 3D PCB I can inspect", "inspect", llm);
    expect(result).toEqual(doc);
    const sent = llm.mock.calls[0]?.[0] ?? "";
    expect(sent).toContain('"mode": "inspect"');
    expect(sent).toContain("a 3D PCB I can inspect");
  });
});

describe("eval-corpus mock kit coverage", () => {
  const entries: readonly CorpusEntry[] = [
    {
      id: "mock-inspect",
      prompt: "a 3D PCB I can click and inspect",
      archetype: "inspect",
      title: "Mock PCB",
    },
    {
      id: "mock-walkthrough",
      prompt: "a house I can walk through",
      archetype: "walkthrough",
      title: "Mock House",
    },
    {
      id: "mock-drive",
      prompt: "a car racing game",
      archetype: "drive",
      title: "Mock Race",
    },
    {
      id: "mock-machine",
      prompt: "a robotic arm with joint sliders I can control",
      archetype: "machine",
      title: "Mock Arm",
    },
    {
      id: "mock-world",
      prompt: "an open world island with trees, animals and buttons",
      archetype: "world",
      title: "Mock Island",
    },
  ];

  test("builds kit documents that pass the full evaluation harness", async () => {
    const outcomes = await evaluatePrompts(entries, { llm: createCorpusLlm(entries) });
    expect(outcomes.map((outcome) => outcome.archetype)).toEqual([
      "inspect",
      "walkthrough",
      "drive",
      "machine",
      "world",
    ]);
    for (const outcome of outcomes) {
      expect(outcome.valid, outcome.id).toBe(true);
      expect(outcome.solvable, outcome.id).toBe(true);
      expect(outcome.error, outcome.id).toBeUndefined();
    }
  });
});
