import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateGame } from "@prompt-to-playable/schema";
import type { Archetype, GameDoc, Vec3 } from "@prompt-to-playable/schema";
import type { LlmCall } from "../server/src/llm.js";
import {
  createDefaultPipelineDeps,
  generateGame,
} from "../server/src/pipeline.js";
import type { GenerationPipelineDeps } from "../server/src/pipeline.js";
import { sanityCheck } from "../server/src/sanity.js";
import { validateDoc } from "../server/src/validate.js";

export const DEFAULT_THRESHOLD = 0.95;
export const MIN_CORPUS_SIZE = 20;

export interface CorpusEntry {
  id: string;
  prompt: string;
  archetype: Archetype;
  title: string;
}

export interface Corpus {
  target: number;
  entries: CorpusEntry[];
}

export interface PromptOutcome {
  id: string;
  prompt: string;
  archetype: Archetype;
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

const ARCHETYPE_SET = new Set<Archetype>([
  "collect-a-thon",
  "puzzle-switch",
  "platformer-lite",
  "stealth-chase",
]);

function asArchetype(value: unknown, context: string): Archetype {
  if (typeof value === "string" && ARCHETYPE_SET.has(value as Archetype)) {
    return value as Archetype;
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

const DIFFICULTY: Record<Archetype, number> = {
  "collect-a-thon": 0.4,
  "puzzle-switch": 0.5,
  "platformer-lite": 0.5,
  "stealth-chase": 0.6,
};

function metaOf(entry: CorpusEntry): Record<string, unknown> {
  return {
    title: entry.title,
    archetype: entry.archetype,
    difficulty: DIFFICULTY[entry.archetype],
    seed: hashSeed(entry.id),
  };
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
  }
}

const CLASSIFY_MARKER = "ONLY the archetype string";
const REPAIR_MARKER = "previously generated game document failed validation";
const REPAIR_DOC_START = "Failed document (for reference):";
const GENERATE_PROMPT_START = "Player prompt:";
const GENERATE_PROMPT_END = "\n\nReturn JSON:";

export function classifyByKeywords(prompt: string): Archetype {
  if (/stealth|sneak|guard|patrol|searchlight|escape|evade|hide|sentry/i.test(prompt)) {
    return "stealth-chase";
  }
  if (/platform|jump|ledge|leap|climb|hop/i.test(prompt)) {
    return "platformer-lite";
  }
  if (/switch|puzzle|beam|mirror|lever|plate|pressure|rotate|light|crystal/i.test(prompt)) {
    return "puzzle-switch";
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

export function hasWinPath(doc: GameDoc): boolean {
  return doc.rules.some((rule) =>
    rule.then.some((action) => action.type === "win")
  );
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
    if (!hasWinPath(data)) {
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
