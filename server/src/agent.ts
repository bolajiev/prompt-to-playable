import type { GameDoc } from "@prompt-to-playable/schema";
import type { KitArchetype } from "./classifier.js";
import { MAX_REPAIR_RETRIES } from "./repair.js";
import type { RepairError } from "./repair.js";
import { RouteError } from "./routes.js";
import { sanityCheck } from "./sanity.js";
import type { SanityResult } from "./sanity.js";
import { simulateDoc } from "./simulate.js";
import type { SimulateResult } from "./simulate.js";
import { validateDoc } from "./validate.js";
import type { ValidationOutcome } from "./validate.js";

/**
 * Tool-using generation agent. The loop mirrors the manual pipeline
 * (classify -> generate -> validate -> sanity) and adds a headless
 * `simulate` gate plus a visible, ordered trace of every tool call:
 *
 *   plan -> generate -> validate -> sanity -> simulate -> finalize
 *
 * A failing validate / sanity / simulate stage calls `repair` with the exact
 * failure text (simulate failures included) and then re-runs the whole chain
 * from validation. Repair budget: at most `MAX_REPAIR_RETRIES` (2) attempts
 * per stage and at most `MAX_AGENT_REPAIRS` (3) in total across all stages;
 * hitting either cap raises RouteError REPAIR_EXHAUSTED with every failure.
 *
 * Tool steps contain no raw document text and no secrets: details are short
 * human summaries only.
 */

export type AgentStepStatus = "ok" | "fail" | "skipped";

export interface AgentStep {
  tool: string;
  status: AgentStepStatus;
  detail: string;
  ms: number;
}

export interface AgentResult {
  doc: GameDoc;
  steps: AgentStep[];
  repairs: number;
}

/** Total repair attempts allowed across all stages (stated budget). */
export const MAX_AGENT_REPAIRS = 3;
/** Repair attempts allowed per failing stage before giving up early. */
export const MAX_STAGE_REPAIRS = MAX_REPAIR_RETRIES;

export interface AgentDeps {
  /** Tool `plan`: classify the prompt into a kit/archetype. */
  plan(prompt: string): Promise<KitArchetype>;
  /** Tool `generate`: produce a candidate document. */
  generate(prompt: string, archetype: KitArchetype): Promise<unknown>;
  /** Tool `repair`: fix a document given failure text/issues. */
  repair(
    doc: unknown,
    errors: readonly RepairError[],
    attempt: number
  ): Promise<unknown>;
  /** Injectable tools (defaults: zod validate, sanity checks, headless engine). */
  validate?(doc: unknown): ValidationOutcome;
  sanity?(doc: GameDoc): SanityResult;
  simulate?(doc: GameDoc): SimulateResult;
  maxRepairs?: number;
  maxStageRepairs?: number;
  /** Clock for step timings (defaults to Date.now; injectable for tests). */
  now?: () => number;
}

type Stage = "validate" | "sanity" | "simulate";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathDetail(issue: { path: string; message: string }): string {
  return issue.path === "(root)" ? issue.message : `${issue.path}: ${issue.message}`;
}

function summarizeIssues(issues: readonly (string | { message: string })[]): string {
  const first = issues[0];
  const firstText = typeof first === "string" ? first : first?.message;
  const extra = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return firstText === undefined ? "failed" : `${firstText}${extra}`;
}

function describeGenerated(doc: unknown): string {
  if (typeof doc === "object" && doc !== null) {
    const entities = (doc as { entities?: unknown }).entities;
    if (Array.isArray(entities)) {
      return `generated ${entities.length} entities`;
    }
  }
  return "generated an unparseable document";
}

export async function runAgent(
  prompt: string,
  deps: AgentDeps
): Promise<AgentResult> {
  const now = deps.now ?? (() => Date.now());
  const validate = deps.validate ?? validateDoc;
  const sanity = deps.sanity ?? sanityCheck;
  const simulate = deps.simulate ?? simulateDoc;
  const maxRepairs = deps.maxRepairs ?? MAX_AGENT_REPAIRS;
  const maxStageRepairs = deps.maxStageRepairs ?? MAX_STAGE_REPAIRS;

  const steps: AgentStep[] = [];
  const failures: string[] = [];
  const stageRepairs: Record<Stage, number> = {
    validate: 0,
    sanity: 0,
    simulate: 0,
  };
  let repairs = 0;

  const record = (
    tool: string,
    status: AgentStepStatus,
    detail: string,
    startedAt: number
  ): void => {
    steps.push({
      tool,
      status,
      detail,
      ms: Math.max(0, Math.round(now() - startedAt)),
    });
  };

  let startedAt = now();
  let archetype: KitArchetype;
  try {
    archetype = await deps.plan(prompt);
    record("plan", "ok", `kit: ${archetype}`, startedAt);
  } catch (error) {
    record("plan", "fail", messageOf(error), startedAt);
    throw new RouteError("GENERATION_FAILED", "Game classification failed", [
      ...failures,
      `plan: ${messageOf(error)}`,
    ]);
  }

  startedAt = now();
  let doc: unknown;
  try {
    doc = await deps.generate(prompt, archetype);
    record("generate", "ok", describeGenerated(doc), startedAt);
  } catch (error) {
    doc = undefined;
    const failure = `generator: ${messageOf(error)}`;
    failures.push(failure);
    record("generate", "fail", messageOf(error), startedAt);
  }

  const tryRepair = async (
    stage: Stage,
    current: unknown,
    errors: readonly RepairError[]
  ): Promise<boolean> => {
    if (repairs >= maxRepairs || stageRepairs[stage] >= maxStageRepairs) {
      return false;
    }
    stageRepairs[stage] += 1;
    repairs += 1;
    const repairStartedAt = now();
    try {
      doc = await deps.repair(current, errors, repairs);
      record(
        "repair",
        "ok",
        `${stage}: fixed ${errors.length} issue${errors.length === 1 ? "" : "s"} (attempt ${repairs})`,
        repairStartedAt
      );
      return true;
    } catch (error) {
      const failure = `repair attempt ${repairs}: ${messageOf(error)}`;
      failures.push(failure);
      record("repair", "fail", failure, repairStartedAt);
      // A thrown repair still consumes budget; retry the stage when any
      // budget remains so the failure surfaces through the normal path.
      return repairs < maxRepairs;
    }
  };

  const exhausted = (): RouteError =>
    new RouteError(
      "REPAIR_EXHAUSTED",
      `Generation failed after ${repairs} repair${repairs === 1 ? "" : "s"}`,
      failures
    );

  for (;;) {
    startedAt = now();
    const validation = validate(doc);
    if (!validation.ok || !validation.data) {
      const issues = validation.issues.map(pathDetail);
      failures.push(...issues);
      record("validate", "fail", summarizeIssues(issues), startedAt);
      if (!(await tryRepair("validate", doc, validation.issues))) {
        throw exhausted();
      }
      continue;
    }
    const validated = validation.data;
    record(
      "validate",
      "ok",
      `${validated.entities.length} entities, schema ok`,
      startedAt
    );

    startedAt = now();
    const sanityResult = sanity(validated);
    if (!sanityResult.ok) {
      const issues = sanityResult.errors.map(
        (issue) => `${issue.path}: ${issue.message} [${issue.code}]`
      );
      failures.push(...issues);
      record("sanity", "fail", summarizeIssues(issues), startedAt);
      if (!(await tryRepair("sanity", validated, sanityResult.errors))) {
        throw exhausted();
      }
      continue;
    }
    record("sanity", "ok", "no sanity issues", startedAt);

    startedAt = now();
    const simulated = simulate(validated);
    if (!simulated.ok) {
      failures.push(...simulated.failures);
      record("simulate", "fail", summarizeIssues(simulated.failures), startedAt);
      if (!(await tryRepair("simulate", validated, simulated.failures))) {
        throw exhausted();
      }
      continue;
    }
    record("simulate", "ok", `simulated ${simulated.checks.length} checks`, startedAt);

    startedAt = now();
    record(
      "finalize",
      "ok",
      `shipped ${validated.entities.length} entities`,
      startedAt
    );
    return { doc: validated, steps, repairs };
  }
}
