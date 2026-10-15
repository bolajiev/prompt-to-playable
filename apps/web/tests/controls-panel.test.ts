import { describe, expect, test, vi } from "vitest";
import type { Control } from "@prompt-to-playable/schema";
import {
  ControlsPanel,
  controlsToViewModel,
  DEFAULT_SLIDER_MAX,
  DEFAULT_SLIDER_MIN,
  DEFAULT_SLIDER_STEP,
  formatControlValue,
} from "../src/ui/controls-panel.js";
import { FakeNode } from "./fakes.js";

const CONTROLS: Control[] = [
  {
    id: "swing",
    type: "slider",
    label: "Swing",
    min: -1.5,
    max: 1.5,
    step: 0.1,
    value: 0.25,
    bind: { entity: "link", property: "rotation.z" },
  },
  {
    id: "grip",
    type: "toggle",
    label: "Grip",
    value: 1,
    bind: { entity: "link", property: "visible" },
  },
  {
    id: "home",
    type: "button",
    label: "HOME",
    bind: { onPress: [{ type: "setVar", key: "homed", value: true }] },
  },
];

describe("controlsToViewModel", () => {
  test("maps id, type and label in order with live values", () => {
    const view = controlsToViewModel(CONTROLS, { swing: 0.8, grip: 0, home: 0 });
    expect(view).toEqual([
      {
        id: "swing",
        type: "slider",
        label: "Swing",
        min: -1.5,
        max: 1.5,
        step: 0.1,
        value: 0.8,
      },
      {
        id: "grip",
        type: "toggle",
        label: "Grip",
        min: DEFAULT_SLIDER_MIN,
        max: DEFAULT_SLIDER_MAX,
        step: DEFAULT_SLIDER_STEP,
        value: 0,
      },
      {
        id: "home",
        type: "button",
        label: "HOME",
        min: DEFAULT_SLIDER_MIN,
        max: DEFAULT_SLIDER_MAX,
        step: DEFAULT_SLIDER_STEP,
        value: 0,
      },
    ]);
  });

  test("falls back to authored value, then 0, when no live value exists", () => {
    const view = controlsToViewModel(CONTROLS, {});
    expect(view.map((control) => control.value)).toEqual([0.25, 1, 0]);
  });

  test("slider bounds default to 0..1 step 0.01", () => {
    const bare = controlsToViewModel(
      [{ id: "c", type: "slider", label: "C" }],
      {}
    );
    expect(bare[0]?.min).toBe(DEFAULT_SLIDER_MIN);
    expect(bare[0]?.max).toBe(DEFAULT_SLIDER_MAX);
    expect(bare[0]?.step).toBe(DEFAULT_SLIDER_STEP);
  });

  test("empty controls map to an empty list", () => {
    expect(controlsToViewModel([], {})).toEqual([]);
  });
});

describe("formatControlValue", () => {
  const slider = (value: number, step?: number) =>
    controlsToViewModel(
      [{ id: "c", type: "slider", label: "C", step }],
      { c: value }
    )[0]!;

  test("sliders show decimals derived from the step", () => {
    expect(formatControlValue(slider(0.256, 0.01))).toBe("0.26");
    expect(formatControlValue(slider(90, 1))).toBe("90");
    expect(formatControlValue(slider(0.4, 0.1))).toBe("0.4");
  });

  test("toggles show On/Off at the 0.5 threshold and buttons show nothing", () => {
    const [toggle, button] = controlsToViewModel(
      [
        { id: "t", type: "toggle", label: "T" },
        { id: "b", type: "button", label: "B" },
      ],
      { t: 0.5, b: 0 }
    );
    expect(formatControlValue(toggle!)).toBe("Off");
    expect(formatControlValue({ ...toggle!, value: 0.51 })).toBe("On");
    expect(formatControlValue(button!)).toBe("");
  });
});

function createHarness() {
  const root = new FakeNode();
  const onInput = vi.fn();
  const onPress = vi.fn();
  const panel = new ControlsPanel(root as unknown as HTMLElement, {
    onInput,
    onPress,
  });
  return { panel, root, onInput, onPress };
}

describe("ControlsPanel", () => {
  test("starts hidden and stays hidden with no controls", () => {
    const { panel, root } = createHarness();
    expect(root.hidden).toBe(true);
    panel.update([], {});
    expect(root.hidden).toBe(true);
    expect(root.children).toHaveLength(0);
  });

  test("renders a row per control with id/type metadata", () => {
    const { panel, root } = createHarness();
    panel.update(CONTROLS, { swing: 0.5, grip: 1, home: 0 });

    expect(root.hidden).toBe(false);
    expect(root.children).toHaveLength(3);
    expect(root.children.map((child) => child.dataset.controlId)).toEqual([
      "swing",
      "grip",
      "home",
    ]);
    expect(root.children.map((child) => child.dataset.controlType)).toEqual([
      "slider",
      "toggle",
      "button",
    ]);

    const slider = root.children[0]!;
    expect(slider.find("control-label")?.textContent).toBe("Swing");
    expect(slider.find("control-value")?.textContent).toBe("0.5");
    const input = slider.children.find((child) => child.className === "control-input")!;
    expect(input.type).toBe("range");
    expect(input.min).toBe("-1.5");
    expect(input.max).toBe("1.5");
    expect(input.step).toBe("0.1");
    expect(input.value).toBe("0.5");

    const toggle = root.children[1]!;
    const checkbox = toggle.children.find(
      (child) => child.className === "control-input"
    )!;
    expect(checkbox.type).toBe("checkbox");
    expect(checkbox.checked).toBe(true);
    expect(toggle.find("control-value")?.textContent).toBe("On");

    expect(root.children[2]!.className).toBe("control-button");
    expect(root.children[2]!.textContent).toBe("HOME");
  });

  test("slider input forwards the numeric value to onInput", () => {
    const { panel, root, onInput } = createHarness();
    panel.update(CONTROLS, { swing: 0, grip: 0, home: 0 });

    const input = root.children[0]!.children.find(
      (child) => child.className === "control-input"
    )!;
    input.value = "0.75";
    input.emit("input");
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith("swing", 0.75);
  });

  test("toggle change forwards 0/1 to onInput", () => {
    const { panel, root, onInput } = createHarness();
    panel.update(CONTROLS, { swing: 0, grip: 0, home: 0 });

    const checkbox = root.children[1]!.children.find(
      (child) => child.className === "control-input"
    )!;
    checkbox.checked = true;
    checkbox.emit("change");
    expect(onInput).toHaveBeenLastCalledWith("grip", 1);

    checkbox.checked = false;
    checkbox.emit("change");
    expect(onInput).toHaveBeenLastCalledWith("grip", 0);
  });

  test("button click forwards a press", () => {
    const { panel, root, onPress } = createHarness();
    panel.update(CONTROLS, { swing: 0, grip: 0, home: 0 });

    root.children[2]!.click();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith("home");
  });

  test("live value updates patch inputs and labels without rebuilding rows", () => {
    const { panel, root } = createHarness();
    panel.update(CONTROLS, { swing: 0, grip: 0, home: 0 });
    const firstRow = root.children[0];
    const firstCheckbox = root.children[1]!.children.find(
      (child) => child.className === "control-input"
    )!;

    panel.update(CONTROLS, { swing: 0.42, grip: 1, home: 0 });
    expect(root.children[0]).toBe(firstRow);
    expect(firstRow!.find("control-value")?.textContent).toBe("0.4");
    expect(firstRow!.children.find((child) => child.className === "control-input")?.value).toBe("0.42");
    expect(root.children[1]!.children.find((child) => child.className === "control-input")).toBe(
      firstCheckbox
    );
    expect(firstCheckbox.checked).toBe(true);
  });

  test("definition changes rebuild the rows", () => {
    const { panel, root } = createHarness();
    panel.update(CONTROLS, {});
    const firstRow = root.children[0];

    panel.update(
      [{ ...CONTROLS[0]!, label: "Renamed" } as Control, CONTROLS[2]!],
      {}
    );
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).not.toBe(firstRow);
    expect(root.children[0]!.find("control-label")?.textContent).toBe("Renamed");
  });

  test("hides again when a reload drops every control", () => {
    const { panel, root } = createHarness();
    panel.update(CONTROLS, {});
    expect(root.hidden).toBe(false);

    panel.update([], {});
    expect(root.hidden).toBe(true);
    expect(root.children).toHaveLength(0);
  });
});
