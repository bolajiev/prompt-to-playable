import type { GameEvent } from "./events.js";
import type { GameState } from "./state.js";

export const SYSTEM_ORDER = [
  "integrate",
  "broadphase",
  "events",
  "rules",
  "objectives",
  "cleanup",
] as const;

export type SystemName = (typeof SYSTEM_ORDER)[number];

export function emitEvents(state: GameState): GameEvent[] {
  return [{ type: "tick" }];
}

export function tick(state: GameState, dt: number): GameState {
  let next: GameState = {
    ...state,
    time: state.time + dt,
    ticks: state.ticks + 1,
  };

  const events = emitEvents(next);
  next = { ...next, events };

  return next;
}
