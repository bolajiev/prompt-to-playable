import type { Control, GameMode } from "@prompt-to-playable/schema";

/**
 * Right-sidebar interactive control panel: a pure view-model plus a small DOM
 * renderer. The panel only *reads* `doc.controls` and `state.ui.controls` and
 * forwards edits through `onInput` / `onPress` (the app calls
 * `engine.setControl` / `engine.pressControl`); it never touches engine state.
 */

/** Slider fallbacks when the document leaves `min` / `max` / `step` out. */
export const DEFAULT_SLIDER_MIN = 0;
export const DEFAULT_SLIDER_MAX = 1;
export const DEFAULT_SLIDER_STEP = 0.01;

/** Heading for documents whose mode has no dedicated control surface. */
export const DEFAULT_CONTROLS_LABEL = "Controls";

/**
 * Panel heading for a document mode: open worlds get a dedicated "World
 * controls" label, machines keep "Machine controls", every other mode with
 * controls falls back to the generic "Controls".
 */
export function controlsPanelLabel(mode: GameMode): string {
  if (mode === "world") return "World controls";
  if (mode === "machine") return "Machine controls";
  return DEFAULT_CONTROLS_LABEL;
}

/** Display data for one control row (stable field order, no extras). */
export interface ControlViewModel {
  id: string;
  type: Control["type"];
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

/**
 * Maps document controls plus live `ui.controls` values to render data.
 * The live value wins; a control with no live entry falls back to its authored
 * `value` and then to 0 (mirroring the engine's initialization).
 */
export function controlsToViewModel(
  controls: readonly Control[],
  values: Readonly<Record<string, number>>
): ControlViewModel[] {
  return controls.map((control) => ({
    id: control.id,
    type: control.type,
    label: control.label,
    min: control.min ?? DEFAULT_SLIDER_MIN,
    max: control.max ?? DEFAULT_SLIDER_MAX,
    step: control.step ?? DEFAULT_SLIDER_STEP,
    value: values[control.id] ?? control.value ?? 0,
  }));
}

/** Decimals to show for a slider value, derived from its step. */
export function sliderDecimals(step: number): number {
  if (!(step > 0) || step >= 1) return 0;
  if (step >= 0.1) return 1;
  return 2;
}

/** Live value label copy: sliders show the number, toggles On/Off. */
export function formatControlValue(view: ControlViewModel): string {
  if (view.type === "toggle") return view.value > 0.5 ? "On" : "Off";
  if (view.type === "button") return "";
  return view.value.toFixed(sliderDecimals(view.step));
}

export interface ControlsPanelOptions {
  /** Slider drag / toggle flip: forward the live value to the engine. */
  onInput(id: string, value: number): void;
  /** Button click: forward the press to the engine. */
  onPress(id: string): void;
}

interface ControlRow {
  input?: HTMLInputElement;
  valueLabel?: HTMLElement;
}

/**
 * DOM renderer for `doc.controls`. Rows are rebuilt only when the control
 * definitions change (id/type/label/bounds); live value updates patch the
 * existing inputs and value labels in place, so an in-progress slider drag is
 * never interrupted. Hidden while the document has no controls.
 */
export class ControlsPanel {
  private signature: string | null = null;
  private readonly rows = new Map<string, ControlRow>();

  constructor(
    private readonly root: HTMLElement,
    private readonly options: ControlsPanelOptions
  ) {
    this.update([], {});
  }

  update(
    controls: readonly Control[],
    values: Readonly<Record<string, number>>,
    label: string = DEFAULT_CONTROLS_LABEL
  ): void {
    const view = controlsToViewModel(controls, values);
    const signature = `${label}\u0002${view
      .map(
        (control) =>
          `${control.id}\u0000${control.type}\u0000${control.label}\u0000${control.min}\u0000${control.max}\u0000${control.step}`
      )
      .join("\u0001")}`;

    this.root.hidden = view.length === 0;
    this.root.setAttribute("aria-label", label);
    if (signature === this.signature) {
      for (const control of view) this.sync(control);
      return;
    }
    this.signature = signature;
    this.rows.clear();

    const doc = this.root.ownerDocument;
    if (view.length === 0) {
      this.root.replaceChildren();
      return;
    }
    const heading = doc.createElement("p");
    heading.className = "controls-title";
    heading.textContent = label;
    this.root.replaceChildren(
      heading,
      ...view.map((control) => this.buildRow(doc, control))
    );
    for (const control of view) this.sync(control);
  }

  private buildRow(doc: Document, control: ControlViewModel): HTMLElement {
    if (control.type === "button") {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "control-button";
      button.dataset.controlId = control.id;
      button.dataset.controlType = control.type;
      button.textContent = control.label;
      button.addEventListener("click", () => this.options.onPress(control.id));
      return button;
    }

    const row = doc.createElement("label");
    row.className = "control-row";
    row.dataset.controlId = control.id;
    row.dataset.controlType = control.type;
    row.title = control.label;

    const valueLabel = doc.createElement("span");
    valueLabel.className = "control-value";

    if (control.type === "toggle") {
      const input = doc.createElement("input");
      input.type = "checkbox";
      input.className = "control-input";
      input.addEventListener("change", () =>
        this.options.onInput(control.id, input.checked ? 1 : 0)
      );
      row.append(input, this.label(doc, control.label), valueLabel);
      this.rows.set(control.id, { input, valueLabel });
    } else {
      const input = doc.createElement("input");
      input.type = "range";
      input.className = "control-input";
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      input.addEventListener("input", () =>
        this.options.onInput(control.id, Number(input.value))
      );
      row.append(this.label(doc, control.label), valueLabel, input);
      this.rows.set(control.id, { input, valueLabel });
    }

    return row;
  }

  private label(doc: Document, text: string): HTMLElement {
    const label = doc.createElement("span");
    label.className = "control-label";
    label.textContent = text;
    return label;
  }

  /** Patch live values into an existing row without rebuilding it. */
  private sync(control: ControlViewModel): void {
    const row = this.rows.get(control.id);
    if (!row) return;
    if (row.input) {
      if (control.type === "toggle") {
        row.input.checked = control.value > 0.5;
      } else if (row.input.value !== String(control.value)) {
        row.input.value = String(control.value);
      }
    }
    if (row.valueLabel) {
      const text = formatControlValue(control);
      if (row.valueLabel.textContent !== text) {
        row.valueLabel.textContent = text;
      }
    }
  }
}
