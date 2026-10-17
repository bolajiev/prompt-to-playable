import { ArchetypeSchema } from "@prompt-to-playable/schema";
import type { Archetype } from "@prompt-to-playable/schema";
import type { LlmCall } from "./llm.js";

export const ARCHETYPES = ArchetypeSchema.options;
export const DEFAULT_ARCHETYPE: Archetype = "collect-a-thon";
export const EXPLORE_ARCHETYPE: Archetype = "explore";

/**
 * Every label the classifier may return: the five schema archetypes plus the
 * interactive kits. Kit labels are not schema archetypes - generated documents
 * carry them in `meta.mode` while `meta.archetype` stays a schema value
 * (inspect/walkthrough/machine/world -> "explore", drive -> "collect-a-thon").
 */
export const KIT_ARCHETYPES = [
  ...ARCHETYPES,
  "inspect",
  "walkthrough",
  "drive",
  "machine",
  "world",
] as const;
export type KitArchetype = (typeof KIT_ARCHETYPES)[number];

interface ArchetypeNorms {
  archetype: KitArchetype;
  spaced: string;
  compact: string;
}

const ARCHETYPE_NORMS: readonly ArchetypeNorms[] = KIT_ARCHETYPES.map(
  (archetype) => ({
    archetype,
    spaced: archetype.replace(/-/g, " "),
    compact: archetype.replace(/-/g, ""),
  })
);

/**
 * Goal language: any of these turns a prompt into a game brief. Prefix matching
 * is deliberate so "collecting", "guards", "platforming" and "switches" all
 * count as goals.
 */
const GOAL_PATTERN =
  /\b(collect|gather|pick|pickup|reach|escape|sneak|avoid|evade|defeat|fight|kill|destroy|activate|solve|puzzle|switch|platform|jump|find|rescue|deliver|survive|timer|exit|door|key|unlock|guard|enemy|chase|hunt|steal|defend|protect|race|score|win|objective|mission|quest|goal|task|retrieve|bring|carry|escort|catch|dodge|climb|leap|hop)/;

/**
 * Scene language: display verbs plus place/ambience nouns. A prompt that only
 * describes a place (and states no goal) is a free-roam "explore" scene.
 */
const SCENE_PATTERN =
  /\b(show|display|render|picture|image|scene|scenery|landscape|environment|setting|view|room|forest|clearing|meadow|campfire|museum|hall|gallery|city|street|alley|rooftop|park|beach|mountain|garden|village|marketplace|market|plaza|library|cafe|coffee|shop|cabin|lighthouse|temple|cave|lake|river|waterfall|desert|island|harbor|station|interior|bedroom|kitchen|tavern|inn|castle|ruins|valley|jungle|swamp|tundra|neon|sunset|sunrise|dusk|dawn|cozy|quiet|calm|peaceful|atmospheric|serene|beautiful)/;

/**
 * Inspect cues: clickable objects and technical subjects. A prompt about a PCB,
 * machine or product viewer is an inspect showcase even when it uses a word
 * such as "inspect" that also appears in goal language.
 */
const INSPECT_PATTERN =
  /\b(pcb|circuit|board|product|viewer|machine|engine|gadget|device|blueprint)\b/;

/**
 * Drive cues: any hint of a car, kart, race, lap or track. Deliberately does
 * not include "circuit" so "circuit board" stays an inspect prompt.
 */
const DRIVE_PATTERN = /\b(race|racing|track|car|kart|lap|rally|driving)\b/;

/**
 * Machine cues: a jointed mechanism the player drives with sliders, toggles
 * and buttons. "machine" is the generic cue; "engine", "gadget", "blueprint"
 * and the like stay with the inspect kit (see INSPECT_OBJECT_PATTERN).
 */
const MACHINE_PATTERN =
  /\b(robot|robotic|robotics|arm|machine|crane|conveyor|turret|joint|servo|manipulator|gantry)\b/;

/**
 * Technical-object cues that keep a prompt in the inspect kit even when it
 * names a machine. "a machine engine blueprint the user can study" is a
 * clickable study object, not a drivable machine.
 */
const INSPECT_OBJECT_PATTERN =
  /\b(pcb|circuit|board|blueprint|engine|gadget|device|product|viewer)\b/;

/**
 * Explicit walkthrough cues: movement language that only makes sense when the
 * user wants to walk around inside the place.
 */
const WALKTHROUGH_VERB_PATTERN =
  /\b(walk[- ]?through|walkthrough|first[- ]person|room tour|tour|interior|inside)\b/;

/**
 * Walkthrough places: dwelling nouns, including "museum". A bare place noun
 * that the explore lexicon already knows ("a museum hall with marble statues")
 * stays an explore scene; "museum" becomes a walkthrough when it is combined
 * with a walkthrough verb ("walk through the museum") or is not a known scene.
 */
const WALKTHROUGH_PLACE_PATTERN = /\b(house|home|building|apartment|villa|museum)\b/;

/**
 * World cues: an open, sandboxy place to roam - islands, cities, zoos, farms,
 * villages, parks - or explicit "explore freely" / build-request language.
 * "world" is deliberately generic; the more specific kits (machine, inspect,
 * drive, walkthrough) outrank it in `parseArchetype`.
 */
const WORLD_PATTERN =
  /\b(open[- ]world|sandbox|island|zoo|farm|village|park|world|explore freely|build me|create a)\b/;

/**
 * Quiet-scene cues: prompts that explicitly ask for a calm, small place keep
 * the static explore kit. Every other neutral scene prompt is free-form and
 * defaults to the interactive world kit.
 */
const QUIET_SCENE_PATTERN =
  /\b(quiet|calm|peaceful|clearing|forest|room|cozy)\b/;

/**
 * Deterministic scene detector used when the LLM answer cannot be parsed:
 * non-goal prompts that describe a place or use display language are scenes.
 * On its own this no longer implies the explore kit - `parseArchetype` sends
 * neutral scenes to the world kit and only quiet scenes to explore.
 */
export function isExplorePrompt(prompt: string): boolean {
  const text = (prompt ?? "").toLowerCase();
  if (GOAL_PATTERN.test(text)) return false;
  return SCENE_PATTERN.test(text);
}

/** Explicit quiet-scene detector: the explore kit's deterministic fallback. */
export function isQuietScenePrompt(prompt: string): boolean {
  const text = (prompt ?? "").toLowerCase();
  if (GOAL_PATTERN.test(text)) return false;
  return QUIET_SCENE_PATTERN.test(text);
}

/** Deterministic inspect detector for the classifier fallback path. */
export function isInspectPrompt(prompt: string): boolean {
  return INSPECT_PATTERN.test((prompt ?? "").toLowerCase());
}

/** Deterministic drive detector for the classifier fallback path. */
export function isDrivePrompt(prompt: string): boolean {
  return DRIVE_PATTERN.test((prompt ?? "").toLowerCase());
}

/**
 * Deterministic machine detector for the classifier fallback path. Machine
 * prompts describe an interactive, free-roam mechanism (robot arm, crane,
 * turret rig) rather than a goal game: prompts that state a goal, name a
 * technical study object (PCB, engine, blueprint) or ask to walk through a
 * place stay with their own kits.
 *
 * Machine is evaluated before inspect so "an interactive machine with servo
 * joints" reaches the machine kit despite the generic word "machine"; the
 * inspect-object gate keeps "a machine engine blueprint" an inspect showcase.
 */
export function isMachinePrompt(prompt: string): boolean {
  const text = (prompt ?? "").toLowerCase();
  if (GOAL_PATTERN.test(text)) return false;
  if (INSPECT_OBJECT_PATTERN.test(text)) return false;
  if (DRIVE_PATTERN.test(text)) return false;
  if (WALKTHROUGH_VERB_PATTERN.test(text)) return false;
  return MACHINE_PATTERN.test(text);
}

/**
 * Deterministic walkthrough detector for the classifier fallback path. A
 * prompt that states a goal is a game, not a walkthrough.
 */
export function isWalkthroughPrompt(prompt: string): boolean {
  const text = (prompt ?? "").toLowerCase();
  if (GOAL_PATTERN.test(text)) return false;
  if (WALKTHROUGH_VERB_PATTERN.test(text)) return true;
  if (WALKTHROUGH_PLACE_PATTERN.test(text) && !isExplorePrompt(prompt)) return true;
  return false;
}

/**
 * Deterministic world/sandbox detector for the classifier fallback path. World
 * prompts describe an open place to roam (island, city, zoo, farm, village,
 * park) or ask to "build me" / "create a" world, with no goal to achieve.
 * Free-form default: any other neutral scene prompt (no goal, no explicit
 * quiet-scene cue) also routes here, so "why can't it build a city" prompts
 * land in a live world instead of a static explore scene.
 * Prompts that state a goal, name a technical study object, race a vehicle,
 * walk through an interior or ask for a quiet scene stay with their own kits -
 * the same precedence `parseArchetype` applies: machine > inspect > drive >
 * walkthrough > world > explore.
 */
export function isWorldPrompt(prompt: string): boolean {
  const text = (prompt ?? "").toLowerCase();
  if (GOAL_PATTERN.test(text)) return false;
  if (INSPECT_OBJECT_PATTERN.test(text)) return false;
  if (DRIVE_PATTERN.test(text)) return false;
  if (WALKTHROUGH_VERB_PATTERN.test(text)) return false;
  if (MACHINE_PATTERN.test(text)) return false;
  if (WORLD_PATTERN.test(text)) return true;
  if (QUIET_SCENE_PATTERN.test(text)) return false;
  return SCENE_PATTERN.test(text);
}

function normalize(raw: string): { spaced: string; compact: string } {
  const lowered = raw.toLowerCase();
  return {
    spaced: lowered.replace(/[^a-z0-9]+/g, " ").trim(),
    compact: lowered.replace(/[^a-z0-9]+/g, ""),
  };
}

export function buildClassifierPrompt(prompt: string): string {
  return [
    "Classify the game design or scene prompt below into exactly ONE of these categories:",
    ...KIT_ARCHETYPES.map((archetype) => `- ${archetype}`),
    "",
    "Guidance:",
    '- "collect-a-thon": a goal game about collecting or gathering targets.',
    '- "puzzle-switch": a goal game about switches, plates, beams or puzzles that open an exit.',
    '- "platformer-lite": a goal game about jumping across platforms to reach a summit or exit.',
    '- "stealth-chase": a goal game about sneaking past guards or escaping a pursuer.',
    '- "explore": a quiet, calm or cozy place to linger in with no goal - a forest',
    "  clearing, room, cabin or peaceful scene.",
    '- "inspect": a clickable showcase of an object - a PCB, circuit board, machine,',
    "  engine, gadget, device, product viewer or blueprint - with no goal and no",
    "  movement challenge.",
    '- "walkthrough": an interior to walk through, usually in first person - a',
    "  house, apartment, building or museum tour, room walk or walk-through.",
    '- "drive": a driving or racing experience - race, racing, rally, car, kart,',
    "  laps or a track.",
    '- "machine": an interactive machine the player drives with on-screen controls -',
    "  a robot or robotic arm, crane, conveyor, turret, servo or jointed rig with",
    "  joint sliders, a grip toggle and clickable labeled parts.",
    '- "world": an open world or sandbox to roam freely - an island, city, zoo,',
    "  farm, village or park - with interactive on-screen controls that spawn or",
    "  change things (spawn buttons, weather toggles, wind sliders).",
    "",
    "Rules:",
    "- Respond with ONLY the archetype string.",
    "- No commentary, no punctuation, no markdown.",
    '- If the prompt describes a quiet, calm, peaceful or cozy scene and states no',
    '  goal, choose "explore".',
    '- If the prompt describes any other scene or place and states no goal, choose',
    '  "world" (the free-form default) - especially cities, streets, buildings and',
    "  open sandboxes.",
    '- If the prompt describes a clickable object to study, choose "inspect".',
    '- If the prompt describes a place to walk through, choose "walkthrough".',
    '- If the prompt involves driving, racing, laps or a track, choose "drive".',
    '- If the prompt describes an interactive machine with sliders, toggles or',
    '  buttons that move its joints, choose "machine".',
    '- If the prompt describes an open world or sandbox to roam with on-screen',
    '  controls that spawn or change things, choose "world".',
    `- If the prompt is unclear, choose "${DEFAULT_ARCHETYPE}".`,
    "",
    "Few-shot examples:",
    '- "collect 3 crystals while avoiding guards" -> collect-a-thon',
    '- "activate three switches to open the exit" -> puzzle-switch',
    '- "hop across floating platforms to the summit" -> platformer-lite',
    '- "sneak past a patrolling guard to the exit" -> stealth-chase',
    '- "a quiet forest clearing with a campfire at dusk" -> explore',
    '- "a city with tall buildings, streets and people walking around" -> world',
    '- "a 3D PCB I can click and inspect" -> inspect',
    '- "a house I can walk through" -> walkthrough',
    '- "a car racing game with 3 laps" -> drive',
    '- "a robotic arm with joint sliders I can control" -> machine',
    '- "an open world island with trees, animals and buttons to spawn things" -> world',
    "",
    "Game design prompt:",
    prompt,
  ].join("\n");
}

export function parseArchetype(raw: string, prompt?: string): KitArchetype {
  const { spaced, compact } = normalize(raw ?? "");
  if (spaced.length > 0 || compact.length > 0) {
    for (const { archetype, spaced: normSpaced, compact: normCompact } of ARCHETYPE_NORMS) {
      if (spaced === normSpaced || compact === normCompact) return archetype;
    }
    for (const { archetype, spaced: normSpaced, compact: normCompact } of ARCHETYPE_NORMS) {
      if (spaced.includes(normSpaced) || compact.includes(normCompact)) return archetype;
    }
  }
  if (prompt !== undefined) {
    if (isMachinePrompt(prompt)) return "machine";
    if (isInspectPrompt(prompt)) return "inspect";
    if (isDrivePrompt(prompt)) return "drive";
    if (isWalkthroughPrompt(prompt)) return "walkthrough";
    if (isWorldPrompt(prompt)) return "world";
    if (isExplorePrompt(prompt)) return EXPLORE_ARCHETYPE;
  }
  return DEFAULT_ARCHETYPE;
}

export async function classify(prompt: string, llm: LlmCall): Promise<KitArchetype> {
  const raw = await llm(buildClassifierPrompt(prompt));
  return parseArchetype(typeof raw === "string" ? raw : "", prompt);
}
