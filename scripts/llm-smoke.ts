import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ArchetypeSchema, GameModeSchema, validateGame } from "@prompt-to-playable/schema";
import type { Archetype, GameDoc, GameMode } from "@prompt-to-playable/schema";
import { createDefaultEditDeps, editGame } from "../server/src/edit.js";
import { loadEnvFile } from "../server/src/env.js";
import { DEFAULT_LLM_MODEL, createOpenAiLlm } from "../server/src/llm.js";
import type { LlmCall } from "../server/src/llm.js";
import { createDefaultPipelineDeps, generateGame } from "../server/src/pipeline.js";
import { RouteError } from "../server/src/routes.js";
import {
  hasWinPath,
  requiresWinPath,
  resolveKit,
  sanityCheck,
} from "../server/src/sanity.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, "server", ".env");
const FIXTURES_DIR = join(ROOT, "tests", "fixtures");

const CALL_ATTEMPTS = 3;

const USAGE =
  "usage: npm run llm:smoke [-- --prompts <file>] [--no-edit] [--no-write] [--capture-fixtures]\n" +
  "  --prompts <file>  JSON array of {slug, prompt, expectArchetype?, expectMode?,\n" +
  "                    fixture?, editOf?} entries instead of the defaults;\n" +
  "                    expectArchetype/expectMode are checked after generation,\n" +
  "                    fixture names an explicit tests/fixtures capture target and\n" +
  "                    editOf marks an edit of that generated slug\n" +
  "  --no-edit         skip entries with editOf (the conversational-edit stage)\n" +
  "  --no-write        validate and report only; do not write tests/fixtures/live-*.json\n" +
  "  --capture-fixtures  with --no-write, still write entries that declare an explicit\n" +
  "                    \"fixture\" file (exact JSON of a successful run, deliberate capture)";

export interface SmokePrompt {
  slug: string;
  prompt: string;
  /** Judge-style expectation; a mismatch is reported as ARCHETYPE_MISMATCH. */
  expectArchetype?: Archetype;
  /** Kit expectation checked against `meta.mode`; mismatch is MODE_MISMATCH. */
  expectMode?: GameMode;
  /** Explicit tests/fixtures/<name>.json capture target for this entry. */
  fixture?: string;
  /** Slug of the generated document this conversational-edit prompt mutates. */
  editOf?: string;
}

const FIXTURE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

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
  const file = join(FIXTURES_DIR, name);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return file;
}

/** Output file for an entry: an explicit `fixture` name or the live-<slug> default. */
function fixtureName(entry: SmokePrompt, kind: "generate" | "edit"): string {
  if (entry.fixture !== undefined) return entry.fixture;
  if (kind === "edit") return `live-${String(entry.editOf)}-edit.json`;
  return `live-${entry.slug}.json`;
}

interface KitCheck {
  kit: GameMode;
  label: string;
  usable: boolean;
  failure?: string;
}

function kitOk(kit: GameMode): KitCheck {
  return { kit, label: kit, usable: true };
}

function kitFail(kit: GameMode, failure: string): KitCheck {
  return { kit, label: kit, usable: false, failure };
}

/**
 * Kit usability gates used for the `usable=<kit>` label. These mirror the
 * sanity kit gates and add the soft explore no-zones rule:
 * inspect: >=1 entity with parts or a label + >=1 click rule;
 * walkthrough: player + >=1 interactable; drive: vehicle + >=3 checkpoint
 * zones + a win path; machine: a bound slider, resolvable binds, a parent
 * chain with a rotation slider on a parented joint, a toggle, an animate
 * button and clickable labeled panels; game: a win path; explore: no zones.
 */
function kitCheck(doc: GameDoc): KitCheck {
  const kit = resolveKit(doc);
  switch (kit) {
    case "inspect": {
      const hasContent = doc.entities.some(
        (entity) => (entity.parts?.length ?? 0) > 0 || entity.label !== undefined
      );
      if (!hasContent) return kitFail(kit, "INSPECT_NO_CONTENT");
      if (!doc.rules.some((rule) => rule.on.event === "click")) {
        return kitFail(kit, "INSPECT_NO_CLICK_RULE");
      }
      return kitOk(kit);
    }
    case "walkthrough": {
      const hasPlayer = doc.entities.some(
        (entity) => entity.kind === "player" || entity.id === "player"
      );
      if (!hasPlayer) return kitFail(kit, "WALKTHROUGH_NO_PLAYER");
      const hasInteractable = doc.entities.some(
        (entity) => entity.kind === "interactable" || entity.tags.includes("interactable")
      );
      if (!hasInteractable) return kitFail(kit, "WALKTHROUGH_NO_INTERACTABLE");
      return kitOk(kit);
    }
    case "drive": {
      const player = doc.entities.find(
        (entity) => entity.kind === "player" || entity.id === "player"
      );
      if (player?.props?.vehicle !== true) return kitFail(kit, "DRIVE_NO_VEHICLE");
      const checkpoints = doc.entities.filter(
        (entity) =>
          entity.kind === "zone" && typeof entity.props?.checkpointIndex === "number"
      );
      if (checkpoints.length < 3) return kitFail(kit, "DRIVE_CHECKPOINTS_LT3");
      if (!hasWinPath(doc)) return kitFail(kit, "DRIVE_NO_WIN");
      return kitOk(kit);
    }
    case "machine": {
      const controls = doc.controls ?? [];
      const ids = new Set(doc.entities.map((entity) => entity.id));
      if (
        !controls.some(
          (control) =>
            control.type === "slider" &&
            control.bind?.entity !== undefined &&
            control.bind.property !== undefined
        )
      ) {
        return kitFail(kit, "MACHINE_NO_SLIDER_BIND");
      }
      if (
        controls.some(
          (control) =>
            control.bind?.entity !== undefined && !ids.has(control.bind.entity)
        )
      ) {
        return kitFail(kit, "MACHINE_UNKNOWN_BIND");
      }
      // Forward kinematics: the arm must be a parent chain (base -> joints ->
      // gripper) so a joint slider swings everything downstream of it.
      const parented = doc.entities.filter(
        (entity) => entity.parent !== undefined
      );
      if (parented.length < 3) return kitFail(kit, "MACHINE_NO_PARENT_CHAIN");
      if (parented.some((entity) => !ids.has(String(entity.parent)))) {
        return kitFail(kit, "MACHINE_UNKNOWN_PARENT");
      }
      if (
        !controls.some(
          (control) =>
            control.type === "slider" &&
            (control.bind?.property ?? "").startsWith("rotation.") &&
            parented.some((entity) => entity.id === control.bind?.entity)
        )
      ) {
        return kitFail(kit, "MACHINE_NO_JOINT_SLIDER");
      }
      // A yaw slider on the root turret so the whole chain can swing.
      if (
        !controls.some(
          (control) =>
            control.type === "slider" &&
            control.bind?.property === "rotation.y" &&
            doc.entities.some(
              (entity) =>
                entity.id === control.bind?.entity && entity.parent === undefined
            )
        )
      ) {
        return kitFail(kit, "MACHINE_NO_BASE_YAW");
      }
      if (!controls.some((control) => control.type === "toggle")) {
        return kitFail(kit, "MACHINE_NO_TOGGLE");
      }
      if (
        !controls.some(
          (control) =>
            control.type === "button" &&
            (control.bind?.onPress ?? []).some((action) => action.type === "animate")
        )
      ) {
        return kitFail(kit, "MACHINE_NO_ANIMATE_BUTTON");
      }
      const labeledClick = doc.rules.some(
        (rule) =>
          rule.on.event === "click" &&
          rule.then.some((action) => action.type === "showPanel") &&
          doc.entities.some(
            (entity) =>
              entity.id === rule.on.entity && entity.label !== undefined
          )
      );
      if (!labeledClick) return kitFail(kit, "MACHINE_NO_LABELED_PANEL");
      return kitOk(kit);
    }
    case "explore": {
      if (doc.entities.some((entity) => entity.kind === "zone")) {
        return kitFail(kit, "EXPLORE_ZONES_PRESENT");
      }
      return kitOk(kit);
    }
    case "game": {
      if (!hasWinPath(doc)) return kitFail(kit, "NO_WIN_PATH");
      return kitOk(kit);
    }
  }
}

interface DocCheck {
  valid: boolean;
  sanity: boolean;
  isExplore: boolean;
  winnable: boolean;
  objectives: number;
  zones: number;
  explorable: boolean;
  solvable: boolean;
  kit: KitCheck;
  errors: string[];
}

function checkDoc(doc: GameDoc): DocCheck {
  const validation = validateGame(doc);
  if (!validation.ok || !validation.data) {
    const errors =
      validation.error?.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
      ) ?? ["document is not a game"];
    const mode = GameModeSchema.safeParse(doc?.meta?.mode);
    const kit: GameMode = mode.success
      ? mode.data
      : doc?.meta?.archetype === "explore"
        ? "explore"
        : "game";
    return {
      valid: false,
      sanity: false,
      isExplore: false,
      winnable: false,
      objectives: 0,
      zones: 0,
      explorable: false,
      solvable: false,
      kit: kitFail(kit, "SCHEMA"),
      errors,
    };
  }
  const data = validation.data;
  const sanity = sanityCheck(data);
  const isExplore = data.meta.archetype === "explore";
  const errors = sanity.errors.map((issue) => `${issue.path}: ${issue.message}`);
  const winnable = !requiresWinPath(data) || hasWinPath(data);
  if (!winnable) errors.push("(root): no rule wins the game");
  const zones = data.entities.filter((entity) => entity.kind === "zone").length;
  const kit = kitCheck(data);
  if (isExplore && data.objectives.length > 0) {
    errors.push(
      `objectives: explore scene has ${data.objectives.length} objective(s); expected none`
    );
  }
  if (!kit.usable && kit.failure !== undefined) {
    errors.push(`kits: ${kit.failure}`);
  }
  return {
    valid: true,
    sanity: sanity.ok,
    isExplore,
    winnable,
    objectives: data.objectives.length,
    zones,
    explorable: isExplore && sanity.ok && data.objectives.length === 0 && zones === 0,
    solvable: !isExplore && sanity.ok && winnable,
    kit,
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
  if (!check.kit.usable) return check.kit.failure;
  if (check.isExplore) return check.objectives === 0 ? undefined : "OBJECTIVES_PRESENT";
  return check.solvable ? undefined : "NO_WIN_PATH";
}

function expectationFailure(
  doc: GameDoc,
  expectArchetype: Archetype | undefined,
  expectMode: GameMode | undefined
): string | undefined {
  if (expectArchetype !== undefined && doc.meta.archetype !== expectArchetype) {
    return "ARCHETYPE_MISMATCH";
  }
  if (expectMode !== undefined && doc.meta.mode !== expectMode) {
    return "MODE_MISMATCH";
  }
  return undefined;
}

interface RunOutcome {
  slug: string;
  kind: "generate" | "edit";
  label: string;
  expected?: Archetype;
  expectedMode?: GameMode;
  doc?: GameDoc;
  check?: DocCheck;
  failure?: string;
  usable: boolean;
  latencyMs: number;
  calls: number;
}

function report(outcome: RunOutcome): void {
  const produced = outcome.doc ? outcome.doc.meta.archetype : "n/a";
  const modeText =
    outcome.doc?.meta.mode !== undefined ? ` mode=${outcome.doc.meta.mode}` : "";
  const expectedParts: string[] = [];
  if (outcome.expected !== undefined) expectedParts.push(outcome.expected);
  if (outcome.expectedMode !== undefined) expectedParts.push(outcome.expectedMode);
  const mismatched =
    outcome.doc !== undefined &&
    ((outcome.expected !== undefined && produced !== outcome.expected) ||
      (outcome.expectedMode !== undefined &&
        outcome.doc.meta.mode !== outcome.expectedMode));
  const expected =
    expectedParts.length > 0
      ? ` expected=${expectedParts.join("/")}${mismatched ? " MISMATCH" : ""}`
      : "";
  const verdict = outcome.check
    ? outcome.check.isExplore
      ? `valid=${outcome.check.valid} explorable=${outcome.check.explorable}`
      : `valid=${outcome.check.valid} solvable=${outcome.check.solvable}`
    : "valid=false solvable=false";
  const usable =
    outcome.check !== undefined && outcome.usable
      ? ` usable=${outcome.check.kit.label}`
      : " usable=none";
  const failureSuffix = outcome.failure ? ` failure=${outcome.failure}` : "";
  console.log(
    `${outcome.label} -> ${produced}${modeText}${expected} -> ${verdict}${usable} latency=${outcome.latencyMs}ms calls=${outcome.calls}${failureSuffix}`
  );
}

async function runGenerate(
  entry: SmokePrompt,
  llm: LlmCall,
  counter: CallCounter,
  writeFixtures: boolean,
  captureFixtures: boolean
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
    ...(entry.expectMode !== undefined ? { expectedMode: entry.expectMode } : {}),
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
      usabilityFailure(check) ??
      expectationFailure(doc, entry.expectArchetype, entry.expectMode);
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
      if (outcome.failure === "MODE_MISMATCH") {
        console.error(
          `  expected mode ${String(entry.expectMode)}, produced ${String(doc.meta.mode)}`
        );
      }
      console.error(`  fixture not written: post-check failed for "${entry.prompt}"`);
      return outcome;
    }
    const name = fixtureName(entry, "generate");
    const shouldWrite = writeFixtures || (captureFixtures && entry.fixture !== undefined);
    console.log(
      shouldWrite
        ? `  fixture: tests/fixtures/${name}`
        : `  fixture: tests/fixtures/${name} (not written: --no-write)`
    );
    if (shouldWrite) writeFixture(name, doc);
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
  writeFixtures: boolean,
  captureFixtures: boolean
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
    ...(entry.expectMode !== undefined ? { expectedMode: entry.expectMode } : {}),
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
      expectationFailure(result.doc, entry.expectArchetype, entry.expectMode);
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
    const name = fixtureName(entry, "edit");
    const shouldWrite = writeFixtures || (captureFixtures && entry.fixture !== undefined);
    console.log(
      shouldWrite
        ? `  fixture: tests/fixtures/${name}`
        : `  fixture: tests/fixtures/${name} (not written: --no-write)`
    );
    if (shouldWrite) writeFixture(name, result.doc);
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
  captureFixtures?: boolean;
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
    const expectMode = record?.expectMode;
    if (expectMode !== undefined) {
      const result = GameModeSchema.safeParse(expectMode);
      if (!result.success) {
        throw new Error(
          `--prompts entry ${index} has invalid "expectMode": ${JSON.stringify(expectMode)}`
        );
      }
      parsed.expectMode = result.data;
    }
    const fixture = record?.fixture;
    if (fixture !== undefined) {
      if (typeof fixture !== "string" || !FIXTURE_NAME_PATTERN.test(fixture)) {
        throw new Error(
          `--prompts entry ${index} has invalid "fixture" (expected a plain "*.json" file name): ${JSON.stringify(
            fixture
          )}`
        );
      }
      parsed.fixture = fixture;
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
    } else if (arg === "--capture-fixtures") {
      options.captureFixtures = true;
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
  const captureFixtures = options.captureFixtures ?? false;
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
    const outcome = await runGenerate(entry, llm, counter, writeFixtures, captureFixtures);
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
        ...(entry.expectMode !== undefined ? { expectedMode: entry.expectMode } : {}),
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
    const outcome = await runEdit(entry, base, llm, counter, writeFixtures, captureFixtures);
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
  const kitOrder: readonly GameMode[] = [
    "inspect",
    "walkthrough",
    "drive",
    "machine",
    "game",
    "explore",
  ];
  const kitCounts = new Map<GameMode, { ok: number; total: number }>();
  for (const outcome of outcomes) {
    const label = outcome.check?.kit.label;
    if (label === undefined) continue;
    const tally = kitCounts.get(label) ?? { ok: 0, total: 0 };
    tally.total += 1;
    if (outcome.usable) tally.ok += 1;
    kitCounts.set(label, tally);
  }
  const kitText = kitOrder
    .filter((kit) => kitCounts.has(kit))
    .map((kit) => `${kit}:${kitCounts.get(kit)?.ok}/${kitCounts.get(kit)?.total}`)
    .join(" ");
  const genCalls = counter.calls - editCalls;
  const ok = generatedOk === generations.length && editedOk === editsToRun.length;
  console.log(
    `summary: generated=${generatedOk}/${generations.length} edited=${
      runEditStage ? `${editedOk}/${editsToRun.length}` : "skipped"
    } explorable=${explorable} kits=[${kitText}] genCalls=${genCalls} editCalls=${editCalls} transientRetries=${
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
