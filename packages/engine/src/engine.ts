import type { GameDoc, GameMode } from "@prompt-to-playable/schema";
import type { ExternalEvent } from "./events.js";
import { NEUTRAL_INPUT, type InputState } from "./input.js";
import { createState, type GameState } from "./state.js";
import { tick } from "./tick.js";

export const FIXED_DT_MS = 16.666;
export const FIXED_DT_SECONDS = FIXED_DT_MS / 1000;
export const DEFAULT_MAX_SUB_STEPS = 5;

export interface EngineOptions {
  fixedDtMs?: number;
  maxSubSteps?: number;
}

/**
 * Effective kit/mode for a document: explicit `meta.mode` wins, otherwise
 * an `explore` archetype maps to explore and every other archetype to game.
 */
export function resolveMode(doc: GameDoc): GameMode {
  if (doc.meta.mode) return doc.meta.mode;
  return doc.meta.archetype === "explore" ? "explore" : "game";
}

export class Engine {
  readonly fixedDtMs: number;
  readonly maxSubSteps: number;

  private state: GameState | null = null;
  private accumulator = 0;
  private pendingEvents: ExternalEvent[] = [];

  constructor(options: EngineOptions = {}) {
    this.fixedDtMs = options.fixedDtMs ?? FIXED_DT_MS;
    this.maxSubSteps = options.maxSubSteps ?? DEFAULT_MAX_SUB_STEPS;
  }

  load(doc: GameDoc, seed?: number): GameState {
    this.state = createState(doc, seed);
    this.accumulator = 0;
    // Queued external events never leak across documents.
    this.pendingEvents = [];
    return this.state;
  }

  getState(): GameState {
    if (!this.state) {
      throw new Error("Engine has no loaded game state; call load() first");
    }
    return this.state;
  }

  /**
   * Queue an external event (click / hover edge). The queue is merged into
   * the event list of the first tick that runs on the next `step()` call, so
   * rules matching `trigger.entity === event.targetId` fire exactly once.
   */
  pushEvent(event: ExternalEvent): void {
    this.pendingEvents.push({ ...event });
  }

  /**
   * Remove a panel from `state.ui.panels` by id (panels UI close button).
   * No-op when the engine is not loaded or the id is unknown.
   */
  closePanel(id: string): void {
    const state = this.state;
    if (!state) return;
    if (!state.ui.panels.some((panel) => panel.id === id)) return;
    this.state = {
      ...state,
      ui: {
        ...state.ui,
        panels: state.ui.panels.filter((panel) => panel.id !== id),
      },
    };
  }

  step(dtMs: number, input: Partial<InputState> = NEUTRAL_INPUT): GameState {
    if (!this.state) {
      throw new Error("Engine has no loaded game state; call load() first");
    }

    if (this.state.status !== "running") {
      return this.state;
    }

    this.accumulator += dtMs;

    let steps = 0;
    while (this.accumulator >= this.fixedDtMs && steps < this.maxSubSteps) {
      this.state = tick(
        this.state,
        this.fixedDtMs / 1000,
        input,
        this.pendingEvents
      );
      this.pendingEvents = [];
      this.accumulator -= this.fixedDtMs;
      steps++;

      if (this.state.status !== "running") {
        this.accumulator = 0;
        break;
      }
    }

    if (this.accumulator >= this.fixedDtMs) {
      this.accumulator = 0;
    }

    return this.state;
  }
}

export function createEngine(options?: EngineOptions): Engine {
  return new Engine(options);
}
