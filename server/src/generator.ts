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
    world: { bounds: [20, 10, 20], terrain: { type: "flat", obstacles: [] } },
    entities: [
      { id: "player", kind: "player", position: [-12, 1, 0] },
      { id: "gem-1", kind: "collectible", name: "Cyan crystal", position: [-4, 1, 6], color: "cyan" },
      { id: "gem-1-zone", kind: "zone", name: "Cyan pickup zone", position: [-4, 1, 6], size: [3, 2, 3] },
      { id: "gem-2", kind: "collectible", name: "Magenta crystal", position: [4, 1, -6], color: "magenta" },
      { id: "gem-2-zone", kind: "zone", name: "Magenta pickup zone", position: [4, 1, -6], size: [3, 2, 3] },
      { id: "gem-3", kind: "collectible", name: "Yellow crystal", position: [10, 1, 8], color: "yellow" },
      { id: "gem-3-zone", kind: "zone", name: "Yellow pickup zone", position: [10, 1, 8], size: [3, 2, 3] },
    ],
    objectives: [
      {
        id: "collect-gems",
        type: "collect",
        description: "Collect all three crystals",
        targets: ["gem-1", "gem-2", "gem-3"],
        count: 3,
      },
    ],
    rules: [
      {
        id: "pick-up-gem-1",
        on: { event: "playerEnter", zone: "gem-1-zone" },
        then: [
          { type: "despawn", entity: "gem-1" },
          { type: "objectiveProgress", objective: "collect-gems", by: 1 },
        ],
      },
      {
        id: "pick-up-gem-2",
        on: { event: "playerEnter", zone: "gem-2-zone" },
        then: [
          { type: "despawn", entity: "gem-2" },
          { type: "objectiveProgress", objective: "collect-gems", by: 1 },
        ],
      },
      {
        id: "pick-up-gem-3",
        on: { event: "playerEnter", zone: "gem-3-zone" },
        then: [
          { type: "despawn", entity: "gem-3" },
          { type: "objectiveProgress", objective: "collect-gems", by: 1 },
        ],
      },
      {
        id: "win-on-collected",
        on: { event: "objectiveComplete", objective: "collect-gems" },
        then: [{ type: "win", message: "All crystals collected!" }],
      },
    ],
    scratch: { crystalsCollected: 0 },
  }),
  "puzzle-switch": example({
    version: "1.0.0",
    meta: { title: "Switch Chamber", archetype: "puzzle-switch", difficulty: 0.5 },
    world: {
      bounds: [20, 10, 20],
      lighting: "indoor",
      skybox: "lab",
      terrain: { type: "flat", obstacles: [] },
    },
    entities: [
      { id: "player", kind: "player", position: [0, 1, -10] },
      { id: "switch-a", kind: "interactable", name: "West switch", position: [-8, 1, 6] },
      { id: "switch-b", kind: "interactable", name: "Center switch", position: [0, 1, 8] },
      { id: "switch-c", kind: "interactable", name: "East switch", position: [8, 1, 6] },
      { id: "exit-door", kind: "exitDoor", name: "Vault door", position: [0, 1, 14], solid: true },
    ],
    objectives: [
      {
        id: "activate-switches",
        type: "activate",
        description: "Activate all three switches",
        targets: ["switch-a", "switch-b", "switch-c"],
        count: 3,
      },
    ],
    rules: [
      {
        id: "use-switch-a",
        on: { event: "interact", entity: "switch-a" },
        then: [
          { type: "objectiveProgress", objective: "activate-switches", by: 1 },
          { type: "showMessage", text: "The west switch clicks." },
        ],
      },
      {
        id: "use-switch-b",
        on: { event: "interact", entity: "switch-b" },
        then: [
          { type: "objectiveProgress", objective: "activate-switches", by: 1 },
          { type: "showMessage", text: "The center switch clicks." },
        ],
      },
      {
        id: "use-switch-c",
        on: { event: "interact", entity: "switch-c" },
        then: [
          { type: "objectiveProgress", objective: "activate-switches", by: 1 },
          { type: "showMessage", text: "The east switch clicks." },
        ],
      },
      {
        id: "open-exit",
        on: { event: "objectiveComplete", objective: "activate-switches" },
        then: [
          { type: "openDoor", entity: "exit-door" },
          { type: "win", message: "The vault door opens!" },
        ],
      },
    ],
    scratch: { switchesActive: 0 },
  }),
  "platformer-lite": example({
    version: "1.0.0",
    meta: { title: "Sky Steps", archetype: "platformer-lite", difficulty: 0.5 },
    world: { bounds: [16, 12, 16], gravity: 14, terrain: { type: "flat", obstacles: [] } },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      {
        id: "platform-1",
        kind: "platform",
        name: "Stone step",
        position: [3, 2, 0],
        size: [2, 0.5, 2],
        solid: true,
      },
      {
        id: "platform-2",
        kind: "platform",
        name: "Stone step",
        position: [6, 3.5, 0],
        size: [2, 0.5, 2],
        solid: true,
      },
      {
        id: "goal-platform",
        kind: "platform",
        name: "Summit",
        position: [9, 5, 0],
        size: [2, 0.5, 2],
        solid: true,
      },
      { id: "goal-zone", kind: "zone", name: "Summit goal", position: [9, 6, 0], size: [2, 2, 2] },
    ],
    objectives: [
      {
        id: "reach-goal",
        type: "reach",
        description: "Reach the summit platform",
        target: "goal-zone",
        count: 1,
      },
    ],
    rules: [
      {
        id: "step-on-summit",
        on: { event: "playerEnter", zone: "goal-zone" },
        then: [{ type: "objectiveProgress", objective: "reach-goal", by: 1 }],
      },
      {
        id: "win-at-summit",
        on: { event: "objectiveComplete", objective: "reach-goal" },
        then: [{ type: "win", message: "To the summit!" }],
      },
    ],
    scratch: {},
  }),
  "stealth-chase": example({
    version: "1.0.0",
    meta: { title: "Shadow Patrol", archetype: "stealth-chase", difficulty: 0.6 },
    world: { bounds: [20, 8, 20], lighting: "night", skybox: "cave", terrain: { type: "flat", obstacles: [] } },
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
      { id: "exit-zone", kind: "zone", name: "Shadowed exit", position: [-10, 1, 8], size: [3, 2, 3] },
    ],
    objectives: [
      {
        id: "sneak-out",
        type: "reach",
        description: "Reach the exit unseen",
        target: "exit-zone",
        count: 1,
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
        id: "reach-exit",
        on: { event: "playerEnter", zone: "exit-zone" },
        then: [{ type: "objectiveProgress", objective: "sneak-out", by: 1 }],
      },
      {
        id: "escaped",
        on: { event: "objectiveComplete", objective: "sneak-out" },
        then: [{ type: "win", message: "Vanished into the dark." }],
      },
    ],
    scratch: {},
  }),
  explore: example({
    version: "1.0.0",
    meta: { title: "Campfire Clearing", archetype: "explore", genre: "ambient", difficulty: 0 },
    world: {
      bounds: [24, 10, 24],
      lighting: "dusk",
      skybox: "outdoor",
      terrain: { type: "flat", obstacles: [] },
    },
    entities: [
      { id: "player", kind: "player", name: "Wanderer", position: [0, 1, 0] },
      {
        id: "campfire",
        kind: "prop",
        name: "Crackling campfire",
        position: [4, 0.5, 3],
        size: [1.5, 1, 1.5],
        color: "orange",
      },
      {
        id: "log-bench",
        kind: "prop",
        name: "Fallen log bench",
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
        color: "yellow",
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
        then: [
          { type: "showMessage", text: "The sign reads: rest here as long as you like." },
        ],
      },
    ],
    scratch: {},
  }),
};

export function buildGenerationPrompt(prompt: string, archetype: Archetype): string {
  const isExplore = archetype === "explore";
  return [
    isExplore
      ? `Design a complete, explorable 3D scene that fits the "${archetype}" archetype.`
      : `Design a complete, playable game that fits the "${archetype}" archetype.`,
    isExplore
      ? "It uses the same JSON document shape but has NO objectives and no win or lose"
      : "",
    isExplore ? "condition: the player simply roams a small, atmospheric place." : "",
    "",
    "Respond with ONLY one JSON object - no markdown fences, no commentary -",
    "with exactly this shape:",
    `- "version": "${SCHEMA_VERSION}" (exact string)`,
    '- "meta": { "title": non-empty string, "archetype": the archetype above',
    '  (exact string), optional "genre" string, optional "difficulty" 0..1,',
    '  optional "seed" integer }',
    '- "world": { "bounds": [x, y, z] positive numbers; optional "lighting"',
    '  (dawn|day|dusk|night|indoor); optional "skybox" (cave|outdoor|lab);',
    '  optional "gravity" number; optional "terrain": { "type": flat|mesh,',
    '  "obstacles": [ { "position": [x,y,z], "size": [x,y,z] } ] } }',
    '- "entities": non-empty array. Each entity needs a unique non-empty "id",',
    '  a "kind" (player|enemy|collectible|zone|interactable|prop|exitDoor|platform|beam|spawn),',
    '  and a "position" [x,y,z]. Optional: "name", "rotation", "scale", "size",',
    '  "color", "solid", "speed", "patrol", "sight", "state", "props", "tags".',
    '  "state" may only be "idle" | "patrol" | "chase" | "return"; never invent',
    '  other state names. Exactly one entity must have kind "player".',
    '- "objectives": array of { "id", "type" (collect|reach|survive|avoid|activate|timeLimit),',
    '  optional "description"; for reach/collect/activate include "target" or',
    '  "targets" AND "count" (the number of progress steps needed to finish it:',
    "  1 for a single reach zone, one per collectible or switch otherwise).",
    '  "progress" defaults to 0 and "status" defaults to "active" }',
    isExplore
      ? '  For the "explore" archetype this array MUST be empty: []'
      : "",
    '- "rules": array of { "id", "on": { "event": ... }, optional "if", "then": [...] }',
    '- "scratch": object of string|number|boolean values (may be empty)',
    "",
    "Rule triggers - use only these (the engine emits them):",
    '  {"event":"playerEnter","zone":"<zone-id>"}   fired when the player enters a zone',
    '  {"event":"interact","entity":"<id>"}         fired when the player presses interact near the entity',
    '  {"event":"enemyContact","entity":"<enemy-id>"}',
    '  {"event":"objectiveProgress"|"objectiveComplete"|"objectiveFailed","objective":"<objective-id>"}',
    '  {"event":"playerDeath"} / {"event":"tick"}',
    '  "on.zone", "on.entity", "on.objective", "on.tag" are optional extra filters;',
    "  every id they name must exist in the document.",
    "",
    'Conditions - the optional "if" field must be exactly one of these shapes:',
    '  { "op": "and", "conditions": [ condition, ... ] }',
    '  { "op": "or", "conditions": [ condition, ... ] }',
    '  { "op": "not", "condition": condition }',
    '  { "op": "has", "entity": "<entity-id>" }',
    '  { "op": "hasTag", "tag": "<tag>" }',
    '  { "op": "<"|"<="|">"|">="|"=="|"!=", "left": value, "right": value }',
    '  where value is a number, string, boolean, { "var": "<scratch-key>" }, or',
    '  { "stat": "time"|"ticks"|"entityCount"|"objectiveCount"|"objective.<objective-id>.progress" }.',
    '  Never write a bare object like { "entity": "beam-1" } as a condition;',
    '  test an entity with { "op": "has", "entity": "beam-1" } or omit "if".',
    "",
    'Actions - every entry of "then" must be exactly one of these:',
    '  { "type": "win", "message": "..." } / { "type": "lose", "message": "..." }',
    '  { "type": "showMessage", "text": "..." }  (the field is "text", never "message")',
    '  { "type": "objectiveProgress", "objective": "<objective-id>", "by": 1 }',
    '  { "type": "setObjective", "objective": "<objective-id>", "status": "active"|"done"|"failed" }',
    '  { "type": "setVar", "key": "<name>", "value": number|string|boolean }',
    '  { "type": "incVar", "key": "<name>", "by": 1 }',
    '  { "type": "despawn"|"enable"|"disable"|"openDoor", "entity": "<entity-id>" }',
    '  { "type": "toggle", "target": "<entity-id>" }',
    '  { "type": "teleport", "entity": "<entity-id>", "position": [x,y,z] }',
    '  { "type": "setEnemyState", "entity": "<entity-id>", "state": "idle"|"patrol"|"chase"|"return" }',
    '  { "type": "playSound", "sound": "<name>" }',
    '  { "type": "damage", "entity": "<entity-id>", "amount": 1 }',
    '  { "type": "spawn", "entity": { ...full entity object... } }',
    '  Never invent action types (no "stateChange") and never use an event name as an action.',
    "",
    ...(isExplore
      ? [
          "Free-roam scene requirements (explore archetype):",
          '- "objectives" MUST be an empty array: []. There is no win or lose condition;',
          "  never emit win/lose actions and never reference objectives in rules.",
          '- Populate the scene with a player spawn, a few decorative props (kind "prop"',
          '  with "color" and/or "size"), and a couple of interactables (kind',
          '  "interactable"). An NPC-like enemy is allowed, but only with "state":',
          '  "idle" and no "sight" so it never chases or harms the player.',
          "- Ambient rules are optional and may only use showMessage, playSound, setVar",
          "  or incVar; every id they reference must exist in the document.",
          "- Keep the ground walkable: flat terrain with no obstacles unless the prompt",
          "  explicitly asks for them.",
        ]
      : [
          "Winnability - required, because objectives never advance on their own:",
          "- Walking over a collectible picks nothing up. For every collect target, add a",
          '  trigger zone (kind "zone") at the same position and one rule that fires on',
          '  {"event":"playerEnter","zone":"<zone-id>"}, despawns the collectible, and',
          "  calls objectiveProgress for that objective.",
          "- For every activate target, add one rule that fires on",
          '  {"event":"interact","entity":"<target-id>"} and calls objectiveProgress.',
          "- For every reach target, add one rule on playerEnter for the destination zone",
          "  that calls objectiveProgress.",
          "- Progress each step exactly once; never reuse one rule to advance two targets.",
          '- Finish every objective with a rule on {"event":"objectiveComplete",',
          '  "objective":"<objective-id>"} whose actions include {"type":"win",...}.',
          "- The game must be winnable through its rules alone.",
        ]),
    "",
    "Layout - open ground:",
    "- Every position and patrol point must lie inside world.bounds.",
    '- Unless the user explicitly asks for obstacles or cover, use "terrain": { "type": "flat", "obstacles": [] }.',
    ...(isExplore
      ? [
          "- If obstacles are requested, keep the spawn area and the paths between points",
          "  of interest clear so the whole scene stays walkable.",
        ]
      : [
          "- If obstacles are requested, keep them well clear of the straight line between",
          "  the player spawn and every objective target; targets must be reachable on foot.",
        ]),
    "",
    `Few-shot example for the "${archetype}" archetype`,
    "(structure and quality target - do not copy verbatim):",
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
