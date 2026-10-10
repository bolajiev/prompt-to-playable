import { ArchetypeSchema } from "@prompt-to-playable/schema";
import type { Archetype } from "@prompt-to-playable/schema";
import type { LlmCall } from "./llm.js";

export const ARCHETYPES = ArchetypeSchema.options;
export const DEFAULT_ARCHETYPE: Archetype = "collect-a-thon";

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

function normalize(raw: string): { spaced: string; compact: string } {
  const lowered = raw.toLowerCase();
  return {
    spaced: lowered.replace(/[^a-z0-9]+/g, " ").trim(),
    compact: lowered.replace(/[^a-z0-9]+/g, ""),
  };
}

export function buildClassifierPrompt(prompt: string): string {
  return [
    "Classify the game design prompt below into exactly ONE of these archetypes:",
    ...ARCHETYPES.map((archetype) => `- ${archetype}`),
    "",
    "Rules:",
    "- Respond with ONLY the archetype string.",
    "- No commentary, no punctuation, no markdown.",
    `- If the prompt is unclear, choose "${DEFAULT_ARCHETYPE}".`,
    "",
    "Game design prompt:",
    prompt,
  ].join("\n");
}

export function parseArchetype(raw: string): Archetype {
  const { spaced, compact } = normalize(raw ?? "");
  if (spaced.length === 0 && compact.length === 0) return DEFAULT_ARCHETYPE;
  for (const { archetype, spaced: normSpaced, compact: normCompact } of ARCHETYPE_NORMS) {
    if (spaced === normSpaced || compact === normCompact) return archetype;
  }
  for (const { archetype, spaced: normSpaced, compact: normCompact } of ARCHETYPE_NORMS) {
    if (spaced.includes(normSpaced) || compact.includes(normCompact)) return archetype;
  }
  return DEFAULT_ARCHETYPE;
}

export async function classify(prompt: string, llm: LlmCall): Promise<Archetype> {
  const raw = await llm(buildClassifierPrompt(prompt));
  return parseArchetype(typeof raw === "string" ? raw : "");
}
