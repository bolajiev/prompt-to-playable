import type { SanityIssue } from "./sanity.js";
import type { ValidationIssue } from "./validate.js";

export const MAX_REPAIR_RETRIES = 2;

export type RepairError =
  | string
  | ValidationIssue
  | SanityIssue;

export interface RepairPromptInput {
  doc?: unknown;
  errors: readonly RepairError[];
  attempt?: number;
  maxRetries?: number;
}

function errorMessage(error: RepairError): string {
  if (typeof error === "string") return error;
  return error.message;
}

export function buildRepairPrompt(input: RepairPromptInput): string {
  const attempt = input.attempt ?? 1;
  const maxRetries = input.maxRetries ?? MAX_REPAIR_RETRIES;
  const messages = input.errors.map(errorMessage);
  const docJson =
    input.doc === undefined
      ? "(original document was not provided)"
      : JSON.stringify(input.doc, null, 2);

  return [
    "Your previously generated game document failed validation.",
    "",
    `Attempt ${attempt} of ${maxRetries}. Fix ALL of the following errors:`,
    "",
    ...messages.map((message, i) => `${i + 1}. ${message}`),
    "",
    "Respond with ONLY the corrected full game JSON document that matches",
    "the game schema (version \"1.0.0\"). Do not add commentary, markdown",
    "fences, or extra keys. The document must include version, meta, world,",
    "entities (including a player), objectives, rules, and scratch as required",
    "by the schema.",
    "",
    "Failed document (for reference):",
    docJson,
    "",
    "Return corrected JSON:",
  ].join("\n");
}

export function describeRepairFailure(
  errors: readonly RepairError[]
): { error: string; details: string[] } {
  return {
    error: "VALIDATION_FAILED",
    details: errors.map(errorMessage),
  };
}