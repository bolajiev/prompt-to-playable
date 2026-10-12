import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateGame } from "@prompt-to-playable/schema";
import type { GameDoc } from "@prompt-to-playable/schema";
import {
  createDefaultEditDeps,
  editGame,
  generatePatch,
} from "../server/src/edit.js";
import type { EditPipelineDeps } from "../server/src/edit.js";
import { loadEnvFile } from "../server/src/env.js";
import { parseGameDoc } from "../server/src/generator.js";
import { DEFAULT_LLM_MODEL, createOpenAiLlm } from "../server/src/llm.js";
import type { LlmCall } from "../server/src/llm.js";
import {
  createDefaultPipelineDeps,
  generateGame,
} from "../server/src/pipeline.js";
import type { GenerationPipelineDeps, RepairerFn } from "../server/src/pipeline.js";
import { MAX_REPAIR_RETRIES, buildRepairPrompt } from "../server/src/repair.js";
import { sanityCheck } from "../server/src/sanity.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, "server", ".env");
const FIXTURES_DIR = join(ROOT, "tests", "fixtures");

const CALL_ATTEMPTS = 3;
const STAGE_ATTEMPTS = 2;

export interface SmokePrompt {
  slug: string;
  prompt: string;
}

export const SMOKE_PROMPTS: readonly SmokePrompt[] = [
  { slug: "crystals-guard", prompt: "collect 3 crystals avoiding one guard" },
  {
    slug: "puzzle-beams",
    prompt: "puzzle room: rotate three beams to open the exit door",
  },
];

export const SMOKE_EDIT_PROMPT = "add a second guard patrolling the level";

/**
 * Live retry guidance. The generator prompt leaves the condition/action unions
 * unspecified, so the model occasionally invents shapes (e.g. a bare
 * { "entity": ... } condition or a non-existent "stateChange" action). This
 * appendix is only added to retry attempts inside this smoke script; it never
 * changes the pipeline itself.
 */
export const SCHEMA_GUIDANCE = [
  "",
  "Additional schema constraints (must be followed exactly):",
  '- Condition objects must use one of: {"op":"and","conditions":[...]}, {"op":"or","conditions":[...]}, {"op":"not","condition":{...}}, {"op":"has","entity":"<id>"}, {"op":"hasTag","tag":"<tag>"}, or {"op":"==/!=/</<=/>/>=","left":<value>,"right":<value>}.',
  '- Never use a bare object like {"entity":"beam-1"} as a condition; wrap entity checks as {"op":"has","entity":"beam-1"}.',
  '- Entity "state" values must be one of idle|patrol|chase|return.',
  '- Rule action "type" values must be exactly one of spawn|despawn|enable|disable|objectiveProgress|setObjective|addObjective|setVar|incVar|teleport|playSound|showMessage|setEnemyState|win|lose|damage|openDoor|toggle. Never invent action types, and never use event names as actions.',
  "- Every action must include its required fields:",
  '  {"type":"showMessage","text":"..."} - the field is "text", not "message";',
  '  {"type":"playSound","sound":"..."};',
  '  {"type":"objectiveProgress","objective":"<id>","by":1};',
  '  {"type":"setObjective","objective":"<id>","status":"active"};',
  '  {"type":"openDoor"|"enable"|"disable"|"despawn","entity":"<id>"};',
  '  {"type":"toggle","target":"<id>"};',
  '  {"type":"teleport","entity":"<id>","position":[x,y,z]};',
  '  {"type":"setEnemyState","entity":"<id>","state":"patrol"};',
  '  {"type":"setVar","key":"<name>","value":1};',
  '  {"type":"incVar","key":"<name>","by":1};',
  '  {"type":"damage","entity":"<id>","amount":1};',
  '  {"type":"win"|"lose","message":"..."};',
  '  {"type":"spawn","entity":{...full entity object...}}.',
].join("\n");

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
function withTransientRetries(llm: LlmCall): LlmCall {
  return async (prompt: string): Promise<string> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await llm(prompt);
      } catch (error) {
        if (!isTransient(error) || attempt >= CALL_ATTEMPTS) throw error;
        console.error(
          `  transient LLM error (attempt ${attempt}/${CALL_ATTEMPTS}): ${messageOf(error)}`
        );
        await sleep(attempt * 2000);
      }
    }
  };
}

function guidedRepairer(llm: LlmCall): RepairerFn {
  return async (doc, errors, attempt) => {
    const prompt =
      buildRepairPrompt({ doc, errors, attempt, maxRetries: MAX_REPAIR_RETRIES }) +
      SCHEMA_GUIDANCE;
    return parseGameDoc(await llm(prompt));
  };
}

function generationDeps(llm: LlmCall, guided: boolean): GenerationPipelineDeps {
  const deps = createDefaultPipelineDeps(llm);
  return guided ? { ...deps, repairer: guidedRepairer(llm) } : deps;
}

function editDeps(llm: LlmCall, guided: boolean): EditPipelineDeps {
  if (!guided) return createDefaultEditDeps(llm);
  return {
    generatePatch: (prompt, doc, history, context) =>
      generatePatch(`${prompt}\n${SCHEMA_GUIDANCE}`, doc, history, llm, {
        errors: context.errors,
        attempt: context.attempt,
        maxRetries: MAX_REPAIR_RETRIES,
      }),
  };
}

function writeFixture(name: string, doc: GameDoc): string {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const file = join(FIXTURES_DIR, `live-${name}.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return file;
}

function checkDoc(doc: GameDoc): { valid: boolean; solvable: boolean } {
  const validation = validateGame(doc);
  if (!validation.ok || !validation.data) return { valid: false, solvable: false };
  const sanity = sanityCheck(validation.data);
  return { valid: true, solvable: sanity.ok };
}

function report(
  label: string,
  archetype: string,
  valid: boolean,
  solvable: boolean,
  latencyMs: number
): void {
  console.log(
    `${label} -> ${archetype} -> valid=${valid} solvable=${solvable} latency=${latencyMs}ms`
  );
}

async function runGenerate(
  entry: SmokePrompt,
  llm: LlmCall
): Promise<GameDoc | undefined> {
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt += 1) {
    const guided = attempt > 1;
    if (guided) console.error(`  retrying stage with schema guidance (${attempt}/${STAGE_ATTEMPTS})`);
    const started = Date.now();
    try {
      const prompt = guided ? `${entry.prompt}\n${SCHEMA_GUIDANCE}` : entry.prompt;
      const doc = await generateGame(prompt, generationDeps(llm, guided));
      const latency = Date.now() - started;
      const { valid, solvable } = checkDoc(doc);
      report(entry.prompt, doc.meta.archetype, valid, solvable, latency);
      if (!valid || !solvable) {
        console.error(`  fixture not written: post-check failed for "${entry.prompt}"`);
        continue;
      }
      console.log(`  fixture: tests/fixtures/live-${entry.slug}.json`);
      writeFixture(entry.slug, doc);
      return doc;
    } catch (error) {
      report(entry.prompt, "n/a", false, false, Date.now() - started);
      console.error(`  error: ${messageOf(error)}`);
    }
  }
  return undefined;
}

async function runEdit(
  base: GameDoc,
  baseSlug: string,
  llm: LlmCall
): Promise<boolean> {
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt += 1) {
    const guided = attempt > 1;
    if (guided) console.error(`  retrying stage with schema guidance (${attempt}/${STAGE_ATTEMPTS})`);
    const started = Date.now();
    try {
      const result = await editGame(
        SMOKE_EDIT_PROMPT,
        base,
        [],
        editDeps(llm, guided)
      );
      const latency = Date.now() - started;
      const { valid, solvable } = checkDoc(result.doc);
      report(SMOKE_EDIT_PROMPT, result.doc.meta.archetype, valid, solvable, latency);
      if (!valid || !solvable) {
        console.error("  fixture not written: post-check failed for edit");
        continue;
      }
      const name = `${baseSlug}-edit`;
      console.log(`  fixture: tests/fixtures/live-${name}.json`);
      writeFixture(name, result.doc);
      return true;
    } catch (error) {
      report(SMOKE_EDIT_PROMPT, "n/a", false, false, Date.now() - started);
      console.error(`  error: ${messageOf(error)}`);
    }
  }
  return false;
}

export async function runSmoke(): Promise<boolean> {
  loadEnvFile(ENV_PATH);
  const model = process.env.OPENAI_MODEL?.trim() ?? DEFAULT_LLM_MODEL;
  const configured = Boolean(process.env.OPENAI_API_KEY?.trim());
  console.log(`llm:smoke model=${model} key=${configured ? "configured" : "missing"}`);
  if (!configured) {
    console.error("No OPENAI_API_KEY found (expected it in server/.env).");
    return false;
  }

  const llm = withTransientRetries(createOpenAiLlm());
  const generated: { slug: string; doc: GameDoc }[] = [];
  for (const entry of SMOKE_PROMPTS) {
    const doc = await runGenerate(entry, llm);
    if (doc) generated.push({ slug: entry.slug, doc });
  }

  let edited = false;
  const base = generated[0];
  if (base) {
    edited = await runEdit(base.doc, base.slug, llm);
  } else {
    console.error("skipping edit stage: no generated document to edit");
  }

  const ok = generated.length === SMOKE_PROMPTS.length && edited;
  console.log(
    `summary: generated=${generated.length}/${SMOKE_PROMPTS.length} edited=${edited} result=${ok ? "PASS" : "FAIL"}`
  );
  return ok;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runSmoke()
    .then((ok) => {
      if (!ok) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(`llm:smoke crashed: ${messageOf(error)}`);
      process.exitCode = 1;
    });
}
