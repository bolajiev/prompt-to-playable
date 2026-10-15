import { describe, expect, test } from "vitest";
import { isGame, validateGame } from "../src/validators.js";
import { GameSchema, SCHEMA_VERSION } from "../src/schema.js";

function machineDoc(controls: unknown[] = []): Record<string, unknown> {
  return {
    version: SCHEMA_VERSION,
    meta: { title: "Robotic Arm", archetype: "explore", mode: "machine" },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [9, 1, 9] },
      { id: "base", kind: "prop", position: [0, 1, 0], rotation: [0, 0, 0] },
    ],
    objectives: [],
    rules: [],
    controls,
    scratch: {},
  };
}

function armControls(): unknown[] {
  return [
    {
      id: "joint-base",
      type: "slider",
      label: "Base joint",
      min: -1.57,
      max: 1.57,
      step: 0.05,
      value: 0,
      bind: {
        entity: "base",
        property: "rotation.y",
        scale: 1.2,
        offset: 0,
      },
    },
    {
      id: "grip",
      type: "toggle",
      label: "Grip closed",
      value: 0,
      bind: { entity: "base", property: "visible" },
    },
    {
      id: "power",
      type: "slider",
      label: "Power",
      bind: { var: "machine_power", entity: "base", property: "emissive" },
    },
    {
      id: "home",
      type: "button",
      label: "HOME",
      bind: {
        onPress: [
          { type: "setVar", key: "homed", value: true },
          { type: "animate", entity: "base", kind: "spin", speed: 1 },
        ],
      },
    },
  ];
}

describe("ControlSchema", () => {
  test("doc with slider/toggle/button controls parses and keeps binds", () => {
    const res = validateGame(machineDoc(armControls()));
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.data?.meta.mode).toBe("machine");
    expect(res.data?.controls).toHaveLength(4);

    const [slider, toggle, power, button] = res.data?.controls ?? [];
    expect(slider?.type).toBe("slider");
    expect(slider?.min).toBe(-1.57);
    expect(slider?.max).toBe(1.57);
    expect(slider?.step).toBe(0.05);
    expect(slider?.bind?.entity).toBe("base");
    expect(slider?.bind?.property).toBe("rotation.y");
    expect(slider?.bind?.scale).toBe(1.2);
    expect(toggle?.bind?.property).toBe("visible");
    expect(power?.bind?.var).toBe("machine_power");
    expect(power?.bind?.property).toBe("emissive");
    expect(button?.bind?.onPress?.map((a) => a.type)).toEqual([
      "setVar",
      "animate",
    ]);
  });

  test("every bind property enum value parses", () => {
    const properties = [
      "rotation.x",
      "rotation.y",
      "rotation.z",
      "position.x",
      "position.y",
      "position.z",
      "visible",
      "color",
      "emissive",
    ];
    for (const property of properties) {
      const res = validateGame(
        machineDoc([
          { id: "c", type: "slider", label: "C", bind: { entity: "base", property } },
        ])
      );
      expect(res.ok, property).toBe(true);
    }
  });

  test("controls default to [] and mode stays optional (backward compat)", () => {
    const doc = machineDoc();
    delete doc.controls;
    delete (doc.meta as Record<string, unknown>).mode;
    const res = validateGame(doc);
    expect(res.ok).toBe(true);
    expect(res.data?.controls).toEqual([]);
    expect(res.data?.meta.mode).toBeUndefined();
  });

  test("controlPressed is a valid rule trigger event", () => {
    const doc = machineDoc(armControls());
    doc.rules = [
      {
        id: "press",
        on: { event: "controlPressed", entity: "home" },
        then: [{ type: "setVar", key: "pressed", value: true }],
      },
    ];
    const res = validateGame(doc);
    expect(res.ok).toBe(true);
    expect(res.data?.rules[0]?.on.event).toBe("controlPressed");
  });

  test("unknown control type fails", () => {
    expect(
      isGame(
        machineDoc([{ id: "c", type: "dial", label: "Dial", bind: undefined }])
      )
    ).toBe(false);
  });

  test("missing id or empty label fails", () => {
    expect(isGame(machineDoc([{ type: "slider", label: "Joint" }]))).toBe(false);
    expect(isGame(machineDoc([{ id: "c", type: "slider", label: "" }]))).toBe(
      false
    );
  });

  test("bad bind property fails", () => {
    expect(
      isGame(
        machineDoc([
          { id: "c", type: "slider", label: "C", bind: { entity: "base", property: "rotation.w" } },
        ])
      )
    ).toBe(false);
  });

  test("bad onPress action fails", () => {
    expect(
      isGame(
        machineDoc([
          {
            id: "c",
            type: "button",
            label: "Go",
            bind: { onPress: [{ type: "launchNuke" }] },
          },
        ])
      )
    ).toBe(false);
  });

  test("non-positive step and non-numeric bounds fail", () => {
    expect(
      isGame(machineDoc([{ id: "c", type: "slider", label: "C", step: 0 }]))
    ).toBe(false);
    expect(
      isGame(machineDoc([{ id: "c", type: "slider", label: "C", min: "low" }]))
    ).toBe(false);
  });

  test("bare SafeParse accepts a machine doc with controls", () => {
    expect(GameSchema.safeParse(machineDoc(armControls())).success).toBe(true);
  });
});
