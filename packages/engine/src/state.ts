import type {
  EnemyState,
  Entity,
  GameDoc,
  Objective,
  ScratchValue,
  Vec3,
} from "@prompt-to-playable/schema";
import { SeededRng } from "@prompt-to-playable/shared";
import type { GameEvent } from "./events.js";
import { NEUTRAL_INPUT, type InputState } from "./input.js";

export type GameStatus = "running" | "won" | "lost";

export interface EntityRuntime {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  rotation?: Vec3;
  active: boolean;
  state?: EnemyState;
  tags: string[];
}

export interface GameState {
  doc: GameDoc;
  time: number;
  ticks: number;
  status: GameStatus;
  seed: number;
  rng: SeededRng;
  entities: Entity[];
  entityRuntime: Record<string, EntityRuntime>;
  objectives: Objective[];
  scratch: Record<string, ScratchValue>;
  flags: Record<string, boolean>;
  events: GameEvent[];
  input: InputState;
  prevInput: InputState;
}

export const DEFAULT_SEED = 123456789;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createState(doc: GameDoc, seed?: number): GameState {
  const gameDoc = clone(doc);
  const resolvedSeed = seed ?? gameDoc.meta.seed ?? DEFAULT_SEED;

  const entityRuntime: Record<string, EntityRuntime> = {};
  for (const entity of gameDoc.entities) {
    entityRuntime[entity.id] = {
      position: [...entity.position] as Vec3,
      velocity: [0, 0, 0] as Vec3,
      grounded: false,
      rotation: entity.rotation ? ([...entity.rotation] as Vec3) : undefined,
      active: entity.active,
      state: entity.state,
      tags: [...entity.tags],
    };
  }

  return {
    doc: gameDoc,
    time: 0,
    ticks: 0,
    status: "running",
    seed: resolvedSeed,
    rng: new SeededRng(resolvedSeed),
    entities: gameDoc.entities,
    entityRuntime,
    objectives: gameDoc.objectives,
    scratch: { ...gameDoc.scratch },
    flags: {},
    events: [],
    input: { ...NEUTRAL_INPUT },
    prevInput: { ...NEUTRAL_INPUT },
  };
}
