import type { GameDoc } from "@prompt-to-playable/schema";
import { MAX_REPAIR_RETRIES } from "./repair.js";
import type { LlmCall } from "./llm.js";
import {
  PatchError,
  applyPatch,
  validatePatch,
} from "./patch.js";
import type { JsonPatch } from "./patch.js";
import { RouteError } from "./routes.js";
import { sanityCheck } from "./sanity.js";
import type { SanityIssue } from "./sanity.js";
import { validateDoc } from "./validate.js";
import type { ValidationIssue } from "./validate.js";

export interface EditResult {
  doc: GameDoc;
  patch: JsonPatch;
}

export interface EditAttemptContext {
  errors: readonly string[];
  attempt: number;
}

export type PatchGeneratorFn = (
  prompt: string,
  doc: GameDoc,
  history: readonly unknown[],
  context: EditAttemptContext
) => Promise<unknown>;

export interface EditPipelineDeps {
  generatePatch: PatchGeneratorFn;
  maxRepairs?: number;
}

export interface EditPipeline {
  editGame: (
    prompt: string,
    doc: GameDoc,
    history?: readonly unknown[]
  ) => Promise<EditResult>;
}

export interface EditPromptInput {
  prompt: string;
  doc: unknown;
  history?: readonly unknown[];
  errors?: readonly string[];
  attempt?: number;
  maxRetries?: number;
}

const SUPPORTED_OPS = "add, remove, replace";

interface EditDocProfile {
  archetype: string | undefined;
  mode: string | undefined;
}

function profileOf(doc: unknown): EditDocProfile {
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

/**
 * Kit-specific edit constraints. `mode` wins when present; otherwise explore
 * scenes are detected by archetype (matching the engine's resolveMode).
 */
function kitConstraints(profile: EditDocProfile): string[] {
  if (profile.mode === "inspect") {
    return [
      "- This is an inspect showcase: keep objectives empty, never add zones or",
      "  win/lose actions, keep at least one entity with parts or a label, and keep",
      "  the click rules that open panels, highlight parts or focus the camera.",
    ];
  }
  if (profile.mode === "walkthrough") {
    return [
      "- This is a walkthrough interior: keep objectives empty, never add zones or",
      "  win/lose actions, keep the player and at least one interactable (door or",
      "  lamp) with its interact rules intact.",
    ];
  }
  if (profile.mode === "drive") {
    return [
      "- This is a drive race: keep player props.vehicle true, keep at least three",
      "  checkpoint zone entities with distinct integer props.checkpointIndex",
      "  values covering 0..n-1 in order, and keep a rule that can win the race.",
    ];
  }
  if (profile.mode === "world") {
    return [
      "- This is an open world sandbox: keep objectives empty, never add zones or",
      "  win/lose actions, keep the player and at least one button whose onPress",
      "  spawns an entity with a new id, and keep every control bind targeting an",
      "  existing entity (new ids only inside spawn payloads).",
    ];
  }
  if (profile.archetype === "explore") {
    return [
      "- This is an explore scene: keep objectives empty and never add win/lose",
      "  actions or zone entities; new decorative entities are welcome.",
    ];
  }
  return ["- Keep the game winnable."];
}

export function buildEditPrompt(input: EditPromptInput): string {
  const history = input.history ?? [];
  const errors = input.errors ?? [];
  const profile = profileOf(input.doc);
  const lines: string[] = [
    "You edit an existing game document.",
    "",
    "Respond with ONLY an RFC 6902 JSON Patch: a JSON array of operations.",
    "Do not return the full document. Do not add commentary or markdown fences.",
    "",
    `Supported operations: ${SUPPORTED_OPS}.`,
    "Each operation is an object such as:",
    '  { "op": "replace", "path": "/meta/title", "value": "New title" }',
    '  { "op": "add", "path": "/entities/-", "value": { ...entity... } }',
    '  { "op": "remove", "path": "/entities/2" }',
    'Use JSON Pointer paths (RFC 6901); array indexes are zero-based and "-" appends.',
    "",
    "Document vocabulary you may use in added or replaced values:",
    '- entities support "parts": [ { "shape", "offset", "size", optional "rotation",',
    '  "color", "material": { "texture", "metalness", "roughness", "emissive",',
    '  "opacity" } } ] and "label": { "text", optional "offset", optional "size" }',
    "  for assemblies and captions.",
    '- actions support setVisible, setColor, animate (spin|bob|pulse|slide|orbit),',
    "  cameraFocus, showPanel and hidePanel; rules may trigger on click, hoverEnter",
    "  and hoverLeave. Never animate the player or an enemy entity.",
    "",
    "Constraints:",
    "- Make the smallest patch that satisfies the request.",
    "- Keep every position and patrol point inside world.bounds.",
    "- Keep every entity/objective id referenced by objectives or rules defined.",
    "- Keep exactly one player entity.",
    ...kitConstraints(profile),
    "",
    "Current document:",
    JSON.stringify(input.doc, null, 2),
    "",
  ];

  if (history.length > 0) {
    lines.push("Recent change history (oldest first):", JSON.stringify(history, null, 2), "");
  }

  lines.push(`User request: ${input.prompt}`, "");

  if (errors.length > 0) {
    lines.push(
      `Your previous patch was rejected (attempt ${input.attempt ?? 1} of ${
        input.maxRetries ?? MAX_REPAIR_RETRIES
      }). Fix ALL of the following problems:`,
      ...errors.map((error, i) => `${i + 1}. ${error}`),
      ""
    );
  }

  lines.push("Return the JSON Patch:");
  return lines.join("\n");
}

function extractJsonArray(raw: string): string {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new PatchError("Edit response contained no JSON array");
  }
  return raw.slice(start, end + 1);
}

export function parseJsonPatch(raw: string): JsonPatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonArray(raw));
  } catch (error) {
    if (error instanceof PatchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PatchError(`Edit response was not valid JSON: ${message}`);
  }
  const validation = validatePatch(parsed);
  if (!validation.ok || !validation.patch) {
    throw new PatchError(
      `Edit response was not a valid JSON Patch: ${validation.issues.join("; ")}`
    );
  }
  return validation.patch;
}

export async function generatePatch(
  prompt: string,
  doc: GameDoc,
  history: readonly unknown[],
  llm: LlmCall,
  context: { errors?: readonly string[]; attempt?: number; maxRetries?: number } = {}
): Promise<JsonPatch> {
  const text = await llm(
    buildEditPrompt({
      prompt,
      doc,
      history,
      errors: context.errors,
      attempt: context.attempt,
      maxRetries: context.maxRetries,
    })
  );
  return parseJsonPatch(text);
}

export function createDefaultEditDeps(llm: LlmCall): EditPipelineDeps {
  return {
    generatePatch: (prompt, doc, history, context) =>
      generatePatch(prompt, doc, history, llm, {
        errors: context.errors,
        attempt: context.attempt,
        maxRetries: MAX_REPAIR_RETRIES,
      }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeValidation(issue: ValidationIssue): string {
  return issue.path === "(root)" ? issue.message : `${issue.path}: ${issue.message}`;
}

function describeSanity(issue: SanityIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

export async function editGame(
  prompt: string,
  doc: GameDoc,
  history: readonly unknown[],
  deps: EditPipelineDeps
): Promise<EditResult> {
  const maxRepairs = deps.maxRepairs ?? MAX_REPAIR_RETRIES;
  const failures: string[] = [];
  let repairs = 0;
  let errors: string[] = [];

  for (;;) {
    const pushFailures = (next: readonly string[]): void => {
      for (const failure of next) failures.push(failure);
    };

    let rawPatch: unknown;
    try {
      rawPatch = await deps.generatePatch(prompt, doc, history, {
        errors,
        attempt: repairs,
      });
    } catch (error) {
      const failure = `patch generator: ${messageOf(error)}`;
      failures.push(failure);
      if (repairs >= maxRepairs) break;
      repairs += 1;
      errors = [failure];
      continue;
    }

    const patchValidation = validatePatch(rawPatch);
    if (!patchValidation.ok || !patchValidation.patch) {
      pushFailures(patchValidation.issues);
      if (repairs >= maxRepairs) break;
      repairs += 1;
      errors = patchValidation.issues.slice();
      continue;
    }

    let patched: unknown;
    try {
      patched = applyPatch(doc, patchValidation.patch);
    } catch (error) {
      const failure = `apply patch: ${messageOf(error)}`;
      failures.push(failure);
      if (repairs >= maxRepairs) break;
      repairs += 1;
      errors = [failure];
      continue;
    }

    const validation = validateDoc(patched);
    if (!validation.ok || !validation.data) {
      const next = validation.issues.map(describeValidation);
      pushFailures(next);
      if (repairs >= maxRepairs) break;
      repairs += 1;
      errors = next;
      continue;
    }

    const sanity = sanityCheck(validation.data);
    if (!sanity.ok) {
      const next = sanity.errors.map(describeSanity);
      pushFailures(next);
      if (repairs >= maxRepairs) break;
      repairs += 1;
      errors = next;
      continue;
    }

    return { doc: validation.data, patch: patchValidation.patch };
  }

  throw new RouteError(
    "EDIT_FAILED",
    `Edit failed after ${maxRepairs} repair${maxRepairs === 1 ? "" : "s"}`,
    failures
  );
}

export function createEditPipeline(deps: EditPipelineDeps): EditPipeline {
  return {
    editGame: (prompt, doc, history = []) => editGame(prompt, doc, history, deps),
  };
}
