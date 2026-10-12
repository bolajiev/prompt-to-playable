import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateGame } from "@prompt-to-playable/schema";
import type { GameDoc } from "@prompt-to-playable/schema";
import { createDefaultEditDeps, editGame } from "../server/src/edit.js";
import { loadEnvFile } from "../server/src/env.js";
import { DEFAULT_LLM_MODEL, createOpenAiLlm } from "../server/src/llm.js";
import type { LlmCall } from "../server/src/llm.js";
import { createDefaultPipelineDeps, generateGame } from "../server/src/pipeline.js";
import { RouteError } from "../server/src/routes.js";
import { sanityCheck } from "../server/src/sanity.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, "server", ".env");
const FIXTURES_DIR = join(ROOT, "tests", "fixtures");

const CALL_ATTEMPTS = 3;

export interface SmokePrompt {
  slug: string;
  prompt: string;
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
    return { valid: false, solvable: false, errors };
  }
  const sanity = sanityCheck(validation.data);
  return {
    valid: true,
    solvable: sanity.ok,
    errors: sanity.errors.map((issue) => `${issue.path}: ${issue.message}`),
  };
}

function report(
  label: string,
  archetype: string,
  valid: boolean,
  solvable: boolean,
  latencyMs: number,
  llmCalls: number,
  failure?: string
): void {
  const failureSuffix = failure ? ` failure=${failure}` : "";
  console.log(
    `${label} -> ${archetype} -> valid=${valid} solvable=${solvable} latency=${latencyMs}ms calls=${llmCalls}${failureSuffix}`
  );
}

async function runGenerate(
  entry: SmokePrompt,
  llm: LlmCall,
  counter: CallCounter
): Promise<GameDoc | undefined> {
  const before = counter.calls;
  const started = Date.now();
  try {
    const doc = await generateGame(entry.prompt, createDefaultPipelineDeps(llm));
    const check = checkDoc(doc);
    const failure = check.valid ? (check.solvable ? undefined : "SANITY") : "SCHEMA";
    report(
      entry.prompt,
      doc.meta.archetype,
      check.valid,
      check.solvable,
      Date.now() - started,
      counter.calls - before,
      failure
    );
    if (!check.valid || !check.solvable) {
      for (const detail of check.errors) console.error(`  error: ${detail}`);
      console.error(`  fixture not written: post-check failed for "${entry.prompt}"`);
      return undefined;
    }
    console.log(`  fixture: tests/fixtures/live-${entry.slug}.json`);
    writeFixture(entry.slug, doc);
    return doc;
  } catch (error) {
    report(
      entry.prompt,
      "n/a",
      false,
      false,
      Date.now() - started,
      counter.calls - before,
      classifyFailure(error)
    );
    for (const detail of failureDetails(error)) console.error(`  error: ${detail}`);
    return undefined;
  }
}

async function runEdit(
  base: GameDoc,
  baseSlug: string,
  llm: LlmCall,
  counter: CallCounter
): Promise<boolean> {
  const before = counter.calls;
  const started = Date.now();
  try {
    const result = await editGame(SMOKE_EDIT_PROMPT, base, [], createDefaultEditDeps(llm));
    const check = checkDoc(result.doc);
    const failure = check.valid ? (check.solvable ? undefined : "SANITY") : "SCHEMA";
    report(
      SMOKE_EDIT_PROMPT,
      result.doc.meta.archetype,
      check.valid,
      check.solvable,
      Date.now() - started,
      counter.calls - before,
      failure
    );
    if (!check.valid || !check.solvable) {
      for (const detail of check.errors) console.error(`  error: ${detail}`);
      console.error("  fixture not written: post-check failed for edit");
      return false;
    }
    const name = `${baseSlug}-edit`;
    console.log(`  fixture: tests/fixtures/live-${name}.json`);
    writeFixture(name, result.doc);
    return true;
  } catch (error) {
    report(
      SMOKE_EDIT_PROMPT,
      "n/a",
      false,
      false,
      Date.now() - started,
      counter.calls - before,
      classifyFailure(error)
    );
    for (const detail of failureDetails(error)) console.error(`  error: ${detail}`);
    return false;
  }
}

export interface SmokeOptions {
  prompts?: readonly SmokePrompt[];
  edit?: boolean;
}

function parsePromptsFile(file: string): SmokePrompt[] {
  const path = isAbsolute(file) ? file : resolve(ROOT, file);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`--prompts file must contain a JSON array: ${file}`);
  }
  return parsed.map((entry, index) => {
    const slug = (entry as { slug?: unknown } | null)?.slug;
    const prompt = (entry as { prompt?: unknown } | null)?.prompt;
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error(`--prompts entry ${index} is missing a non-empty "slug"`);
    }
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error(`--prompts entry ${index} is missing a non-empty "prompt"`);
    }
    return { slug, prompt };
  });
}

function parseArgs(argv: readonly string[]): SmokeOptions {
  const options: SmokeOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-edit") {
      options.edit = false;
    } else if (arg === "--prompts") {
      const file = argv[i + 1];
      if (file === undefined) throw new Error("--prompts requires a file path");
      options.prompts = parsePromptsFile(file);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function runSmoke(options: SmokeOptions = {}): Promise<boolean> {
  const prompts = options.prompts ?? SMOKE_PROMPTS;
  const runEditStage = options.edit ?? true;
  loadEnvFile(ENV_PATH);
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_LLM_MODEL;
  const configured = Boolean(process.env.OPENAI_API_KEY?.trim());
  console.log(`llm:smoke model=${model} key=${configured ? "configured" : "missing"}`);
  if (!configured) {
    console.error("No OPENAI_API_KEY found (expected it in server/.env).");
    return false;
  }

  const counter: CallCounter = { calls: 0, retries: 0 };
  const llm = countingLlm(withTransientRetries(createOpenAiLlm(), counter), counter);
  const generated: { slug: string; doc: GameDoc }[] = [];
  for (const entry of prompts) {
    const doc = await runGenerate(entry, llm, counter);
    if (doc) generated.push({ slug: entry.slug, doc });
  }

  let editCalls = 0;
  let edited = false;
  if (runEditStage) {
    const base = generated[0];
    if (base) {
      const before = counter.calls;
      edited = await runEdit(base.doc, base.slug, llm, counter);
      editCalls = counter.calls - before;
    } else {
      console.error("skipping edit stage: no generated document to edit");
    }
  }

  const genCalls = counter.calls - editCalls;
  const ok = generated.length === prompts.length && (!runEditStage || edited);
  console.log(
    `summary: generated=${generated.length}/${prompts.length} edited=${
      runEditStage ? edited : "skipped"
    } genCalls=${genCalls} editCalls=${editCalls} transientRetries=${counter.retries} result=${
      ok ? "PASS" : "FAIL"
    }`
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
