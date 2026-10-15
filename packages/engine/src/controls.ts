import type {
  Control,
  ControlBindProperty,
  GameDoc,
  Rule,
  RuleId,
  Vec3,
} from "@prompt-to-playable/schema";
import type { ControlBase, EntityRuntime, GameState } from "./state.js";

/**
 * Interactive controls: pure data owned by the document (`doc.controls`), live
 * values in `state.ui.controls` and per-tick bindings applied AFTER integrate.
 *
 * Semantics:
 * - slider/toggle value drives `base + value * scale + offset` on the bound
 *   rotation/position axis. `base` is the authored pose captured at load
 *   (`state.controlBases`), never the already-bound runtime pose, so repeated
 *   ticks and value changes never accumulate.
 * - `visible` is `value > 0.5` (scale/offset are ignored for it).
 * - `color` maps the scaled value to a hue (degrees): `hsl(h 85% 60%)`.
 * - `emissive` writes a non-negative numeric factor into `runtime.emissive`.
 * - `bind.var` mirrors the live value into `state.scratch`.
 * - buttons only pulse (`state.ui.controls[id] = 1` then 0 after the tick that
 *   consumes their `controlPressed` event) and run `bind.onPress` actions
 *   through the rules action executor (see `controlRules`).
 *
 * All helpers are copy-on-write and deterministic: they never mutate the
 * previous state object.
 */

/**
 * Controls of a document, tolerating docs that bypassed schema defaults
 * (fixtures and tests load raw JSON).
 */
export function docControls(doc: GameDoc): readonly Control[] {
  return doc.controls ?? [];
}

/** Default initial value of a control: explicit `value`, else 0. */
export function defaultControlValues(doc: GameDoc): Record<string, number> {
  const values: Record<string, number> = {};
  for (const control of docControls(doc)) {
    values[control.id] = control.value ?? 0;
  }
  return values;
}

/** Copy-on-write value update; unknown ids and non-finite values are no-ops. */
export function setControlValue(
  state: GameState,
  id: string,
  value: number
): GameState {
  if (!Number.isFinite(value)) return state;
  if (!docControls(state.doc).some((control) => control.id === id)) return state;
  if (state.ui.controls[id] === value) return state;
  return {
    ...state,
    ui: { ...state.ui, controls: { ...state.ui.controls, [id]: value } },
  };
}

/** Buttons pulse down after the tick that consumed their press. */
export function resetButtonPulses(state: GameState): GameState {
  let controls = state.ui.controls;
  let changed = false;
  for (const control of docControls(state.doc)) {
    if (control.type !== "button") continue;
    const value = controls[control.id];
    if (typeof value === "number" && value > 0) {
      if (!changed) {
        controls = { ...controls };
        changed = true;
      }
      controls[control.id] = 0;
    }
  }
  if (!changed) return state;
  return { ...state, ui: { ...state.ui, controls } };
}

/**
 * Authored pose anchor for a bound entity: captured at load for every entity
 * present in the document, falling back to the entity's authored pose (or the
 * live runtime pose for entities that only exist at runtime).
 */
function controlBaseFor(
  state: GameState,
  entityId: string
): ControlBase | undefined {
  const captured = state.controlBases[entityId];
  if (captured) return captured;
  const entity = state.entities.find((e) => e.id === entityId);
  if (entity) {
    return {
      position: [...entity.position] as Vec3,
      rotation: entity.rotation ? ([...entity.rotation] as Vec3) : [0, 0, 0],
    };
  }
  const runtime = state.entityRuntime[entityId];
  if (!runtime) return undefined;
  return {
    position: [...runtime.position] as Vec3,
    rotation: runtime.rotation ? ([...runtime.rotation] as Vec3) : [0, 0, 0],
  };
}

/** Deterministic scalar -> color mapping for `bind.property: "color"`. */
export function controlColor(value: number): string {
  const hue = ((value % 360) + 360) % 360;
  return `hsl(${hue} 85% 60%)`;
}

function axisIndex(property: ControlBindProperty): 0 | 1 | 2 | undefined {
  switch (property) {
    case "rotation.x":
    case "position.x":
      return 0;
    case "rotation.y":
    case "position.y":
      return 1;
    case "rotation.z":
    case "position.z":
      return 2;
    default:
      return undefined;
  }
}

/**
 * Runtime patch for one bound property. The bound axis is derived from the
 * captured base; every other axis keeps the live runtime value so multiple
 * single-axis controls compose instead of overwriting each other.
 */
function bindingPatch(
  state: GameState,
  runtime: EntityRuntime,
  entityId: string,
  property: ControlBindProperty,
  value: number,
  scaled: number
): Partial<EntityRuntime> | undefined {
  const axis = axisIndex(property);
  if (axis !== undefined) {
    const base = controlBaseFor(state, entityId);
    if (!base) return undefined;
    if (property.startsWith("rotation.")) {
      const rotation: Vec3 = [
        ...(runtime.rotation ?? base.rotation),
      ] as Vec3;
      rotation[axis] = base.rotation[axis] + scaled;
      return { rotation };
    }
    const position: Vec3 = [...runtime.position] as Vec3;
    position[axis] = base.position[axis] + scaled;
    return { position };
  }

  switch (property) {
    case "visible":
      return { visible: value > 0.5 };
    case "color":
      return { color: controlColor(scaled) };
    case "emissive":
      return { emissive: Math.max(0, scaled) };
  }
}

/**
 * Per-tick binding application (after integrate, before broadphase/rules).
 * Buttons are skipped: their value is a one-tick pulse consumed by
 * `controlPressed`, not a continuous binding.
 */
export function applyControlBindings(state: GameState): GameState {
  const controls = docControls(state.doc);
  if (controls.length === 0) return state;

  let entityRuntime = state.entityRuntime;
  let scratch = state.scratch;
  let runtimeChanged = false;
  let scratchChanged = false;

  for (const control of controls) {
    if (control.type === "button") continue;
    const bind = control.bind;
    if (!bind) continue;

    const value = state.ui.controls[control.id] ?? control.value ?? 0;
    if (!Number.isFinite(value)) continue;

    if (bind.var !== undefined && scratch[bind.var] !== value) {
      if (!scratchChanged) {
        scratch = { ...scratch };
        scratchChanged = true;
      }
      scratch[bind.var] = value;
    }

    if (bind.entity === undefined || bind.property === undefined) continue;
    const runtime = entityRuntime[bind.entity];
    if (!runtime) continue;

    const scaled = value * (bind.scale ?? 1) + (bind.offset ?? 0);
    const patch = bindingPatch(
      state,
      runtime,
      bind.entity,
      bind.property,
      value,
      scaled
    );
    if (!patch) continue;

    entityRuntime = {
      ...entityRuntime,
      [bind.entity]: { ...runtime, ...patch },
    };
    runtimeChanged = true;
  }

  if (!runtimeChanged && !scratchChanged) return state;
  return {
    ...state,
    entityRuntime: runtimeChanged ? entityRuntime : state.entityRuntime,
    scratch: scratchChanged ? scratch : state.scratch,
  };
}

/**
 * Synthetic rules that execute each control's `bind.onPress` actions when its
 * `controlPressed` event fires. Folding them into `evaluateRules` reuses the
 * exact rules semantics (trigger matching on `controlId`, `if`-less, two-phase
 * pass ordering with doc rules) and the shared action executor, so controls and
 * rules can never diverge. Synthetic ids are prefixed to avoid collisions.
 */
export const CONTROL_RULE_PREFIX = "__control__";

export function controlRules(doc: GameDoc): Rule[] {
  const rules: Rule[] = [];
  for (const control of docControls(doc)) {
    const onPress = control.bind?.onPress;
    if (!onPress || onPress.length === 0) continue;
    rules.push({
      id: `${CONTROL_RULE_PREFIX}${control.id}` as RuleId,
      on: { event: "controlPressed", entity: control.id },
      then: onPress,
    });
  }
  return rules;
}
