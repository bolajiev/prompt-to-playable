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

interface RepairDocProfile {
  archetype: string | undefined;
  mode: string | undefined;
}

function profileOf(doc: unknown): RepairDocProfile {
  if (typeof doc !== "object" || doc === null) {
    return { archetype: undefined, mode: undefined };
  }
  const meta = (doc as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) {
    return { archetype: undefined, mode: undefined };
  }
  const archetype = (meta as { archetype?: unknown }).archetype;
  const mode = (meta as { mode?: unknown }).mode;
  return {
    archetype: typeof archetype === "string" ? archetype : undefined,
    mode: typeof mode === "string" ? mode : undefined,
  };
}

/** Kit constraints keep repaired documents inside their sanity branch. */
function kitNote(doc: unknown): string[] {
  const profile = profileOf(doc);
  if (profile.mode === "inspect") {
    return [
      "Kit note (inspect): keep NO objectives, NO zones and NO win/lose actions;",
      "keep at least one entity with parts or a label and at least one rule with",
      "an on.click trigger that shows a panel and/or recolors the clicked part.",
    ];
  }
  if (profile.mode === "walkthrough") {
    return [
      "Kit note (walkthrough): keep NO objectives, NO zones and NO win/lose",
      "actions; keep the player and at least one interactable entity (door or",
      "lamp) with its interact rules.",
    ];
  }
  if (profile.mode === "drive") {
    return [
      "Kit note (drive): keep player props.vehicle true, keep at least three",
      "checkpoint zones with distinct integer props.checkpointIndex values 0..n-1",
      "in order, and keep a rule whose actions include a win.",
    ];
  }
  if (profile.mode === "machine") {
    return [
      "Kit note (machine): keep objectives empty, never add zones or win/lose",
      "actions; keep at least one slider whose bind.entity and bind.property",
      "name an existing entity, keep every bind.entity real, and keep the",
      "clickable labeled parts with their showPanel rules.",
    ];
  }
  if (profile.archetype === "explore") {
    return [
      "Kit note (explore): keep objectives empty, never add zone entities or",
      "win/lose actions, and reference only ids that exist in the document.",
    ];
  }
  return [];
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
    ...kitNote(input.doc),
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