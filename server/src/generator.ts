import { SCHEMA_VERSION, validateGame } from "@prompt-to-playable/schema";
import type { Archetype, GameDoc } from "@prompt-to-playable/schema";
import type { LlmCall } from "./llm.js";

function example(raw: Record<string, unknown>): GameDoc {
  const result = validateGame(raw);
  if (!result.ok || !result.data) {
    const detail = result.error
      ? result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")
      : "unknown error";
    throw new Error(`archetype example fails schema validation: ${detail}`);
  }
  return result.data;
}

export const ARCHETYPE_EXAMPLES: Record<Archetype, GameDoc> = {
  "collect-a-thon": example({
    version: "1.0.0",
    meta: { title: "Crystal Dash", archetype: "collect-a-thon", difficulty: 0.4 },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "gem1", kind: "collectible", name: "Cyan crystal", position: [4, 1, 2], color: "cyan" },
      { id: "gem2", kind: "collectible", name: "Magenta crystal", position: [-5, 1, 3], color: "magenta" },
      { id: "gem3", kind: "collectible", name: "Yellow crystal", position: [2, 1, -6], color: "yellow" },
    ],
    objectives: [
      {
        id: "collect-gems",
        type: "collect",
        description: "Collect all three crystals",
        targets: ["gem1", "gem2", "gem3"],
        count: 3,
      },
    ],
    rules: [
      {
        id: "win-on-collected",
        on: { event: "objectiveComplete", objective: "collect-gems" },
        then: [{ type: "win", message: "All crystals collected!" }],
      },
    ],
    scratch: {},
  }),
  "puzzle-switch": example({
    version: "1.0.0",
    meta: { title: "Switch Chamber", archetype: "puzzle-switch", difficulty: 0.5 },
    world: { bounds: [20, 10, 20] },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "switch-a", kind: "interactable", name: "Pressure switch", position: [5, 1, 0] },
      { id: "door", kind: "exitDoor", name: "Sealed door", position: [8, 1, 0], solid: true },
      { id: "exit-pad", kind: "zone", name: "Exit pad", position: [12, 1, 0] },
    ],
    objectives: [
      {
        id: "open-exit",
        type: "activate",
        description: "Activate the switch to open the door",
        target: "switch-a",
      },
    ],
    rules: [
      {
        id: "switch-opens-door",
        on: { event: "interact", entity: "switch-a" },
        then: [
          { type: "openDoor", entity: "door" },
          { type: "objectiveProgress", objective: "open-exit", by: 1 },
        ],
      },
      {
        id: "enter-exit-wins",
        on: { event: "playerEnter", zone: "exit-pad" },
        then: [{ type: "win", message: "Escaped the chamber!" }],
      },
    ],
    scratch: {},
  }),
  "platformer-lite": example({
    version: "1.0.0",
    meta: { title: "Sky Steps", archetype: "platformer-lite", difficulty: 0.5 },
    world: { bounds: [16, 12, 16], gravity: 14 },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      { id: "platform-1", kind: "platform", name: "Stone step", position: [3, 2, 0], size: [2, 0.5, 2], solid: true },
      { id: "platform-2", kind: "platform", name: "Stone step", position: [6, 3.5, 0], size: [2, 0.5, 2], solid: true },
      { id: "goal-platform", kind: "platform", name: "Summit", position: [9, 5, 0], size: [2, 0.5, 2], solid: true },
    ],
    objectives: [
      {
        id: "reach-goal",
        type: "reach",
        description: "Reach the summit platform",
        target: "goal-platform",
      },
    ],
    rules: [
      {
        id: "win-on-reach",
        on: { event: "objectiveComplete", objective: "reach-goal" },
        then: [{ type: "win", message: "To the summit!" }],
      },
    ],
    scratch: {},
  }),
  "stealth-chase": example({
    version: "1.0.0",
    meta: { title: "Shadow Patrol", archetype: "stealth-chase", difficulty: 0.6 },
    world: { bounds: [20, 8, 20], lighting: "night", skybox: "cave" },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
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
      { id: "exit-zone", kind: "zone", name: "Shadowed exit", position: [-10, 1, 0] },
      { id: "crate", kind: "prop", name: "Cover crate", position: [3, 0.5, 3], size: [1, 1, 1], solid: true },
    ],
    objectives: [
      {
        id: "sneak-out",
        type: "reach",
        description: "Reach the exit unseen",
        target: "exit-zone",
      },
      {
        id: "survive-patrol",
        type: "survive",
        description: "Stay hidden while the guard patrols",
        time: 20,
      },
    ],
    rules: [
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
    scratch: {},
  }),
};

export function buildGenerationPrompt(prompt: string, archetype: Archetype): string {
  return [
    `Design a complete, playable game that fits the "${archetype}" archetype.`,
    "",
    "Respond with ONLY one JSON object — no markdown fences, no commentary —",
    "with exactly this shape:",
    `- "version": "${SCHEMA_VERSION}" (exact string)`,
    '- "meta": { "title": non-empty string, "archetype": the archetype above',
    '  (exact string), optional "genre" string, optional "difficulty" 0..1,',
    '  optional "seed" integer }',
    '- "world": { "bounds": [x, y, z] positive numbers, optional "lighting"',
    "  (dawn|day|dusk|night|indoor), optional \"skybox\" (cave|outdoor|lab),",
    '  optional "gravity" number, optional "terrain": { "type": flat|mesh,',
    '  "obstacles": [ { "position": [x,y,z], "size": [x,y,z] } ] } }',
    '- "entities": non-empty array. Each entity needs a unique non-empty "id",',
    '  a "kind" (player|enemy|collectible|zone|interactable|prop|exitDoor|platform|beam|spawn),',
    '  and a "position" [x,y,z]. Optional: "name", "rotation", "scale", "size",',
    '  "color", "solid", "speed", "patrol", "sight", "state", "props".',
    '  "tags" defaults to [] and "active" defaults to true. Exactly one entity',
    '  must have kind "player".',
    '- "objectives": array of { "id", "type" (collect|reach|survive|avoid|activate|timeLimit),',
    '  optional "description", "target", "targets", "count", "time";',
    '  "progress" defaults to 0 and "status" defaults to "active" }',
    '- "rules": array of { "id", "on": { "event": one of playerEnter,',
    "  objectiveProgress, objectiveComplete, objectiveFailed, timer, enemyContact,",
    "  interact, itemPickup, stateChange, playerDeath, tick; optional",
    '  "zone", "entity", "objective", "tag" }, optional "if" condition,',
    '  "then": non-empty action array (openDoor, despawn, enable, disable,',
    "  objectiveProgress, setObjective, win, lose, showMessage, ... as needed) }",
    '- "scratch": object of string|number|boolean values (may be empty)',
    "",
    "Constraints:",
    "- Every position and patrol point must lie inside world.bounds.",
    '- Every entity/objective id referenced by objectives or rules must exist.',
    "- Reach/collect targets must be reachable from the player spawn.",
    "- The game must be winnable through its rules.",
    "",
    `Few-shot example for the "${archetype}" archetype`,
    "(structure and quality target — do not copy verbatim):",
    JSON.stringify(ARCHETYPE_EXAMPLES[archetype], null, 2),
    "",
    `Player prompt: ${prompt}`,
    "",
    "Return JSON:",
  ].join("\n");
}

export function parseGameDoc(raw: string): GameDoc {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("generator response contained no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`generator response was not valid JSON: ${message}`);
  }
  return parsed as GameDoc;
}

export async function generate(
  prompt: string,
  archetype: Archetype,
  llm: LlmCall
): Promise<GameDoc> {
  const raw = await llm(buildGenerationPrompt(prompt, archetype));
  return parseGameDoc(raw);
}
