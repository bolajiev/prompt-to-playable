import type { Archetype, GameDoc } from "@prompt-to-playable/schema";
import { classify } from "./classifier.js";
import { generate, parseGameDoc } from "./generator.js";
import type { LlmCall } from "./llm.js";
import { MAX_REPAIR_RETRIES, buildRepairPrompt } from "./repair.js";
import type { RepairError } from "./repair.js";
import { RouteError } from "./routes.js";
import { sanityCheck } from "./sanity.js";
import { validateDoc } from "./validate.js";

export type ClassifierFn = (prompt: string) => Promise<Archetype>;
export type GeneratorFn = (prompt: string, archetype: Archetype) => Promise<unknown>;
export type RepairerFn = (
  doc: unknown,
  errors: readonly RepairError[],
  attempt: number
) => Promise<unknown>;

export interface GenerationPipelineDeps {
  classifier: ClassifierFn;
  generator: GeneratorFn;
  repairer: RepairerFn;
  maxRepairs?: number;
}

export function createLlmRepairer(llm: LlmCall): RepairerFn {
  return async (doc, errors, attempt) => {
    const prompt = buildRepairPrompt({
      doc,
      errors,
      attempt,
      maxRetries: MAX_REPAIR_RETRIES,
    });
    return parseGameDoc(await llm(prompt));
  };
}

export function createDefaultPipelineDeps(llm: LlmCall): GenerationPipelineDeps {
  return {
    classifier: (prompt) => classify(prompt, llm),
    generator: (prompt, archetype) => generate(prompt, archetype, llm),
    repairer: createLlmRepairer(llm),
  };
}

function detailOf(error: RepairError): string {
  if (typeof error === "string") return error;
  return error.path === "(root)" ? error.message : `${error.path}: ${error.message}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attemptRepair(
  repairer: RepairerFn,
  doc: unknown,
  errors: readonly RepairError[],
  attempt: number,
  failures: string[]
): Promise<unknown> {
  try {
    return await repairer(doc, errors, attempt);
  } catch (error) {
    failures.push(`repair attempt ${attempt}: ${messageOf(error)}`);
    return undefined;
  }
}

async function runPipeline(
  prompt: string,
  deps: GenerationPipelineDeps
): Promise<GameDoc> {
  const maxRepairs = deps.maxRepairs ?? MAX_REPAIR_RETRIES;
  const archetype = await deps.classifier(prompt).catch((error: unknown) => {
    throw new RouteError("GENERATION_FAILED", "Game classification failed", [
      `classifier: ${messageOf(error)}`,
    ]);
  });

  const failures: string[] = [];
  let repairs = 0;
  let doc: unknown;

  try {
    doc = await deps.generator(prompt, archetype);
  } catch (error) {
    doc = undefined;
    failures.push(`generator: ${messageOf(error)}`);
  }

  for (;;) {
    const validation = validateDoc(doc);
    if (validation.ok && validation.data) {
      const sanity = sanityCheck(validation.data);
      if (sanity.ok) return validation.data;
      for (const issue of sanity.errors) failures.push(detailOf(issue));
      if (repairs >= maxRepairs) break;
      repairs += 1;
      doc = await attemptRepair(
        deps.repairer,
        validation.data,
        sanity.errors,
        repairs,
        failures
      );
      continue;
    }

    for (const issue of validation.issues) failures.push(detailOf(issue));
    if (repairs >= maxRepairs) break;
    repairs += 1;
    doc = await attemptRepair(deps.repairer, doc, validation.issues, repairs, failures);
  }

  throw new RouteError(
    "REPAIR_EXHAUSTED",
    `Generation failed after ${maxRepairs} repair${maxRepairs === 1 ? "" : "s"}`,
    failures
  );
}

export async function generateGame(
  prompt: string,
  deps: GenerationPipelineDeps
): Promise<GameDoc> {
  return runPipeline(prompt, deps);
}

export function createGenerationPipeline(deps: GenerationPipelineDeps): {
  generateGame: (prompt: string) => Promise<GameDoc>;
} {
  return {
    generateGame: (prompt: string) => runPipeline(prompt, deps),
  };
}
