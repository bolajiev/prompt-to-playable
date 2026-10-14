import type {
  AnimationKind,
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

/**
 * Live animation entry owned by the engine. `elapsed` is seconds since the
 * entry was created; `basePos` / `baseRot` are snapshotted at creation so
 * every tick derives an absolute pose from a stable anchor. `pulse` is
 * derived state (0..1) exposed for the renderer.
 */
export interface AnimationRuntime {
  kind: AnimationKind;
  axis?: Vec3;
  amplitude?: number;
  speed?: number;
  to?: Vec3;
  duration?: number;
  elapsed: number;
  basePos: Vec3;
  baseRot: Vec3;
  pulse?: number;
}

export interface EntityRuntime {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  rotation?: Vec3;
  active: boolean;
  state?: EnemyState;
  waypointIndex?: number;
  contactArmed?: boolean;
  tags: string[];
  visible: boolean;
  color?: string;
  speed?: number;
  heading?: number;
  animations: AnimationRuntime[];
}

export interface PanelState {
  id: string;
  title: string;
  body: string;
  entity?: string;
}

export interface GameUiState {
  panels: PanelState[];
  focus?: string;
  nextPanelId: number;
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
  ui: GameUiState;
}

export const DEFAULT_SEED = 123456789;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Single source of truth for runtime initialization: used by `createState`
 * and by the rules `spawn` action so spawned entities get the exact same
 * shape. Always returns fresh arrays.
 */
export function createEntityRuntime(entity: Entity): EntityRuntime {
  return {
    position: [...entity.position] as Vec3,
    velocity: [0, 0, 0] as Vec3,
    grounded: false,
    rotation: entity.rotation ? ([...entity.rotation] as Vec3) : undefined,
    active: entity.active,
    state: entity.state,
    waypointIndex: 0,
    contactArmed: true,
    tags: [...entity.tags],
    visible: true,
    animations: [],
  };
}

export function createState(doc: GameDoc, seed?: number): GameState {
  const gameDoc = clone(doc);
  const resolvedSeed = seed ?? gameDoc.meta.seed ?? DEFAULT_SEED;

  const entityRuntime: Record<string, EntityRuntime> = {};
  for (const entity of gameDoc.entities) {
    entityRuntime[entity.id] = createEntityRuntime(entity);
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
    ui: { panels: [], nextPanelId: 0 },
  };
}
