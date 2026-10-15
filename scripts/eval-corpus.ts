import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateGame } from "@prompt-to-playable/schema";
import type { Archetype, GameMode, Vec3 } from "@prompt-to-playable/schema";
import type { LlmCall } from "../server/src/llm.js";
import {
  isDrivePrompt,
  isExplorePrompt,
  isInspectPrompt,
  isMachinePrompt,
  isWalkthroughPrompt,
} from "../server/src/classifier.js";
import type { KitArchetype } from "../server/src/classifier.js";
import {
  createDefaultPipelineDeps,
  generateGame,
} from "../server/src/pipeline.js";
import type { GenerationPipelineDeps } from "../server/src/pipeline.js";
import { hasWinPath, requiresWinPath, sanityCheck } from "../server/src/sanity.js";
import { validateDoc } from "../server/src/validate.js";

export { hasWinPath };

export const DEFAULT_THRESHOLD = 0.95;
export const MIN_CORPUS_SIZE = 20;

export interface CorpusEntry {
  id: string;
  prompt: string;
  archetype: KitArchetype;
  title: string;
}

export interface Corpus {
  target: number;
  entries: CorpusEntry[];
}

export interface PromptOutcome {
  id: string;
  prompt: string;
  archetype: KitArchetype;
  valid: boolean;
  solvable: boolean;
  repairs: number;
  error?: string;
}

export interface CorpusSummary {
  total: number;
  valid: number;
  solvable: number;
  usable: number;
  validPct: number;
  solvablePct: number;
  usablePct: number;
  threshold: number;
  passed: boolean;
}

export class EvalTargetError extends Error {
  readonly summary: CorpusSummary;

  constructor(summary: CorpusSummary) {
    super(
      `corpus eval below target: ${summary.usablePct.toFixed(1)}% valid+solvable ` +
        `(< ${(summary.threshold * 100).toFixed(1)}%)`
    );
    this.name = "EvalTargetError";
    this.summary = summary;
  }
}

const DEFAULT_CORPUS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "corpus.json"
);

const ARCHETYPE_SET = new Set<KitArchetype>([
  "collect-a-thon",
  "puzzle-switch",
  "platformer-lite",
  "stealth-chase",
  "explore",
  "inspect",
  "walkthrough",
  "drive",
  "machine",
]);

function asArchetype(value: unknown, context: string): KitArchetype {
  if (typeof value === "string" && ARCHETYPE_SET.has(value as KitArchetype)) {
    return value as KitArchetype;
  }
  throw new Error(`corpus entry ${context} has invalid archetype: ${String(value)}`);
}

export function parseCorpus(raw: unknown): Corpus {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("corpus must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const prompts = record.prompts;
  if (!Array.isArray(prompts)) {
    throw new Error("corpus.prompts must be an array");
  }
  const entries: CorpusEntry[] = prompts.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`corpus.prompts[${index}] must be an object`);
    }
    const entry = item as Record<string, unknown>;
    const id = entry.id;
    const prompt = entry.prompt;
    const title = entry.title;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`corpus.prompts[${index}].id must be a non-empty string`);
    }
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error(`corpus entry ${id} is missing a prompt`);
    }
    if (typeof title !== "string" || title.length === 0) {
      throw new Error(`corpus entry ${id} is missing a title`);
    }
    return {
      id,
      prompt,
      title,
      archetype: asArchetype(entry.archetype, id),
    };
  });
  if (entries.length < MIN_CORPUS_SIZE) {
    throw new Error(
      `corpus must contain at least ${MIN_CORPUS_SIZE} prompts (found ${entries.length})`
    );
  }
  const target =
    typeof record.target === "number" && record.target > 0 && record.target <= 1
      ? record.target
      : DEFAULT_THRESHOLD;
  return { target, entries };
}

export function loadCorpus(path: string = DEFAULT_CORPUS_PATH): Corpus {
  return parseCorpus(JSON.parse(readFileSync(path, "utf8")));
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

function countFrom(prompt: string, fallback: number): number {
  const digit = prompt.match(/\b(\d+)\b/);
  if (digit) return Number(digit[1]);
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(prompt)) return value;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const DIFFICULTY: Record<KitArchetype, number> = {
  "collect-a-thon": 0.4,
  "puzzle-switch": 0.5,
  "platformer-lite": 0.5,
  "stealth-chase": 0.6,
  explore: 0,
  inspect: 0,
  walkthrough: 0,
  drive: 0.6,
  machine: 0,
};

/** Schema archetype stored in meta.archetype for every classification label. */
const SCHEMA_ARCHETYPE: Record<KitArchetype, Archetype> = {
  "collect-a-thon": "collect-a-thon",
  "puzzle-switch": "puzzle-switch",
  "platformer-lite": "platformer-lite",
  "stealth-chase": "stealth-chase",
  explore: "explore",
  inspect: "explore",
  walkthrough: "explore",
  drive: "collect-a-thon",
  machine: "explore",
};

const KIT_MODE: Partial<Record<KitArchetype, GameMode>> = {
  inspect: "inspect",
  walkthrough: "walkthrough",
  drive: "drive",
  machine: "machine",
};

function metaOf(entry: CorpusEntry): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    title: entry.title,
    archetype: SCHEMA_ARCHETYPE[entry.archetype],
    difficulty: DIFFICULTY[entry.archetype],
    seed: hashSeed(entry.id),
  };
  const mode = KIT_MODE[entry.archetype];
  if (mode !== undefined) meta.mode = mode;
  return meta;
}

const COLLECT_POSITIONS: readonly Vec3[] = [
  [4, 1, 2],
  [-5, 1, 3],
  [2, 1, -6],
  [7, 1, 4],
  [-8, 1, -5],
  [6, 1, -7],
];

function collectDoc(entry: CorpusEntry): Record<string, unknown> {
  const count = clamp(countFrom(entry.prompt, 3), 1, COLLECT_POSITIONS.length);
  const collectibles: Array<Record<string, unknown>> = [];
  const zones: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];
  const targetIds: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const id = `crystal-${i + 1}`;
    const position = COLLECT_POSITIONS[i];
    targetIds.push(id);
    collectibles.push({
      id,
      kind: "collectible",
      name: `Crystal ${i + 1}`,
      position,
      color: "cyan",
    });
    zones.push({
      id: `pickup-${i + 1}`,
      kind: "zone",
      name: `Pickup ${i + 1}`,
      position,
      size: [2, 2, 2],
      tags: ["pickup"],
    });
    rules.push({
      id: `pickup-rule-${i + 1}`,
      on: { event: "playerEnter", zone: `pickup-${i + 1}` },
      then: [
        { type: "objectiveProgress", objective: "collect-crystals", by: 1 },
      ],
    });
  }

  const entities: Array<Record<string, unknown>> = [
    { id: "player", kind: "player", name: "Collector", position: [0, 1, 0] },
    ...collectibles,
    ...zones,
  ];

  if (/guard|enemy|robot|sentry|patrol|avoid/i.test(entry.prompt)) {
    entities.push({
      id: "guard-1",
      kind: "enemy",
      name: "Patrolling guard",
      position: [8, 1, 0],
      speed: 2,
      sight: 6,
      state: "patrol",
      patrol: [
        [8, 1, 0],
        [-8, 1, 0],
      ],
    });
  }

  rules.push({
    id: "collect-wins",
    on: { event: "objectiveComplete", objective: "collect-crystals" },
    then: [{ type: "win", message: "All crystals collected!" }],
  });

  return {
    version: "1.0.0",
    meta: metaOf(entry),
    world: { bounds: [20, 10, 20] },
    entities,
    objectives: [
      {
        id: "collect-crystals",
        type: "collect",
        description: `Collect ${count} crystals`,
        targets: targetIds,
        count,
      },
    ],
    rules,
    scratch: { promptId: entry.id },
  };
}

function puzzleDoc(entry: CorpusEntry): Record<string, unknown> {
  const entities: Array<Record<string, unknown>> = [
    { id: "player", kind: "player", name: "Tinkerer", position: [0, 1, 0] },
    {
      id: "switch-a",
      kind: "interactable",
      name: "Pressure switch",
      position: [5, 1, 0],
    },
    {
      id: "plate-1",
      kind: "zone",
      name: "Pressure plate",
      position: [5, 1, 0],
      size: [2, 2, 2],
      tags: ["switch"],
    },
    {
      id: "door",
      kind: "exitDoor",
      name: "Sealed door",
      position: [8, 1, 0],
      solid: true,
    },
    {
      id: "exit-pad",
      kind: "zone",
      name: "Exit pad",
      position: [12, 1, 0],
      size: [3, 2, 3],
    },
  ];

  if (/beam|mirror|laser|light|rotate/i.test(entry.prompt)) {
    const beamPositions: readonly Vec3[] = [
      [2, 1, -4],
      [2, 1, 0],
      [2, 1, 4],
    ];
    beamPositions.forEach((position, i) => {
      entities.push({
        id: `beam-${i + 1}`,
        kind: "beam",
        name: `Beam ${i + 1}`,
        position,
        rotation: [0, i * (Math.PI / 3), 0],
      });
    });
  }

  return {
    version: "1.0.0",
    meta: metaOf(entry),
    world: { bounds: [20, 10, 20], lighting: "indoor", skybox: "lab" },
    entities,
    objectives: [
      {
        id: "open-exit",
        type: "activate",
        description: "Activate the switch to open the door",
        target: "switch-a",
        count: 1,
      },
    ],
    rules: [
      {
        id: "plate-opens-door",
        on: { event: "playerEnter", zone: "plate-1" },
        then: [
          { type: "openDoor", entity: "door" },
          { type: "objectiveProgress", objective: "open-exit", by: 1 },
        ],
      },
      {
        id: "open-wins",
        on: { event: "objectiveComplete", objective: "open-exit" },
        then: [{ type: "win", message: "The sealed door grinds open." }],
      },
      {
        id: "exit-wins",
        on: { event: "playerEnter", zone: "exit-pad" },
        then: [{ type: "win", message: "Escaped the chamber!" }],
      },
    ],
    scratch: { promptId: entry.id },
  };
}

const LEDGES: readonly Vec3[] = [
  [3, 2, 0],
  [6, 3.5, 0],
  [9, 5, 0],
  [12, 6.5, 0],
];

function platformerDoc(entry: CorpusEntry): Record<string, unknown> {
  const entities: Array<Record<string, unknown>> = [
    { id: "player", kind: "player", name: "Climber", position: [0, 1, 0] },
  ];
  LEDGES.forEach((position, i) => {
    entities.push({
      id: `platform-${i + 1}`,
      kind: "platform",
      name: `Step ${i + 1}`,
      position,
      size: [2, 0.5, 2],
      solid: true,
    });
  });
  const summit = LEDGES[LEDGES.length - 1];
  entities.push({
    id: "goal-pad",
    kind: "zone",
    name: "Summit pad",
    position: summit,
    size: [2, 2, 2],
  });

  const gravity = /low.?gravity/i.test(entry.prompt) ? 6 : 14;

  return {
    version: "1.0.0",
    meta: metaOf(entry),
    world: { bounds: [16, 12, 16], gravity },
    entities,
    objectives: [
      {
        id: "reach-goal",
        type: "reach",
        description: "Reach the summit pad",
        target: "goal-pad",
        count: 1,
      },
    ],
    rules: [
      {
        id: "goal-progress",
        on: { event: "playerEnter", zone: "goal-pad" },
        then: [{ type: "objectiveProgress", objective: "reach-goal", by: 1 }],
      },
      {
        id: "reach-wins",
        on: { event: "objectiveComplete", objective: "reach-goal" },
        then: [{ type: "win", message: "To the summit!" }],
      },
    ],
    scratch: { promptId: entry.id },
  };
}

function stealthDoc(entry: CorpusEntry): Record<string, unknown> {
  return {
    version: "1.0.0",
    meta: metaOf(entry),
    world: { bounds: [20, 8, 20], lighting: "night", skybox: "cave" },
    entities: [
      { id: "player", kind: "player", name: "Intruder", position: [0, 1, 0] },
      {
        id: "guard",
        kind: "enemy",
        name: "Patrolling guard",
        position: [8, 1, 0],
        speed: 2.5,
        sight: 6,
        state: "patrol",
        patrol: [
          [8, 1, 0],
          [-8, 1, 0],
        ],
      },
      {
        id: "exit-zone",
        kind: "zone",
        name: "Shadowed exit",
        position: [-10, 1, 0],
        size: [3, 2, 3],
      },
      {
        id: "crate",
        kind: "prop",
        name: "Cover crate",
        position: [3, 0.5, 3],
        size: [1, 1, 1],
        solid: true,
      },
    ],
    objectives: [
      {
        id: "sneak-out",
        type: "reach",
        description: "Reach the exit unseen",
        target: "exit-zone",
        count: 1,
      },
    ],
    rules: [
      {
        id: "exit-progress",
        on: { event: "playerEnter", zone: "exit-zone" },
        then: [{ type: "objectiveProgress", objective: "sneak-out", by: 1 }],
      },
      {
        id: "spotted",
        on: { event: "enemyContact", entity: "guard" },
        then: [{ type: "lose", message: "Spotted by the guard!" }],
      },
      {
        id: "escaped",
        on: { event: "objectiveComplete", objective: "sneak-out" },
        then: [{ type: "win", message: "Vanished into the dark." }],
      },
    ],
    scratch: { promptId: entry.id },
  };
}

function exploreDoc(entry: CorpusEntry): Record<string, unknown> {
  return {
    version: "1.0.0",
    meta: metaOf(entry),
    world: {
      bounds: [24, 10, 24],
      lighting: "dusk",
      skybox: "outdoor",
    },
    entities: [
      { id: "player", kind: "player", name: "Wanderer", position: [0, 1, 0] },
      {
        id: "campfire",
        kind: "prop",
        name: "Campfire",
        position: [4, 0.5, 3],
        size: [1.5, 1, 1.5],
        color: "orange",
      },
      {
        id: "bench",
        kind: "prop",
        name: "Fallen log",
        position: [6, 0.5, 5],
        size: [3, 1, 1],
        color: "saddlebrown",
      },
      {
        id: "signpost",
        kind: "interactable",
        name: "Weathered signpost",
        position: [-6, 1, 5],
      },
      {
        id: "firefly",
        kind: "enemy",
        name: "Drifting firefly",
        position: [8, 2, -6],
        speed: 1,
        state: "idle",
      },
      {
        id: "campfire-glow",
        kind: "zone",
        name: "Campfire glow",
        position: [4, 1, 3],
        size: [6, 3, 6],
      },
    ],
    objectives: [],
    rules: [
      {
        id: "greet-campfire",
        on: { event: "playerEnter", zone: "campfire-glow" },
        then: [
          { type: "showMessage", text: "The fire crackles. The clearing is calm." },
        ],
      },
      {
        id: "read-signpost",
        on: { event: "interact", entity: "signpost" },
        then: [{ type: "showMessage", text: "Rest here as long as you like." }],
      },
    ],
    scratch: { promptId: entry.id },
  };
}

function inspectDoc(entry: CorpusEntry): Record<string, unknown> {
  return {
    version: "1.0.0",
    meta: metaOf(entry),
    world: { bounds: [16, 10, 16], lighting: "indoor", skybox: "lab" },
    entities: [
      { id: "player", kind: "player", name: "Observer", position: [0, 4, 11] },
      {
        id: "mainboard",
        kind: "prop",
        name: "PCB mainboard",
        position: [0, 1.6, 0],
        size: [7, 0.4, 5],
        color: "#1b7a4f",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [7, 0.35, 5],
            color: "#1b7a4f",
            material: { roughness: 0.75, texture: "circuit" },
          },
        ],
        label: { text: "PCB-01 mainboard", offset: [0, 1.1, 0], size: 0.55 },
      },
      {
        id: "cpu-chip",
        kind: "prop",
        name: "CPU chip",
        position: [-1.8, 1.8, 0.4],
        size: [1.5, 0.6, 1.5],
        color: "#2f3640",
        parts: [
          {
            shape: "box",
            offset: [0, 0.2, 0],
            size: [1.5, 0.4, 1.5],
            color: "#2f3640",
            material: { metalness: 0.7, roughness: 0.35 },
          },
          {
            shape: "cylinder",
            offset: [0, 0.5, 0],
            size: [0.5, 0.08, 0.5],
            color: "#d4af37",
            material: { metalness: 0.9, roughness: 0.3 },
          },
        ],
        label: { text: "CPU-8 core", offset: [0, 1.1, 0], size: 0.5 },
      },
      {
        id: "power-connector",
        kind: "prop",
        name: "Power connector",
        position: [2.4, 2, -1.4],
        size: [1.6, 1, 1],
        color: "#e9c46a",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [1.6, 0.9, 1],
            color: "#e9c46a",
            material: { roughness: 0.6 },
          },
          {
            shape: "cylinder",
            offset: [0, 0.7, 0],
            size: [0.14, 0.9, 0.14],
            color: "#d4af37",
            material: { metalness: 0.95, roughness: 0.2 },
          },
        ],
        label: { text: "J1 power", offset: [0, 1.3, 0], size: 0.45 },
      },
    ],
    objectives: [],
    rules: [
      {
        id: "inspect-mainboard",
        on: { event: "click", entity: "mainboard" },
        then: [
          { type: "setColor", entity: "mainboard", color: "#35c98f" },
          {
            type: "showPanel",
            title: "PCB-01 mainboard",
            body: "The main circuit board. Click the CPU or the power connector too.",
            entity: "mainboard",
          },
        ],
      },
      {
        id: "inspect-cpu",
        on: { event: "click", entity: "cpu-chip" },
        then: [
          { type: "setColor", entity: "cpu-chip", color: "#4cc9f0" },
          {
            type: "showPanel",
            title: "CPU-8 core",
            body: "Eight cores under a gold lid.",
            entity: "cpu-chip",
          },
        ],
      },
    ],
    scratch: { promptId: entry.id },
  };
}

function walkthroughDoc(entry: CorpusEntry): Record<string, unknown> {
  return {
    version: "1.0.0",
    meta: metaOf(entry),
    world: { bounds: [18, 8, 18], lighting: "indoor", skybox: "outdoor" },
    entities: [
      { id: "player", kind: "player", name: "Visitor", position: [0, 1, 3] },
      {
        id: "cottage",
        kind: "prop",
        name: "Cottage shell",
        position: [0, 0, 0],
        size: [12, 5, 10],
        parts: [
          {
            shape: "box",
            offset: [0, -0.1, 0],
            size: [12, 0.2, 10],
            color: "#b08a5a",
            material: { roughness: 0.9, texture: "wood" },
          },
          {
            shape: "box",
            offset: [0, 2, -5],
            size: [12, 4, 0.2],
            color: "#f2e3c6",
            material: { roughness: 0.9, texture: "brick" },
          },
          {
            shape: "box",
            offset: [-6, 2, 0],
            size: [0.2, 4, 10],
            color: "#f2e3c6",
            material: { roughness: 0.9, texture: "brick" },
          },
          {
            shape: "box",
            offset: [6, 2, 0],
            size: [0.2, 4, 10],
            color: "#f2e3c6",
            material: { roughness: 0.9, texture: "brick" },
          },
          {
            shape: "box",
            offset: [-4, 2, 5],
            size: [4, 4, 0.2],
            color: "#f2e3c6",
            material: { roughness: 0.9, texture: "brick" },
          },
          {
            shape: "box",
            offset: [4, 2, 5],
            size: [4, 4, 0.2],
            color: "#f2e3c6",
            material: { roughness: 0.9, texture: "brick" },
          },
          {
            shape: "box",
            offset: [0, 4.2, 0],
            size: [12.6, 0.3, 10.6],
            color: "#8a5a44",
            material: { roughness: 0.85, texture: "wood" },
          },
        ],
      },
      {
        id: "front-door",
        kind: "interactable",
        name: "Front door",
        position: [0, 1.5, 5],
        size: [2, 3, 0.25],
        color: "#7b4b2a",
        props: { door: true, interactRange: 3.5 },
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [2, 3, 0.2],
            color: "#7b4b2a",
            material: { roughness: 0.8, texture: "wood" },
          },
        ],
        label: { text: "Front door", offset: [0, 2, 0], size: 0.45 },
      },
      {
        id: "floor-lamp",
        kind: "interactable",
        name: "Floor lamp",
        position: [-3, 1.5, 3.5],
        size: [1, 3, 1],
        props: { interactRange: 3.5 },
        parts: [
          {
            shape: "cylinder",
            offset: [0, 0, 0],
            size: [0.18, 3, 0.18],
            color: "#4a4a4a",
            material: { metalness: 0.6, roughness: 0.5 },
          },
          {
            shape: "cone",
            offset: [0, 1.7, 0],
            size: [1.2, 0.9, 1.2],
            color: "#f4d58d",
            material: { emissive: "#f4d58d" },
          },
        ],
        label: { text: "Floor lamp", offset: [0, 2.6, 0], size: 0.4 },
      },
      {
        id: "lamp-glow",
        kind: "prop",
        name: "Lamp glow",
        position: [-3, 3.4, 3.5],
        size: [0.7, 0.7, 0.7],
        color: "#ffe9a8",
        parts: [
          {
            shape: "sphere",
            offset: [0, 0, 0],
            size: [0.7, 0.7, 0.7],
            color: "#ffe9a8",
            material: { emissive: "#ffdf7e" },
          },
        ],
      },
      {
        id: "dining-table",
        kind: "prop",
        name: "Dining table",
        position: [2.5, 0.8, 0],
        size: [3, 1.6, 1.6],
        parts: [
          {
            shape: "box",
            offset: [0, 0.7, 0],
            size: [3, 0.15, 1.6],
            color: "#9c6b45",
            material: { roughness: 0.8, texture: "wood" },
          },
          {
            shape: "cylinder",
            offset: [-1.2, -0.1, -0.5],
            size: [0.15, 1.4, 0.15],
            color: "#7b4b2a",
          },
          {
            shape: "cylinder",
            offset: [1.2, -0.1, 0.5],
            size: [0.15, 1.4, 0.15],
            color: "#7b4b2a",
          },
        ],
      },
    ],
    objectives: [],
    rules: [
      {
        id: "open-front-door",
        on: { event: "interact", entity: "front-door" },
        then: [
          {
            type: "animate",
            entity: "front-door",
            kind: "slide",
            to: [2.1, 1.5, 5],
            duration: 900,
          },
          { type: "openDoor", entity: "front-door" },
        ],
      },
      {
        id: "lamp-off",
        on: { event: "interact", entity: "floor-lamp" },
        if: { op: "==", left: { var: "lampOn" }, right: 1 },
        then: [
          { type: "setVisible", entity: "lamp-glow", visible: false },
          { type: "setColor", entity: "floor-lamp", color: "#8d8d8d" },
          { type: "setVar", key: "lampOn", value: 0 },
        ],
      },
      {
        id: "lamp-on",
        on: { event: "interact", entity: "floor-lamp" },
        if: { op: "==", left: { var: "lampOn" }, right: 0 },
        then: [
          { type: "setVisible", entity: "lamp-glow", visible: true },
          { type: "setColor", entity: "floor-lamp", color: "#ffd166" },
          { type: "setVar", key: "lampOn", value: 1 },
        ],
      },
    ],
    scratch: { promptId: entry.id, lampOn: 1 },
  };
}

function driveDoc(entry: CorpusEntry): Record<string, unknown> {
  const checkpoints = [0, 1, 2, 3].map((index) => ({
    id: `checkpoint-${index + 1}`,
    kind: "zone",
    name: `Checkpoint ${index + 1}`,
    position: [0, 1, -12 + index * 8],
    size: [7, 3, 7],
    props: { checkpointIndex: index },
  }));
  return {
    version: "1.0.0",
    meta: metaOf(entry),
    world: { bounds: [40, 10, 40] },
    entities: [
      {
        id: "player",
        kind: "player",
        name: "Racer",
        position: [0, 1, -18],
        props: { vehicle: true, maxSpeed: 16, accel: 9 },
      },
      {
        id: "road",
        kind: "prop",
        name: "Asphalt road",
        position: [0, 0, 0],
        size: [11, 0.3, 40],
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [10, 0.2, 40],
            color: "#3c3f45",
            material: { roughness: 0.95, texture: "grid" },
          },
          {
            shape: "box",
            offset: [-5.3, 0.15, 0],
            size: [0.6, 0.3, 40],
            color: "#e8e2d0",
            material: { roughness: 0.8 },
          },
          {
            shape: "box",
            offset: [5.3, 0.15, 0],
            size: [0.6, 0.3, 40],
            color: "#e8e2d0",
            material: { roughness: 0.8 },
          },
        ],
      },
      ...checkpoints,
    ],
    objectives: [
      {
        id: "pass-checkpoints",
        type: "collect",
        description: "Pass all four checkpoints in order",
        targets: checkpoints.map((checkpoint) => checkpoint.id),
        count: 4,
      },
      {
        id: "beat-the-clock",
        type: "timeLimit",
        description: "Finish the race before the clock runs out",
        time: 90,
      },
    ],
    rules: [
      {
        id: "checkpoint-1",
        on: { event: "playerEnter", zone: "checkpoint-1" },
        then: [
          { type: "incVar", key: "cp" },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
          { type: "showMessage", text: "Checkpoint 1/4" },
        ],
      },
      {
        id: "checkpoint-2",
        on: { event: "playerEnter", zone: "checkpoint-2" },
        if: { op: "==", left: { var: "cp" }, right: 1 },
        then: [
          { type: "incVar", key: "cp" },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
          { type: "showMessage", text: "Checkpoint 2/4" },
        ],
      },
      {
        id: "checkpoint-3",
        on: { event: "playerEnter", zone: "checkpoint-3" },
        if: { op: "==", left: { var: "cp" }, right: 2 },
        then: [
          { type: "incVar", key: "cp" },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
          { type: "showMessage", text: "Checkpoint 3/4" },
        ],
      },
      {
        id: "checkpoint-4",
        on: { event: "playerEnter", zone: "checkpoint-4" },
        if: { op: "==", left: { var: "cp" }, right: 3 },
        then: [
          { type: "incVar", key: "cp" },
          { type: "setVar", key: "lap", value: 1 },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
          { type: "showMessage", text: "Lap complete!" },
        ],
      },
      {
        id: "race-won",
        on: { event: "objectiveComplete", objective: "pass-checkpoints" },
        then: [{ type: "win", message: "Checkered flag!" }],
      },
    ],
    scratch: { promptId: entry.id, cp: 0, lap: 0 },
  };
}

function machineDoc(entry: CorpusEntry): Record<string, unknown> {
  return {
    version: "1.0.0",
    meta: metaOf(entry),
    world: { bounds: [16, 10, 16], lighting: "indoor", skybox: "lab" },
    entities: [
      { id: "player", kind: "player", name: "Operator", position: [-12, 1, 0] },
      {
        id: "arm-base",
        kind: "prop",
        name: "Base turret",
        position: [0, 0.4, 0],
        size: [2.6, 0.8, 2.6],
        color: "#3a4048",
        parts: [
          {
            shape: "cylinder",
            offset: [0, 0, 0],
            size: [1, 1, 1],
            color: "#3a4048",
            material: { metalness: 0.7, roughness: 0.4 },
          },
        ],
        label: { text: "BASE", flat: true, offset: [0, 0.58, 0.5], size: 0.4 },
      },
      {
        id: "arm-link",
        kind: "prop",
        name: "Upper link",
        position: [0, 1.2, 0],
        size: [1.7, 1.1, 1.7],
        color: "#4cc9f0",
        parts: [
          {
            shape: "capsule",
            offset: [1, 0.05, 0],
            size: [0.3, 2.2, 0.3],
            rotation: [0, 0, 1.5708],
            color: "#4cc9f0",
            material: { metalness: 0.7, roughness: 0.3 },
          },
        ],
        label: { text: "SHOULDER", flat: true, offset: [1, 0.6, 0], size: 0.45 },
      },
    ],
    objectives: [],
    rules: [
      {
        id: "inspect-link",
        on: { event: "click", entity: "arm-link" },
        then: [
          { type: "cameraFocus", entity: "arm-link" },
          {
            type: "showPanel",
            title: "SHOULDER",
            body: "Lift servo that swings the whole upper link.",
            entity: "arm-link",
          },
          { type: "setVar", key: "focused", value: 1 },
        ],
      },
    ],
    controls: [
      {
        id: "shoulder",
        type: "slider",
        label: "Shoulder lift",
        min: -1,
        max: 1,
        step: 0.05,
        value: 0,
        bind: { entity: "arm-link", property: "rotation.z", scale: 1.2 },
      },
      {
        id: "grip",
        type: "toggle",
        label: "Grip open",
        value: 0,
        bind: { entity: "arm-link", property: "visible", var: "grip" },
      },
      {
        id: "wave",
        type: "button",
        label: "WAVE",
        bind: {
          onPress: [
            { type: "animate", entity: "arm-link", kind: "bob", amplitude: 0.2, speed: 1.5 },
            { type: "setVar", key: "waved", value: 1 },
          ],
        },
      },
    ],
    scratch: { promptId: entry.id, grip: 0 },
  };
}

export function buildDoc(entry: CorpusEntry): Record<string, unknown> {
  switch (entry.archetype) {
    case "collect-a-thon":
      return collectDoc(entry);
    case "puzzle-switch":
      return puzzleDoc(entry);
    case "platformer-lite":
      return platformerDoc(entry);
    case "stealth-chase":
      return stealthDoc(entry);
    case "explore":
      return exploreDoc(entry);
    case "inspect":
      return inspectDoc(entry);
    case "walkthrough":
      return walkthroughDoc(entry);
    case "drive":
      return driveDoc(entry);
    case "machine":
      return machineDoc(entry);
  }
}

const CLASSIFY_MARKER = "ONLY the archetype string";
const REPAIR_MARKER = "previously generated game document failed validation";
const REPAIR_DOC_START = "Failed document (for reference):";
const GENERATE_PROMPT_START = "Player prompt:";
const GENERATE_PROMPT_END = "\n\nReturn JSON:";

export function classifyByKeywords(prompt: string): KitArchetype {
  if (isMachinePrompt(prompt)) {
    return "machine";
  }
  if (isInspectPrompt(prompt)) {
    return "inspect";
  }
  if (isDrivePrompt(prompt)) {
    return "drive";
  }
  if (isWalkthroughPrompt(prompt)) {
    return "walkthrough";
  }
  if (/stealth|sneak|guard|patrol|searchlight|escape|evade|hide|sentry/i.test(prompt)) {
    return "stealth-chase";
  }
  if (/platform|jump|ledge|leap|climb|hop/i.test(prompt)) {
    return "platformer-lite";
  }
  if (/switch|puzzle|beam|mirror|lever|plate|pressure|rotate|light|crystal/i.test(prompt)) {
    return "puzzle-switch";
  }
  if (isExplorePrompt(prompt)) {
    return "explore";
  }
  return "collect-a-thon";
}

function sliceBetween(text: string, startMarker: string, endMarker: string): string | undefined {
  const start = text.indexOf(startMarker);
  if (start < 0) return undefined;
  const from = start + startMarker.length;
  const end = text.indexOf(endMarker, from);
  if (end < 0) return undefined;
  return text.slice(from, end).trim();
}

function parseReferenceDoc(prompt: string): Record<string, unknown> | undefined {
  const json = sliceBetween(prompt, REPAIR_DOC_START, "\n\nReturn corrected JSON:");
  if (!json || json.startsWith("(")) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Deterministic stand-in for a real LLM. It answers the classifier, generator,
 * and repair prompts using the corpus as its "knowledge":
 *  - known prompts get the archetype + a schema-valid, sane game document
 *  - unknown prompts intentionally fail so the harness reports them
 */
export function createCorpusLlm(corpus: readonly CorpusEntry[]): LlmCall {
  const byPrompt = new Map(corpus.map((entry) => [entry.prompt, entry]));

  return async (prompt: string): Promise<string> => {
    if (prompt.includes(CLASSIFY_MARKER)) {
      const gamePrompt = prompt.split("Game design prompt:").pop()?.trim() ?? "";
      const entry = byPrompt.get(gamePrompt);
      return entry ? entry.archetype : classifyByKeywords(gamePrompt);
    }

    if (prompt.includes(REPAIR_MARKER)) {
      const failed = parseReferenceDoc(prompt);
      const promptId = failed?.scratch;
      const id =
        typeof promptId === "object" && promptId !== null
          ? (promptId as Record<string, unknown>).promptId
          : undefined;
      const entry =
        typeof id === "string" ? corpus.find((item) => item.id === id) : undefined;
      if (!entry) {
        throw new Error(
          `mock LLM has no corpus coverage to repair document ${String(id)}`
        );
      }
      return JSON.stringify(buildDoc(entry));
    }

    const gamePrompt =
      sliceBetween(prompt, GENERATE_PROMPT_START, GENERATE_PROMPT_END)?.trim() ?? "";
    const entry = byPrompt.get(gamePrompt);
    if (!entry) {
      throw new Error(`mock LLM has no corpus coverage for prompt: "${gamePrompt}"`);
    }
    return JSON.stringify(buildDoc(entry));
  };
}

async function evaluateEntry(entry: CorpusEntry, llm: LlmCall): Promise<PromptOutcome> {
  let repairs = 0;
  const base = createDefaultPipelineDeps(llm);
  const deps: GenerationPipelineDeps = {
    ...base,
    repairer: (doc, errors, attempt) => {
      repairs += 1;
      return base.repairer(doc, errors, attempt);
    },
  };

  const fail = (error: string): PromptOutcome => ({
    id: entry.id,
    prompt: entry.prompt,
    archetype: entry.archetype,
    valid: false,
    solvable: false,
    repairs,
    error,
  });

  try {
    const doc = await generateGame(entry.prompt, deps);
    const validation = validateDoc(doc);
    if (!validation.ok || !validation.data) {
      return fail("pipeline output failed schema validation");
    }
    const data = validation.data;
    const sanity = sanityCheck(data);
    if (!sanity.ok) {
      return fail(`sanity: ${sanity.errors.map((issue) => issue.message).join("; ")}`);
    }
    if (requiresWinPath(data) && !hasWinPath(data)) {
      return fail("no rule wins the game");
    }
    return {
      id: entry.id,
      prompt: entry.prompt,
      archetype: entry.archetype,
      valid: true,
      solvable: true,
      repairs,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export interface EvaluateOptions {
  llm?: LlmCall;
}

export async function evaluatePrompts(
  entries: readonly CorpusEntry[],
  options: EvaluateOptions = {}
): Promise<PromptOutcome[]> {
  const llm = options.llm ?? createCorpusLlm(entries);
  const outcomes: PromptOutcome[] = [];
  for (const entry of entries) {
    outcomes.push(await evaluateEntry(entry, llm));
  }
  return outcomes;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : (count / total) * 100;
}

export function summarize(
  outcomes: readonly PromptOutcome[],
  threshold: number = DEFAULT_THRESHOLD
): CorpusSummary {
  const total = outcomes.length;
  const valid = outcomes.filter((outcome) => outcome.valid).length;
  const solvable = outcomes.filter((outcome) => outcome.solvable).length;
  const usable = outcomes.filter(
    (outcome) => outcome.valid && outcome.solvable
  ).length;
  const usablePct = ratio(usable, total);
  return {
    total,
    valid,
    solvable,
    usable,
    validPct: ratio(valid, total),
    solvablePct: ratio(solvable, total),
    usablePct,
    threshold,
    passed: total > 0 && usablePct >= threshold * 100 - 1e-9,
  };
}

export function assertTarget(
  summary: CorpusSummary,
  threshold: number = summary.threshold
): void {
  const effective: CorpusSummary =
    threshold === summary.threshold
      ? summary
      : { ...summary, threshold, passed: summary.usablePct >= threshold * 100 - 1e-9 };
  if (!effective.passed) throw new EvalTargetError(effective);
}

export function formatReport(
  outcomes: readonly PromptOutcome[],
  summary: CorpusSummary
): string {
  const width = outcomes.reduce((max, outcome) => Math.max(max, outcome.id.length), 0);
  const lines = outcomes.map((outcome) => {
    const verdict = outcome.valid && outcome.solvable ? "PASS" : "FAIL";
    const detail = outcome.error ? `  (${outcome.error})` : "";
    return (
      `${verdict}  ${outcome.id.padEnd(width)}  ` +
      `archetype=${outcome.archetype}  repairs=${outcome.repairs}${detail}`
    );
  });
  lines.push("");
  lines.push(`valid:          ${summary.valid}/${summary.total} (${summary.validPct.toFixed(1)}%)`);
  lines.push(`solvable:       ${summary.solvable}/${summary.total} (${summary.solvablePct.toFixed(1)}%)`);
  lines.push(
    `valid+solvable: ${summary.usable}/${summary.total} (${summary.usablePct.toFixed(1)}%) ` +
      `target >= ${(summary.threshold * 100).toFixed(1)}% -> ${summary.passed ? "PASS" : "FAIL"}`
  );
  return lines.join("\n");
}

export async function runCorpusEval(path: string = DEFAULT_CORPUS_PATH): Promise<{
  summary: CorpusSummary;
  outcomes: PromptOutcome[];
}> {
  const corpus = loadCorpus(path);
  const outcomes = await evaluatePrompts(corpus.entries);
  return { summary: summarize(outcomes, corpus.target), outcomes };
}

async function main(): Promise<void> {
  console.log("Prompt corpus eval (mocked LLM, deterministic)\n");
  let summary: CorpusSummary;
  let outcomes: PromptOutcome[];
  try {
    ({ summary, outcomes } = await runCorpusEval());
  } catch (error) {
    console.error(`corpus eval crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  console.log(formatReport(outcomes, summary));
  console.log("");
  try {
    assertTarget(summary);
    console.log("RESULT: PASS — corpus meets the valid+solvable target.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`RESULT: FAIL — ${message}`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main();
}
