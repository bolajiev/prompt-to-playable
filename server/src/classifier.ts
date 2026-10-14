import { ArchetypeSchema } from "@prompt-to-playable/schema";
import type { Archetype } from "@prompt-to-playable/schema";
import type { LlmCall } from "./llm.js";

export const ARCHETYPES = ArchetypeSchema.options;
export const DEFAULT_ARCHETYPE: Archetype = "collect-a-thon";
export const EXPLORE_ARCHETYPE: Archetype = "explore";

interface ArchetypeNorms {
  archetype: Archetype;
  spaced: string;
  compact: string;
}

const ARCHETYPE_NORMS: readonly ArchetypeNorms[] = ARCHETYPES.map((archetype) => ({
  archetype,
  spaced: archetype.replace(/-/g, " "),
  compact: archetype.replace(/-/g, ""),
}));

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
 * Deterministic scene detector used when the LLM answer cannot be parsed:
 * non-goal prompts that describe a place or use display language are explore.
 */
export function isExplorePrompt(prompt: string): boolean {
  const text = (prompt ?? "").toLowerCase();
  if (GOAL_PATTERN.test(text)) return false;
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
    "Classify the game design or scene prompt below into exactly ONE of these archetypes:",
    ...ARCHETYPES.map((archetype) => `- ${archetype}`),
    "",
    "Guidance:",
    '- "collect-a-thon": a goal game about collecting or gathering targets.',
    '- "puzzle-switch": a goal game about switches, plates, beams or puzzles that open an exit.',
    '- "platformer-lite": a goal game about jumping across platforms to reach a summit or exit.',
    '- "stealth-chase": a goal game about sneaking past guards or escaping a pursuer.',
    '- "explore": a free-roam scene or place with no goal to achieve. Choose "explore"',
    '  for display prompts ("show me ..."), landscapes and interiors, or any prompt',
    "  that describes a place to look at rather than a challenge to beat.",
    "",
    "Rules:",
    "- Respond with ONLY the archetype string.",
    "- No commentary, no punctuation, no markdown.",
    '- If the prompt describes a scene or place and states no goal, choose "explore".',
    `- If the prompt is unclear, choose "${DEFAULT_ARCHETYPE}".`,
    "",
    "Game design prompt:",
    prompt,
  ].join("\n");
}

export function parseArchetype(raw: string, prompt?: string): Archetype {
  const { spaced, compact } = normalize(raw ?? "");
  if (spaced.length > 0 || compact.length > 0) {
    for (const { archetype, spaced: normSpaced, compact: normCompact } of ARCHETYPE_NORMS) {
      if (spaced === normSpaced || compact === normCompact) return archetype;
    }
    for (const { archetype, spaced: normSpaced, compact: normCompact } of ARCHETYPE_NORMS) {
      if (spaced.includes(normSpaced) || compact.includes(normCompact)) return archetype;
    }
  }
  if (prompt !== undefined && isExplorePrompt(prompt)) return EXPLORE_ARCHETYPE;
  return DEFAULT_ARCHETYPE;
}

export async function classify(prompt: string, llm: LlmCall): Promise<Archetype> {
  const raw = await llm(buildClassifierPrompt(prompt));
  return parseArchetype(typeof raw === "string" ? raw : "", prompt);
}
