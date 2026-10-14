import type {
  Action,
  Condition,
  Entity,
  Objective,
  ObjectiveStatus,
  Rule,
  RuleTrigger,
  ValueRef,
} from "@prompt-to-playable/schema";
import type { GameEvent } from "./events.js";
import {
  createEntityRuntime,
  type AnimationRuntime,
  type EntityRuntime,
  type GameState,
  type PanelState,
} from "./state.js";

export interface RuleEvaluation {
  state: GameState;
  actions: Action[];
}

function isRefObject(value: ValueRef): value is { var: string } | { stat: string } {
  return typeof value === "object" && value !== null;
}

function getStat(state: GameState, key: string): number | undefined {
  if (key === "time") return state.time;
  if (key === "ticks") return state.ticks;
  if (key === "entityCount") return state.entities.length;
  if (key === "objectiveCount") return state.objectives.length;
  const match = /^objective\.(.+)\.progress$/.exec(key);
  if (match) {
    return state.objectives.find((o) => o.id === match[1])?.progress;
  }
  return undefined;
}

export function resolveValue(ref: ValueRef, state: GameState): unknown {
  if (isRefObject(ref)) {
    if ("var" in ref) return state.scratch[ref.var];
    return getStat(state, ref.stat);
  }
  return ref;
}

function compare(op: string, left: unknown, right: unknown): boolean {
  if (op === "==") return left === right;
  if (op === "!=") return left !== right;
  const l = typeof left === "number" ? left : Number(left);
  const r = typeof right === "number" ? right : Number(right);
  if (Number.isNaN(l) || Number.isNaN(r)) return false;
  switch (op) {
    case "<":
      return l < r;
    case "<=":
      return l <= r;
    case ">":
      return l > r;
    case ">=":
      return l >= r;
    default:
      return false;
  }
}

function entityTags(state: GameState, id: string): string[] {
  const runtime = state.entityRuntime[id];
  if (runtime) return runtime.tags;
  return state.entities.find((e) => e.id === id)?.tags ?? [];
}

function entityIsActive(state: GameState, id: string): boolean {
  const runtime = state.entityRuntime[id];
  if (runtime) return runtime.active;
  const entity = state.entities.find((e) => e.id === id);
  return entity ? entity.active : false;
}

export function evaluateCondition(
  condition: Condition | undefined,
  state: GameState
): boolean {
  if (!condition) return true;
  switch (condition.op) {
    case "and":
      return condition.conditions.every((c) => evaluateCondition(c, state));
    case "or":
      return condition.conditions.some((c) => evaluateCondition(c, state));
    case "not":
      return !evaluateCondition(condition.condition, state);
    case "has":
      return entityIsActive(state, condition.entity);
    case "hasTag":
      return state.entities.some(
        (e) =>
          entityIsActive(state, e.id) &&
          entityTags(state, e.id).includes(condition.tag)
      );
    default:
      return compare(
        condition.op,
        resolveValue(condition.left, state),
        resolveValue(condition.right, state)
      );
  }
}

function eventEntityIds(event: GameEvent): string[] {
  switch (event.type) {
    case "playerEnter":
      return [event.zoneId, event.entityId];
    case "interact":
      return [event.targetId, event.entityId];
    case "click":
    case "hoverEnter":
    case "hoverLeave":
      return [event.targetId];
    case "enemyContact":
      return [event.entityId];
    case "objectiveComplete":
    case "objectiveFailed":
    case "objectiveProgress":
      return [event.objectiveId];
    default:
      return [];
  }
}

function matchesTrigger(
  trigger: RuleTrigger,
  event: GameEvent,
  state: GameState
): boolean {
  if (trigger.event !== event.type) return false;

  if (trigger.zone !== undefined) {
    if (event.type !== "playerEnter" || event.zoneId !== trigger.zone) {
      return false;
    }
  }

  if (trigger.objective !== undefined) {
    if (
      (event.type !== "objectiveProgress" &&
        event.type !== "objectiveComplete" &&
        event.type !== "objectiveFailed") ||
      event.objectiveId !== trigger.objective
    ) {
      return false;
    }
  }

  if (trigger.entity !== undefined) {
    if (!eventEntityIds(event).includes(trigger.entity)) return false;
  }

  if (trigger.tag !== undefined) {
    const tag = trigger.tag;
    if (!eventEntityIds(event).some((id) => entityTags(state, id).includes(tag))) {
      return false;
    }
  }

  return true;
}

export function evaluateRules(
  state: GameState,
  events: GameEvent[]
): RuleEvaluation {
  let entities = state.entities;
  let entityRuntime = state.entityRuntime;
  let objectives = state.objectives;
  let scratch = state.scratch;
  let status = state.status;
  let ui = state.ui;
  let changed = false;

  const view = (): GameState => ({
    ...state,
    entities,
    entityRuntime,
    objectives,
    scratch,
    status,
    ui,
  });

  const updateRuntime = (id: string, patch: Partial<EntityRuntime>): void => {
    const current = entityRuntime[id];
    if (!current) return;
    entityRuntime = { ...entityRuntime, [id]: { ...current, ...patch } };
    changed = true;
  };

  const setActive = (id: string, active: boolean): void => {
    if (!entityRuntime[id]) return;
    updateRuntime(id, { active });
    entities = entities.map((e) => (e.id === id ? { ...e, active } : e));
  };

  const despawn = (id: string): void => {
    if (!entityRuntime[id] && !entities.some((e) => e.id === id)) return;
    entities = entities.filter((e) => e.id !== id);
    const nextRuntime = { ...entityRuntime };
    delete nextRuntime[id];
    entityRuntime = nextRuntime;
    changed = true;
  };

  const spawn = (entity: Entity): void => {
    entityRuntime = {
      ...entityRuntime,
      [entity.id]: createEntityRuntime(entity),
    };
    entities = entities.some((e) => e.id === entity.id)
      ? entities.map((e) => (e.id === entity.id ? entity : e))
      : [...entities, entity];
    changed = true;
  };

  const animate = (action: Extract<Action, { type: "animate" }>): void => {
    const current = entityRuntime[action.entity];
    if (!current) return;

    const animation: AnimationRuntime = {
      kind: action.kind,
      elapsed: 0,
      basePos: [...current.position],
      baseRot: current.rotation ? [...current.rotation] : [0, 0, 0],
    };
    if (action.axis) animation.axis = [...action.axis];
    if (action.amplitude !== undefined) animation.amplitude = action.amplitude;
    if (action.speed !== undefined) animation.speed = action.speed;
    if (action.to) animation.to = [...action.to];
    if (action.duration !== undefined) animation.duration = action.duration;

    const animations = [
      ...current.animations.filter((a) => a.kind !== action.kind),
      animation,
    ];
    updateRuntime(action.entity, { animations });
  };

  const showPanel = (action: Extract<Action, { type: "showPanel" }>): void => {
    const panel: PanelState = {
      id: `${action.entity ?? "panel"}-${ui.nextPanelId}`,
      title: action.title,
      body: action.body,
    };
    if (action.entity !== undefined) panel.entity = action.entity;
    ui = {
      ...ui,
      panels: [...ui.panels, panel],
      nextPanelId: ui.nextPanelId + 1,
    };
    changed = true;
  };

  const hidePanel = (action: Extract<Action, { type: "hidePanel" }>): void => {
    if (action.entity === undefined) {
      if (ui.panels.length === 0) return;
      ui = { ...ui, panels: [] };
      changed = true;
      return;
    }
    const panels = ui.panels.filter((panel) => panel.entity !== action.entity);
    if (panels.length === ui.panels.length) return;
    ui = { ...ui, panels };
    changed = true;
  };

  const progressObjective = (id: string, by: number, to?: number): void => {
    const index = objectives.findIndex((o) => o.id === id);
    if (index === -1) return;
    const objective = objectives[index];
    if (objective.status !== "active") return;

    let progress =
      typeof to === "number" ? Math.max(0, to) : Math.max(0, objective.progress + by);
    let nextStatus: ObjectiveStatus = objective.status;
    if (typeof objective.count === "number" && progress >= objective.count) {
      progress = objective.count;
      nextStatus = "done";
    }

    const updated: Objective = { ...objective, progress, status: nextStatus };
    objectives = objectives.map((o, i) => (i === index ? updated : o));
    changed = true;
  };

  const setObjective = (id: string, nextStatus: ObjectiveStatus): void => {
    if (!objectives.some((o) => o.id === id)) return;
    objectives = objectives.map((o) =>
      o.id === id ? { ...o, status: nextStatus } : o
    );
    changed = true;
  };

  const addObjective = (objective: Objective): void => {
    if (objectives.some((o) => o.id === objective.id)) return;
    objectives = [...objectives, objective];
    changed = true;
  };

  const applyDamage = (id: string | undefined, amount: number): void => {
    const player = entities.find((e) => e.kind === "player");
    const target = id ?? player?.id;
    if (
      target !== undefined &&
      target === player?.id &&
      typeof scratch.health === "number"
    ) {
      const next = (scratch.health as number) - amount;
      scratch = { ...scratch, health: next };
      if (next <= 0) status = "lost";
      changed = true;
      return;
    }
    const key = `damage.${target ?? "player"}`;
    const previous = typeof scratch[key] === "number" ? (scratch[key] as number) : 0;
    scratch = { ...scratch, [key]: previous + amount };
    changed = true;
  };

  const applyAction = (action: Action): void => {
    switch (action.type) {
      case "spawn":
        spawn(action.entity);
        break;
      case "despawn":
        despawn(action.entity);
        break;
      case "enable":
        setActive(action.entity, true);
        break;
      case "disable":
        setActive(action.entity, false);
        break;
      case "objectiveProgress":
        progressObjective(action.objective, action.by, action.to);
        break;
      case "setObjective":
        setObjective(action.objective, action.status);
        break;
      case "addObjective":
        addObjective(action.objective);
        break;
      case "setVar":
        scratch = { ...scratch, [action.key]: action.value };
        changed = true;
        break;
      case "incVar": {
        const previous =
          typeof scratch[action.key] === "number" ? (scratch[action.key] as number) : 0;
        scratch = { ...scratch, [action.key]: previous + action.by };
        changed = true;
        break;
      }
      case "teleport": {
        const position = [...action.position] as typeof action.position;
        updateRuntime(action.entity, { position });
        entities = entities.map((e) =>
          e.id === action.entity ? { ...e, position } : e
        );
        break;
      }
      case "playSound":
        break;
      case "showMessage":
        break;
      case "setEnemyState":
        updateRuntime(action.entity, { state: action.state });
        break;
      case "win":
        status = "won";
        changed = true;
        break;
      case "lose":
        status = "lost";
        changed = true;
        break;
      case "damage":
        applyDamage(action.entity, action.amount);
        break;
      case "openDoor": {
        const current = entityRuntime[action.entity];
        if (current) {
          const tags = current.tags.filter((t) => t !== "locked");
          if (!tags.includes("open")) tags.push("open");
          setActive(action.entity, true);
          updateRuntime(action.entity, { tags });
          entities = entities.map((e) =>
            e.id === action.entity ? { ...e, active: true, tags } : e
          );
        }
        break;
      }
      case "toggle": {
        const current = entityRuntime[action.target];
        if (current) setActive(action.target, !current.active);
        break;
      }
      case "setVisible":
        updateRuntime(action.entity, { visible: action.visible });
        break;
      case "setColor":
        updateRuntime(action.entity, { color: action.color });
        break;
      case "animate":
        animate(action);
        break;
      case "cameraFocus":
        ui = { ...ui, focus: action.entity };
        changed = true;
        break;
      case "showPanel":
        showPanel(action);
        break;
      case "hidePanel":
        hidePanel(action);
        break;
    }
  };

  const actions: Action[] = [];
  const rules = state.doc.rules;

  for (const event of events) {
    for (const rule of rules) {
      if (!matchesTrigger(rule.on, event, view())) continue;
      if (!evaluateCondition(rule.if, view())) continue;
      actions.push(...rule.then);
      for (const action of rule.then) applyAction(action);
    }
  }

  const nextState: GameState = changed
    ? { ...state, entities, entityRuntime, objectives, scratch, status, ui }
    : state;

  return { state: nextState, actions };
}
