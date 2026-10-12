import type { GameDoc } from "@prompt-to-playable/schema";
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

export class Engine {
  readonly fixedDtMs: number;
  readonly maxSubSteps: number;

  private state: GameState | null = null;
  private accumulator = 0;

  constructor(options: EngineOptions = {}) {
    this.fixedDtMs = options.fixedDtMs ?? FIXED_DT_MS;
    this.maxSubSteps = options.maxSubSteps ?? DEFAULT_MAX_SUB_STEPS;
  }

  load(doc: GameDoc, seed?: number): GameState {
    this.state = createState(doc, seed);
    this.accumulator = 0;
    return this.state;
  }

  getState(): GameState {
    if (!this.state) {
      throw new Error("Engine has no loaded game state; call load() first");
    }
    return this.state;
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
      this.state = tick(this.state, this.fixedDtMs / 1000, input);
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
