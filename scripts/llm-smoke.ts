import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ArchetypeSchema, validateGame } from "@prompt-to-playable/schema";
import type { Archetype, GameDoc } from "@prompt-to-playable/schema";
import { createDefaultEditDeps, editGame } from "../server/src/edit.js";
import { loadEnvFile } from "../server/src/env.js";
import { DEFAULT_LLM_MODEL, createOpenAiLlm } from "../server/src/llm.js";
import type { LlmCall } from "../server/src/llm.js";
import { createDefaultPipelineDeps, generateGame } from "../server/src/pipeline.js";
import { RouteError } from "../server/src/routes.js";
import { hasWinPath, requiresWinPath, sanityCheck } from "../server/src/sanity.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, "server", ".env");
const FIXTURES_DIR = join(ROOT, "tests", "fixtures");

const CALL_ATTEMPTS = 3;

const USAGE =
  "usage: npm run llm:smoke [-- --prompts <file>] [--no-edit] [--no-write]\n" +
  "  --prompts <file>  JSON array of {slug, prompt, expectArchetype?, editOf?} entries\n" +
  "                    instead of the defaults; expectArchetype is checked after\n" +
  "                    generation and editOf marks an edit of that generated slug\n" +
  "  --no-edit         skip entries with editOf (the conversational-edit stage)\n" +
  "  --no-write        validate and report only; do not write tests/fixtures/live-*.json";

export interface SmokePrompt {
  slug: string;
  prompt: string;
  /** Judge-style expectation; a mismatch is reported as ARCHETYPE_MISMATCH. */
  expectArchetype?: Archetype;
  /** Slug of the generated document this conversational-edit prompt mutates. */
  editOf?: string;
}

/**
 * Default capture set. The last two prompts ask for open ground explicitly so
 * the captured fixtures can be auto-played by deterministic input steering
 * (P2.8): few/no obstacles and every target reachable on a straight line.
 */
export const SMOKE_PROMPTS: readonly SmokePrompt[] = [
  { slug: "crystals-guard", prompt: "collect 3 crystals while avoiding one patrolling guard" },
  {
    slug: "puzzle-beams",
    prompt:
      "open puzzle room with no obstacles: activate three beam switches placed in the open to open the exit door",
  },
  {
    slug: "open-collect",
    prompt:
      "open flat field with no obstacles: collect 3 glowing crystals placed in the open; walking through a crystal collects it; win when all are collected",
  },
  {
    slug: "open-puzzle",
    prompt:
      "open flat chamber with no obstacles: press three switches placed in the open; win when every switch is activated",
  },
];

export const SMOKE_EDIT_PROMPT = "add a second guard patrolling the level";

const DEFAULT_EDIT: SmokePrompt = {
  slug: "crystals-guard-edit",
  prompt: SMOKE_EDIT_PROMPT,
  editOf: "crystals-guard",
};

export const DEFAULT_SMOKE_ENTRIES: readonly SmokePrompt[] = [
  ...SMOKE_PROMPTS,
  DEFAULT_EDIT,
];

function redact(text: string): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? text.split(key).join("[redacted]") : text;
}

function messageOf(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(message)) {
    return true;
  }
  return /status (429|500|502|503|504)\b/.test(message);
}

/** Retry transient endpoint failures without burning a whole pipeline stage. */
function withTransientRetries(llm: LlmCall, counter: CallCounter): LlmCall {
  return async (prompt: string): Promise<string> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await llm(prompt);
      } catch (error) {
        if (!isTransient(error) || attempt >= CALL_ATTEMPTS) throw error;
        counter.retries += 1;
        console.error(
          `  transient LLM error (attempt ${attempt}/${CALL_ATTEMPTS}): ${messageOf(error)}`
        );
        await sleep(attempt * 2000);
      }
    }
  };
}

interface CallCounter {
  calls: number;
  retries: number;
}

/**
 * Counts LLM calls submitted by the smoke stages (transient retries inside
 * `withTransientRetries` are additional HTTP requests and are counted
 * separately in `retries`).
 */
function countingLlm(llm: LlmCall, counter: CallCounter): LlmCall {
  return (prompt: string): Promise<string> => {
    counter.calls += 1;
    return llm(prompt);
  };
}

export function classifyFailure(error: unknown): string {
  if (error instanceof RouteError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /status (429|500|502|503|504)\b|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(
      message
    )
  ) {
    return "ENDPOINT";
  }
  if (/no JSON object|not valid JSON/i.test(message)) return "JSON_PARSE";
  return "UNKNOWN";
}

function failureDetails(error: unknown): string[] {
  if (error instanceof RouteError) return error.details.map(redact);
  return [messageOf(error)];
}

function writeFixture(name: string, doc: GameDoc): string {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const file = join(FIXTURES_DIR, `live-${name}.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return file;
}

interface DocCheck {
  valid: boolean;
  sanity: boolean;
  isExplore: boolean;
  winnable: boolean;
  objectives: number;
  explorable: boolean;
  solvable: boolean;
  errors: string[];
}

function checkDoc(doc: GameDoc): DocCheck {
  const validation = validateGame(doc);
  if (!validation.ok || !validation.data) {
    const errors =
      validation.error?.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
      ) ?? ["document is not a game"];
    return {
      valid: false,
      sanity: false,
      isExplore: false,
      winnable: false,
      objectives: 0,
      explorable: false,
      solvable: false,
      errors,
    };
  }
  const data = validation.data;
  const sanity = sanityCheck(data);
  const isExplore = data.meta.archetype === "explore";
  const errors = sanity.errors.map((issue) => `${issue.path}: ${issue.message}`);
  const winnable = !requiresWinPath(data) || hasWinPath(data);
  if (!winnable) errors.push("(root): no rule wins the game");
  if (isExplore && data.objectives.length > 0) {
    errors.push(
      `objectives: explore scene has ${data.objectives.length} objective(s); expected none`
    );
  }
  return {
    valid: true,
    sanity: sanity.ok,
    isExplore,
    winnable,
    objectives: data.objectives.length,
    explorable: isExplore && sanity.ok && data.objectives.length === 0,
    solvable: !isExplore && sanity.ok && winnable,
    errors,
  };
}

function docStats(doc: GameDoc): string {
  const counts = new Map<string, number>();
  for (const entity of doc.entities) {
    counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
  }
  const kinds = [...counts.entries()].map(([kind, count]) => `${kind}=${count}`).join(" ");
  return `entities=${doc.entities.length} (${kinds}) objectives=${doc.objectives.length} rules=${doc.rules.length}`;
}

function editDiff(base: GameDoc, doc: GameDoc): string {
  const before = new Set(base.entities.map((entity) => entity.id));
  const after = new Set(doc.entities.map((entity) => entity.id));
  const added = doc.entities.filter((entity) => !before.has(entity.id));
  const removed = base.entities.filter((entity) => !after.has(entity.id));
  const objectiveDelta = doc.objectives.length - base.objectives.length;
  const ruleDelta = doc.rules.length - base.rules.length;
  const sign = (value: number): string => (value >= 0 ? `+${value}` : `${value}`);
  const ids = (entities: readonly { id: string; kind: string }[]): string =>
    entities.length === 0 ? "" : ` [${entities.map((e) => `${e.id}(${e.kind})`).join(", ")}]`;
  const changed =
    added.length > 0 || removed.length > 0 || objectiveDelta !== 0 || ruleDelta !== 0;
  return (
    `edit-diff: entities +${added.length} -${removed.length}${ids(added)}` +
    ` objectives ${sign(objectiveDelta)} rules ${sign(ruleDelta)}` +
    (changed ? "" : " (no structural change)")
  );
}

function usabilityFailure(check: DocCheck): string | undefined {
  if (!check.valid) return "SCHEMA";
  if (!check.sanity) return "SANITY";
  if (check.isExplore) return check.explorable ? undefined : "OBJECTIVES_PRESENT";
  return check.solvable ? undefined : "NO_WIN_PATH";
}

function archetypeFailure(
  archetype: Archetype,
  expect: Archetype | undefined
): string | undefined {
  return expect !== undefined && archetype !== expect ? "ARCHETYPE_MISMATCH" : undefined;
}

interface RunOutcome {
  slug: string;
  kind: "generate" | "edit";
  label: string;
  expected?: Archetype;
  doc?: GameDoc;
  check?: DocCheck;
  failure?: string;
  usable: boolean;
  latencyMs: number;
  calls: number;
}

function report(outcome: RunOutcome): void {
  const produced = outcome.doc ? outcome.doc.meta.archetype : "n/a";
  const expected =
    outcome.expected !== undefined
      ? ` expected=${outcome.expected}${
          outcome.doc && produced !== outcome.expected ? " MISMATCH" : ""
        }`
      : "";
  const verdict = outcome.check
    ? outcome.check.isExplore
      ? `valid=${outcome.check.valid} explorable=${outcome.check.explorable}`
      : `valid=${outcome.check.valid} solvable=${outcome.check.solvable}`
    : "valid=false solvable=false";
  const failureSuffix = outcome.failure ? ` failure=${outcome.failure}` : "";
  console.log(
    `${outcome.label} -> ${produced}${expected} -> ${verdict} latency=${outcome.latencyMs}ms calls=${outcome.calls}${failureSuffix}`
  );
}

async function runGenerate(
  entry: SmokePrompt,
  llm: LlmCall,
  counter: CallCounter,
  writeFixtures: boolean
): Promise<RunOutcome> {
  const before = counter.calls;
  const started = Date.now();
  const outcome: RunOutcome = {
    slug: entry.slug,
    kind: "generate",
    label: entry.prompt,
    ...(entry.expectArchetype !== undefined
      ? { expected: entry.expectArchetype }
      : {}),
    usable: false,
    latencyMs: 0,
    calls: 0,
  };
  try {
    const doc = await generateGame(entry.prompt, createDefaultPipelineDeps(llm));
    const check = checkDoc(doc);
    outcome.doc = doc;
    outcome.check = check;
    outcome.failure =
      usabilityFailure(check) ?? archetypeFailure(doc.meta.archetype, entry.expectArchetype);
    outcome.usable = outcome.failure === undefined;
    outcome.latencyMs = Date.now() - started;
    outcome.calls = counter.calls - before;
    report(outcome);
    console.log(`  stats: ${docStats(doc)}`);
    if (!outcome.usable) {
      for (const detail of check.errors) console.error(`  error: ${detail}`);
      if (outcome.failure === "ARCHETYPE_MISMATCH") {
        console.error(
          `  expected archetype ${String(entry.expectArchetype)}, produced ${doc.meta.archetype}`
        );
      }
      console.error(`  fixture not written: post-check failed for "${entry.prompt}"`);
      return outcome;
    }
    console.log(
      writeFixtures
        ? `  fixture: tests/fixtures/live-${entry.slug}.json`
        : `  fixture: tests/fixtures/live-${entry.slug}.json (not written: --no-write)`
    );
    if (writeFixtures) writeFixture(entry.slug, doc);
    return outcome;
  } catch (error) {
    outcome.failure = classifyFailure(error);
    outcome.latencyMs = Date.now() - started;
    outcome.calls = counter.calls - before;
    report(outcome);
    for (const detail of failureDetails(error)) console.error(`  error: ${detail}`);
    return outcome;
  }
}

async function runEdit(
  entry: SmokePrompt,
  base: GameDoc,
  llm: LlmCall,
  counter: CallCounter,
  writeFixtures: boolean
): Promise<RunOutcome> {
  const before = counter.calls;
  const started = Date.now();
  const outcome: RunOutcome = {
    slug: entry.slug,
    kind: "edit",
    label: entry.prompt,
    ...(entry.expectArchetype !== undefined
      ? { expected: entry.expectArchetype }
      : {}),
    usable: false,
    latencyMs: 0,
    calls: 0,
  };
  try {
    const result = await editGame(entry.prompt, base, [], createDefaultEditDeps(llm));
    const check = checkDoc(result.doc);
    outcome.doc = result.doc;
    outcome.check = check;
    outcome.failure =
      usabilityFailure(check) ??
      archetypeFailure(result.doc.meta.archetype, entry.expectArchetype);
    outcome.usable = outcome.failure === undefined;
    outcome.latencyMs = Date.now() - started;
    outcome.calls = counter.calls - before;
    report(outcome);
    console.log(`  stats: ${docStats(result.doc)}`);
    console.log(`  ${editDiff(base, result.doc)}`);
    if (!outcome.usable) {
      for (const detail of check.errors) console.error(`  error: ${detail}`);
      console.error("  fixture not written: post-check failed for edit");
      return outcome;
    }
    const name = `${String(entry.editOf)}-edit`;
    console.log(
      writeFixtures
        ? `  fixture: tests/fixtures/live-${name}.json`
        : `  fixture: tests/fixtures/live-${name}.json (not written: --no-write)`
    );
    if (writeFixtures) writeFixture(name, result.doc);
    return outcome;
  } catch (error) {
    outcome.failure = classifyFailure(error);
    outcome.latencyMs = Date.now() - started;
    outcome.calls = counter.calls - before;
    report(outcome);
    for (const detail of failureDetails(error)) console.error(`  error: ${detail}`);
    return outcome;
  }
}

export interface SmokeOptions {
  prompts?: readonly SmokePrompt[];
  edit?: boolean;
  write?: boolean;
}

function parsePromptsFile(file: string): SmokePrompt[] {
  const path = isAbsolute(file) ? file : resolve(ROOT, file);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`--prompts file must contain a JSON array: ${file}`);
  }
  return parsed.map((entry, index) => {
    const record = entry as Record<string, unknown> | null;
    const slug = record?.slug;
    const prompt = record?.prompt;
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error(`--prompts entry ${index} is missing a non-empty "slug"`);
    }
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error(`--prompts entry ${index} is missing a non-empty "prompt"`);
    }
    const parsed: SmokePrompt = { slug, prompt };
    const expectArchetype = record?.expectArchetype;
    if (expectArchetype !== undefined) {
      const result = ArchetypeSchema.safeParse(expectArchetype);
      if (!result.success) {
        throw new Error(
          `--prompts entry ${index} has invalid "expectArchetype": ${JSON.stringify(
            expectArchetype
          )}`
        );
      }
      parsed.expectArchetype = result.data;
    }
    const editOf = record?.editOf;
    if (editOf !== undefined) {
      if (typeof editOf !== "string" || editOf.length === 0) {
        throw new Error(`--prompts entry ${index} has invalid "editOf"`);
      }
      parsed.editOf = editOf;
    }
    return parsed;
  });
}

function parseArgs(argv: readonly string[]): SmokeOptions {
  const options: SmokeOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-edit") {
      options.edit = false;
    } else if (arg === "--no-write") {
      options.write = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--prompts") {
      const file = argv[i + 1];
      if (file === undefined) throw new Error("--prompts requires a file path");
      options.prompts = parsePromptsFile(file);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return options;
}

export async function runSmoke(options: SmokeOptions = {}): Promise<boolean> {
  const entries = options.prompts ?? DEFAULT_SMOKE_ENTRIES;
  const runEditStage = options.edit ?? true;
  const writeFixtures = options.write ?? true;
  loadEnvFile(ENV_PATH);
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_LLM_MODEL;
  const configured = Boolean(process.env.OPENAI_API_KEY?.trim());
  console.log(`llm:smoke model=${model} key=${configured ? "configured" : "missing"}`);
  if (!configured) {
    console.error("No OPENAI_API_KEY found (expected it in server/.env).");
    return false;
  }

  const generations = entries.filter((entry) => entry.editOf === undefined);
  const editEntries = entries.filter((entry) => entry.editOf !== undefined);
  const counter: CallCounter = { calls: 0, retries: 0 };
  const llm = countingLlm(withTransientRetries(createOpenAiLlm(), counter), counter);
  const outcomes: RunOutcome[] = [];
  const docsBySlug = new Map<string, GameDoc>();

  for (const entry of generations) {
    const outcome = await runGenerate(entry, llm, counter, writeFixtures);
    outcomes.push(outcome);
    if (outcome.usable && outcome.doc) docsBySlug.set(entry.slug, outcome.doc);
  }

  let editCalls = 0;
  const editsToRun = runEditStage ? editEntries : [];
  for (const entry of editsToRun) {
    const base = docsBySlug.get(String(entry.editOf));
    if (base === undefined) {
      const outcome: RunOutcome = {
        slug: entry.slug,
        kind: "edit",
        label: entry.prompt,
        ...(entry.expectArchetype !== undefined
          ? { expected: entry.expectArchetype }
          : {}),
        failure: "BASE_UNAVAILABLE",
        usable: false,
        latencyMs: 0,
        calls: 0,
      };
      outcomes.push(outcome);
      report(outcome);
      console.error(
        `  skipping edit: base "${String(entry.editOf)}" was not generated successfully`
      );
      continue;
    }
    const before = counter.calls;
    const outcome = await runEdit(entry, base, llm, counter, writeFixtures);
    editCalls += counter.calls - before;
    outcomes.push(outcome);
  }

  const generated = outcomes.filter((outcome) => outcome.kind === "generate");
  const edited = outcomes.filter((outcome) => outcome.kind === "edit");
  const generatedOk = generated.filter((outcome) => outcome.usable).length;
  const editedOk = edited.filter((outcome) => outcome.usable).length;
  const explored = generated.filter(
    (outcome) => outcome.doc?.meta.archetype === "explore"
  );
  const explorable = explored.filter((outcome) => outcome.check?.explorable).length;
  const genCalls = counter.calls - editCalls;
  const ok = generatedOk === generations.length && editedOk === editsToRun.length;
  console.log(
    `summary: generated=${generatedOk}/${generations.length} edited=${
      runEditStage ? `${editedOk}/${editsToRun.length}` : "skipped"
    } explorable=${explorable} genCalls=${genCalls} editCalls=${editCalls} transientRetries=${
      counter.retries
    } result=${ok ? "PASS" : "FAIL"}`
  );
  return ok;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runSmoke(parseArgs(process.argv.slice(2)))
    .then((ok) => {
      if (!ok) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(`llm:smoke crashed: ${messageOf(error)}`);
      process.exitCode = 1;
    });
}
