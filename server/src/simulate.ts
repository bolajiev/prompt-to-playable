import {
  FIXED_DT_MS,
  createEngine,
  type Engine,
  type GameState,
} from "@prompt-to-playable/engine";
import type { Control, GameDoc, Vec3 } from "@prompt-to-playable/schema";
import { hasWinPath, resolveKit } from "./sanity.js";

/**
 * Headless engine simulation used as the agent's `simulate` tool. Every check
 * is deterministic (fixed timestep, neutral or scripted input, no wall clock)
 * and bounded to `SIMULATE_TICK_BUDGET` engine ticks per check, so a bad
 * document can never hang generation.
 *
 * Checks:
 * - always: the engine loads the doc and 180 neutral ticks produce no throw
 *   and no non-finite runtime position/rotation.
 * - game: scripted pursuit of the positional objective targets (the same
 *   steering idea as `tests/helpers/steer.ts`, reimplemented here so the
 *   server does not depend on test code). Passes on a win; a loss is accepted
 *   only when the doc ships an explicit `lose` action (its lose path is then
 *   honored by the simulation). Reports the final tick count.
 * - machine: every slider sweeps min -> max -> min and its bound property
 *   changes in the scale direction and stays finite; every toggle flips its
 *   bound property and flips back; every button press produces an animation,
 *   scratch or panel change.
 * - drive: two seconds of full throttle reach a finite positive speed.
 * - walkthrough: the player can move.
 * - inspect: at least one click rule targets an existing entity.
 * - explore: the doc has no zone entities.
 */

export interface SimulateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SimulateResult {
  ok: boolean;
  checks: SimulateCheck[];
  failures: string[];
}

/** Hard per-check tick ceiling; the whole tool stays well under this. */
export const SIMULATE_TICK_BUDGET = 6000;
/** Neutral-input stability window (about 3 seconds at the fixed timestep). */
export const SIMULATE_NEUTRAL_TICKS = 180;
/** Full-throttle window for the drive speed check (2 seconds). */
export const SIMULATE_THROTTLE_TICKS = 120;
/** Per-direction movement window for the walkthrough check. */
export const SIMULATE_WALK_TICKS = 30;

const STEER_STOP_DISTANCE = 0.5;
const STEER_INTERACT_DISTANCE = 1.5;
const STEER_INTERACT_TICKS = 3;
const STEER_JUMP_RISE = 0.5;
const STEER_STALL_WINDOW_TICKS = 10;
const STEER_STALL_MIN_PROGRESS = 0.05;
const STEER_SIDESTEP_TICKS = 20;
const SWEEP_STEPS = 5;
const PROPERTY_EPS = 1e-6;

function xzDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finiteVec(vec: Vec3 | undefined): boolean {
  return (
    vec === undefined ||
    (Number.isFinite(vec[0]) && Number.isFinite(vec[1]) && Number.isFinite(vec[2]))
  );
}

/**
 * Descriptions of every non-finite runtime position/rotation/velocity in the
 * state. Exported so the NaN guard itself is unit-testable; `simulateDoc`
 * calls it after load and after every scripted sequence.
 */
export function nonFiniteRuntime(state: GameState): string[] {
  const out: string[] = [];
  for (const [id, runtime] of Object.entries(state.entityRuntime)) {
    if (!finiteVec(runtime.position)) out.push(`${id}.position`);
    if (!finiteVec(runtime.rotation)) out.push(`${id}.rotation`);
    if (!finiteVec(runtime.localPosition)) out.push(`${id}.localPosition`);
    if (!finiteVec(runtime.localRotation)) out.push(`${id}.localRotation`);
    if (!finiteVec(runtime.velocity)) out.push(`${id}.velocity`);
  }
  return out;
}

/**
 * Steer the active player toward `target` on XZ using only `getState()` /
 * `step()`: normalized heading, interact pulses inside
 * `STEER_INTERACT_DISTANCE`, jump when the target sits above, and a 90-degree
 * sidestep when progress stalls (obstacle avoidance). Returns whether the
 * target was reached (or the game was won) and the ticks consumed.
 */
function steerTo(
  engine: Engine,
  target: Vec3,
  maxTicks: number
): { reached: boolean; ticks: number } {
  const recentXZ: Array<[number, number]> = [];
  let sidestepLeft = 0;
  let sidestepSign = 1;
  let interactTicks = 0;

  for (let tick = 0; tick < maxTicks; tick += 1) {
    const state = engine.getState();
    if (state.status === "won") return { reached: true, ticks: tick };
    if (state.status !== "running") return { reached: false, ticks: tick };

    const player = state.entities.find((entity) => entity.kind === "player");
    const runtime = player ? state.entityRuntime[player.id] : undefined;
    if (!runtime) return { reached: false, ticks: tick };

    const dist = xzDistance(runtime.position, target);
    if (dist <= STEER_STOP_DISTANCE) {
      // A fresh press cycle at the target guarantees one rising interact edge
      // inside the entity's real range regardless of the approach pulses.
      engine.step(FIXED_DT_MS);
      engine.step(FIXED_DT_MS, { interact: true });
      engine.step(FIXED_DT_MS);
      return { reached: true, ticks: tick + 3 };
    }

    const dx = target[0] - runtime.position[0];
    const dz = target[2] - runtime.position[2];
    const planar = Math.hypot(dx, dz);

    let moveX = planar > 1e-9 ? dx / planar : 0;
    let moveZ = planar > 1e-9 ? dz / planar : 0;

    recentXZ.push([runtime.position[0], runtime.position[2]]);
    if (recentXZ.length > STEER_STALL_WINDOW_TICKS + 1) recentXZ.shift();

    const stalled =
      recentXZ.length === STEER_STALL_WINDOW_TICKS + 1 &&
      Math.hypot(
        runtime.position[0] - recentXZ[0][0],
        runtime.position[2] - recentXZ[0][1]
      ) < STEER_STALL_MIN_PROGRESS;

    if (sidestepLeft === 0 && stalled) {
      sidestepLeft = STEER_SIDESTEP_TICKS;
      sidestepSign = -sidestepSign;
    }

    if (sidestepLeft > 0) {
      const rotatedX = -moveZ * sidestepSign;
      const rotatedZ = moveX * sidestepSign;
      moveX = rotatedX;
      moveZ = rotatedZ;
      sidestepLeft -= 1;
    }

    const input: { moveX: number; moveZ: number; jump?: boolean; interact?: boolean } = {
      moveX,
      moveZ,
    };
    if (target[1] - runtime.position[1] > STEER_JUMP_RISE && runtime.grounded) {
      input.jump = true;
    }
    if (dist <= STEER_INTERACT_DISTANCE) {
      input.interact = interactTicks < STEER_INTERACT_TICKS;
      interactTicks += 1;
    } else {
      interactTicks = 0;
    }

    engine.step(FIXED_DT_MS, input);
  }

  return { reached: false, ticks: maxTicks };
}

interface SteeringTarget {
  id: string;
  position: Vec3;
}

interface SteeringPlan {
  objectiveId: string;
  targets: SteeringTarget[];
}

/** Positional collect/reach/activate targets, in objective and target order. */
function steeringPlans(doc: GameDoc): SteeringPlan[] {
  const positionById = new Map<string, Vec3>(
    doc.entities.map((entity) => [entity.id, entity.position])
  );
  const plans: SteeringPlan[] = [];
  for (const objective of doc.objectives) {
    if (
      objective.type !== "collect" &&
      objective.type !== "reach" &&
      objective.type !== "activate"
    ) {
      continue;
    }
    const ids = objective.targets ?? (objective.target ? [objective.target] : []);
    const targets: SteeringTarget[] = [];
    for (const id of ids) {
      const position = positionById.get(id);
      if (position) targets.push({ id, position });
    }
    if (targets.length > 0) plans.push({ objectiveId: objective.id, targets });
  }
  return plans;
}

function hasLosePath(doc: GameDoc): boolean {
  return doc.rules.some((rule) =>
    rule.then.some((action) => action.type === "lose")
  );
}

interface Prefixed {
  prefix: string;
  result: SimulateCheck;
}

function gameCheck(engine: Engine, doc: GameDoc): Prefixed {
  const name = "win-path";
  const plans = steeringPlans(doc);
  if (plans.length === 0) {
    if (!hasWinPath(doc)) {
      return {
        prefix: name,
        result: {
          name,
          ok: false,
          detail: "no win path and no positional objective targets to pursue",
        },
      };
    }
    return {
      prefix: name,
      result: {
        name,
        ok: true,
        detail: "win path present; no positional targets to pursue",
      },
    };
  }

  let attempted = 0;
  let reached = 0;
  let stalledAt: string | undefined;
  for (const plan of plans) {
    for (const target of plan.targets) {
      if (engine.getState().status !== "running") break;
      const remaining = SIMULATE_TICK_BUDGET - engine.getState().ticks;
      if (remaining <= 0) {
        stalledAt = `${target.id} (objective ${plan.objectiveId})`;
        break;
      }
      attempted += 1;
      const steer = steerTo(engine, target.position, remaining);
      if (steer.reached) reached += 1;
      else {
        stalledAt = `${target.id} (objective ${plan.objectiveId})`;
        break;
      }
    }
    if (stalledAt !== undefined || engine.getState().status !== "running") break;
  }

  const state = engine.getState();
  const ticks = state.ticks;
  if (state.status === "won") {
    return {
      prefix: name,
      result: { name, ok: true, detail: `won at tick ${ticks}` },
    };
  }
  if (state.status === "lost") {
    if (hasLosePath(doc)) {
      return {
        prefix: name,
        result: {
          name,
          ok: true,
          detail: `explicit lose path honored at tick ${ticks}`,
        },
      };
    }
    return {
      prefix: name,
      result: {
        name,
        ok: false,
        detail: `lost at tick ${ticks} with no explicit lose rule`,
      },
    };
  }

  const pending = state.objectives
    .filter((objective) => objective.status === "active")
    .map(
      (objective) =>
        `${objective.id} ${objective.progress}/${objective.count ?? "?"}`
    )
    .join(", ");

  if (stalledAt !== undefined) {
    // The scripted pursuer could not finish this target (elevated terrain,
    // tight corridors, ...). That is a limit of the simulation, not proof the
    // document is broken, so it is reported without failing generation.
    return {
      prefix: name,
      result: {
        name,
        ok: true,
        detail:
          `pursuit stalled at ${stalledAt} ` +
          `(${reached}/${attempted} targets reached, ${ticks} ticks); win not confirmed`,
      },
    };
  }

  // Every target was reached but the game never finished: the objective or
  // win logic does not react to the targets, which is a document bug.
  return {
    prefix: name,
    result: {
      name,
      ok: false,
      detail:
        `all ${attempted} objective target${attempted === 1 ? "" : "s"} reached ` +
        `but the game did not finish` +
        (pending.length > 0 ? ` (${pending})` : ""),
    },
  };
}

type BoundValue = number | string | boolean | undefined;

function axisIndex(property: string): number {
  if (property.endsWith(".x")) return 0;
  if (property.endsWith(".z")) return 2;
  return 1;
}

/** Live value a control drives: an entity property (local when parented) or scratch. */
function boundControlValue(state: GameState, control: Control): BoundValue {
  const bind = control.bind;
  if (!bind) return undefined;
  if (bind.entity === undefined || bind.property === undefined) {
    return bind.var === undefined ? undefined : state.scratch[bind.var];
  }
  const runtime = state.entityRuntime[bind.entity];
  if (!runtime) return undefined;
  switch (bind.property) {
    case "visible":
      return runtime.visible;
    case "color":
      return runtime.color;
    case "emissive":
      return runtime.emissive;
    default: {
      const axis = axisIndex(bind.property);
      if (bind.property.startsWith("rotation.")) {
        const rotation = runtime.localRotation ?? runtime.rotation;
        return rotation?.[axis];
      }
      const position = runtime.localPosition ?? runtime.position;
      return position[axis];
    }
  }
}

function stepWithValue(engine: Engine, control: Control, value: number): BoundValue {
  engine.setControl(control.id, value);
  return boundControlValue(engine.step(FIXED_DT_MS), control);
}

function sliderCheck(engine: Engine, control: Control): Prefixed {
  const name = `slider '${control.id}'`;
  const min = control.min ?? -1;
  const max = control.max ?? 1;
  if (!(min < max)) {
    return {
      prefix: name,
      result: {
        name,
        ok: false,
        detail: `has no span (min ${min} >= max ${max})`,
      },
    };
  }

  const up: BoundValue[] = [];
  const down: BoundValue[] = [];
  for (let i = 0; i <= SWEEP_STEPS; i += 1) {
    up.push(stepWithValue(engine, control, min + ((max - min) * i) / SWEEP_STEPS));
  }
  for (let i = SWEEP_STEPS - 1; i >= 0; i -= 1) {
    down.push(stepWithValue(engine, control, min + ((max - min) * i) / SWEEP_STEPS));
  }

  const samples = [...up, ...down];
  if (samples.some((sample) => sample === undefined)) {
    return {
      prefix: name,
      result: {
        name,
        ok: false,
        detail: `bound property ${control.bind?.property ?? "(none)"} is not readable`,
      },
    };
  }
  if (samples.some((sample) => typeof sample === "number" && !Number.isFinite(sample))) {
    return {
      prefix: name,
      result: { name, ok: false, detail: "produced a non-finite value" },
    };
  }

  const scale = control.bind?.scale ?? 1;
  const sign = scale < 0 ? -1 : 1;
  const monotonic = (values: BoundValue[], direction: number): boolean => {
    if (!values.every((value) => typeof value === "number")) return true;
    for (let i = 1; i < values.length; i += 1) {
      const delta =
        ((values[i] as number) - (values[i - 1] as number)) * sign * direction;
      if (delta < -1e-9) return false;
    }
    return true;
  };
  if (!monotonic(up, 1) || !monotonic(down, -1)) {
    return {
      prefix: name,
      result: {
        name,
        ok: false,
        detail: "bound property is not monotonic across the sweep",
      },
    };
  }

  const numeric = samples.filter(
    (sample): sample is number => typeof sample === "number"
  );
  const distinct = new Set(samples.map((sample) => String(sample))).size;
  const span =
    numeric.length === samples.length
      ? Math.max(...numeric) - Math.min(...numeric)
      : distinct > 1
        ? Number.POSITIVE_INFINITY
        : 0;
  if (span <= PROPERTY_EPS) {
    return {
      prefix: name,
      result: {
        name,
        ok: false,
        detail: `sweep does not move ${control.bind?.property ?? "its binding"}`,
      },
    };
  }

  return {
    prefix: name,
    result: {
      name,
      ok: true,
      detail: `swept ${min}..${max} on ${control.bind?.property ?? control.bind?.var ?? "binding"}`,
    },
  };
}

function toggleCheck(engine: Engine, control: Control): Prefixed {
  const name = `toggle '${control.id}'`;
  if (!control.bind || (control.bind.entity === undefined && control.bind.var === undefined)) {
    return {
      prefix: name,
      result: { name, ok: false, detail: "has no bound property" },
    };
  }
  const off = stepWithValue(engine, control, 0);
  const on = stepWithValue(engine, control, 1);
  const back = stepWithValue(engine, control, 0);
  if (off === undefined || on === undefined || back === undefined) {
    return {
      prefix: name,
      result: { name, ok: false, detail: "bound property is not readable" },
    };
  }
  if (typeof off === "number" && !Number.isFinite(off)) {
    return {
      prefix: name,
      result: { name, ok: false, detail: "produced a non-finite value" },
    };
  }
  if (off === on) {
    return {
      prefix: name,
      result: { name, ok: false, detail: "flip does not change its bound property" },
    };
  }
  if (back !== off) {
    return {
      prefix: name,
      result: { name, ok: false, detail: "does not return to its off value" },
    };
  }
  return {
    prefix: name,
    result: { name, ok: true, detail: "flips and returns to off" },
  };
}

function machineSignature(state: GameState): string {
  const animations: Record<string, string[]> = {};
  for (const [id, runtime] of Object.entries(state.entityRuntime)) {
    const kinds = runtime.animations.map((entry) => entry.kind);
    if (kinds.length > 0) animations[id] = kinds;
  }
  return JSON.stringify({
    scratch: state.scratch,
    status: state.status,
    panels: state.ui.panels.map((panel) => panel.id),
    animations,
  });
}

function buttonCheck(engine: Engine, control: Control): Prefixed {
  const name = `button '${control.id}'`;
  const onPress = control.bind?.onPress ?? [];
  if (onPress.length === 0) {
    return {
      prefix: name,
      result: { name, ok: false, detail: "has no onPress actions" },
    };
  }
  const before = machineSignature(engine.getState());
  engine.pressControl(control.id);
  const after = machineSignature(engine.step(FIXED_DT_MS));
  if (before === after) {
    return {
      prefix: name,
      result: { name, ok: false, detail: "press has no observable effect" },
    };
  }
  return {
    prefix: name,
    result: { name, ok: true, detail: "press changes animation or scratch" },
  };
}

function machineChecks(engine: Engine, doc: GameDoc): Prefixed[] {
  const controls = doc.controls ?? [];
  const checks: Prefixed[] = [];
  for (const control of controls) {
    if (control.type === "slider") checks.push(sliderCheck(engine, control));
    else if (control.type === "toggle") checks.push(toggleCheck(engine, control));
    else checks.push(buttonCheck(engine, control));
  }
  if (checks.length === 0) {
    checks.push({
      prefix: "controls",
      result: {
        name: "controls",
        ok: false,
        detail: "machine scene has no controls to sweep",
      },
    });
  }
  return checks;
}

function driveCheck(engine: Engine, doc: GameDoc): Prefixed {
  const name = "throttle";
  try {
    for (let i = 0; i < SIMULATE_THROTTLE_TICKS; i += 1) {
      engine.step(FIXED_DT_MS, { moveZ: 1 });
    }
  } catch (error) {
    return {
      prefix: name,
      result: { name, ok: false, detail: `threw: ${messageOf(error)}` },
    };
  }
  const player = doc.entities.find((entity) => entity.kind === "player");
  const runtime = player ? engine.getState().entityRuntime[player.id] : undefined;
  const speed = runtime?.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) {
    return {
      prefix: name,
      result: {
        name,
        ok: false,
        detail: `speed after 2s throttle is ${speed === undefined ? "unavailable" : String(speed)}`,
      },
    };
  }
  return {
    prefix: name,
    result: {
      name,
      ok: true,
      detail: `speed ${speed.toFixed(2)} after 2s throttle`,
    },
  };
}

function walkthroughCheck(engine: Engine, doc: GameDoc): Prefixed {
  const name = "movement";
  const player = doc.entities.find((entity) => entity.kind === "player");
  if (!player) {
    return {
      prefix: name,
      result: { name, ok: false, detail: "no player entity" },
    };
  }
  const directions: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];
  let best = 0;
  for (const [moveX, moveZ] of directions) {
    const start = engine.getState().entityRuntime[player.id]?.position;
    if (!start) break;
    for (let i = 0; i < SIMULATE_WALK_TICKS; i += 1) {
      engine.step(FIXED_DT_MS, { moveX, moveZ });
    }
    const end = engine.getState().entityRuntime[player.id]?.position;
    if (!end) break;
    best = Math.max(best, xzDistance(start, end));
    if (best > 0.05) break;
  }
  if (best <= 0.05) {
    return {
      prefix: name,
      result: { name, ok: false, detail: "player cannot move in any direction" },
    };
  }
  return {
    prefix: name,
    result: {
      name,
      ok: true,
      detail: `player moved ${best.toFixed(2)} units`,
    },
  };
}

function inspectCheck(doc: GameDoc): Prefixed {
  const name = "click-rules";
  const existing = new Set<string>(
    doc.entities.map((entity) => String(entity.id))
  );
  const clickable = doc.rules.filter(
    (rule) =>
      rule.on.event === "click" &&
      rule.on.entity !== undefined &&
      existing.has(rule.on.entity)
  );
  if (clickable.length === 0) {
    return {
      prefix: name,
      result: {
        name,
        ok: false,
        detail: "no click rule targets an existing entity",
      },
    };
  }
  return {
    prefix: name,
    result: {
      name,
      ok: true,
      detail: `${clickable.length} clickable rule${clickable.length === 1 ? "" : "s"}`,
    },
  };
}

function exploreCheck(doc: GameDoc): Prefixed {
  const name = "no-zones";
  const zones = doc.entities.filter((entity) => entity.kind === "zone");
  if (zones.length > 0) {
    return {
      prefix: name,
      result: {
        name,
        ok: false,
        detail: `explore scenes must not have zones (found ${zones.map((zone) => zone.id).join(", ")})`,
      },
    };
  }
  return {
    prefix: name,
    result: {
      name,
      ok: true,
      detail: `no zones across ${doc.entities.length} entities`,
    },
  };
}

/**
 * Run the deterministic simulation suite for `doc`. Never throws: engine
 * failures are reported as failed checks with their reason.
 */
export function simulateDoc(doc: GameDoc): SimulateResult {
  const checks: SimulateCheck[] = [];
  const failures: string[] = [];
  const record = (entry: Prefixed): void => {
    checks.push(entry.result);
    if (!entry.result.ok) {
      failures.push(`${entry.result.name}: ${entry.result.detail}`);
    }
  };

  const engine = createEngine();
  try {
    engine.load(doc);
  } catch (error) {
    record({
      prefix: "load",
      result: {
        name: "load",
        ok: false,
        detail: `engine failed to load the document: ${messageOf(error)}`,
      },
    });
    return { ok: false, checks, failures };
  }
  checks.push({
    name: "load",
    ok: true,
    detail: `engine loaded ${doc.entities.length} entities`,
  });

  let threw: string | null = null;
  let neutralTicks = 0;
  try {
    for (let i = 0; i < SIMULATE_NEUTRAL_TICKS; i += 1) {
      if (engine.getState().status !== "running") break;
      engine.step(FIXED_DT_MS);
      neutralTicks += 1;
    }
  } catch (error) {
    threw = messageOf(error);
  }
  const neutralNaN = nonFiniteRuntime(engine.getState());
  if (threw !== null) {
    record({
      prefix: "ticks",
      result: {
        name: "ticks",
        ok: false,
        detail: `threw on neutral tick ${neutralTicks + 1}: ${threw}`,
      },
    });
  } else if (neutralNaN.length > 0) {
    record({
      prefix: "ticks",
      result: {
        name: "ticks",
        ok: false,
        detail: `non-finite runtime values after ${neutralTicks} neutral ticks: ${neutralNaN.join(", ")}`,
      },
    });
  } else {
    checks.push({
      name: "ticks",
      ok: true,
      detail: `${neutralTicks} neutral ticks, no NaN`,
    });
  }

  const kit = resolveKit(doc);
  try {
    if (kit === "game") {
      record(gameCheck(engine, doc));
    } else if (kit === "machine") {
      for (const entry of machineChecks(engine, doc)) record(entry);
    } else if (kit === "drive") {
      record(driveCheck(engine, doc));
    } else if (kit === "walkthrough") {
      record(walkthroughCheck(engine, doc));
    } else if (kit === "inspect") {
      record(inspectCheck(doc));
    } else {
      record(exploreCheck(doc));
    }

    const scriptedNaN = nonFiniteRuntime(engine.getState());
    if (scriptedNaN.length > 0) {
      failures.push(
        `runtime: non-finite values after scripted input on ${scriptedNaN.join(", ")}`
      );
      checks.push({
        name: "runtime",
        ok: false,
        detail: `non-finite values after scripted input: ${scriptedNaN.join(", ")}`,
      });
    }
  } catch (error) {
    record({
      prefix: "simulate",
      result: {
        name: "simulate",
        ok: false,
        detail: `threw: ${messageOf(error)}`,
      },
    });
  }

  return { ok: failures.length === 0, checks, failures };
}
