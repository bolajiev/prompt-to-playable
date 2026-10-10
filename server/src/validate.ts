import { validateGame } from "@prompt-to-playable/schema";
import type { GameDoc } from "@prompt-to-playable/schema";
import type { ZodError } from "zod";
import { sanityCheck } from "./sanity.js";
import type { SanityResult } from "./sanity.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationOutcome {
  ok: boolean;
  data?: GameDoc;
  issues: ValidationIssue[];
}

export interface ValidationReport {
  ok: boolean;
  data?: GameDoc;
  validation: ValidationOutcome;
  sanity: SanityResult;
}

export function formatPath(segments: readonly (string | number | symbol)[]): string {
  let path = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      path += `[${segment}]`;
    } else if (path === "") {
      path += String(segment);
    } else {
      path += `.${String(segment)}`;
    }
  }
  return path || "(root)";
}

function formatIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

export function validateDoc(doc: unknown): ValidationOutcome {
  const result = validateGame(doc);
  if (result.ok && result.data) {
    return { ok: true, data: result.data, issues: [] };
  }
  if (result.error) {
    return { ok: false, issues: formatIssues(result.error) };
  }
  return { ok: false, issues: [{ path: "(root)", message: "document is not a game" }] };
}

export function validateAndSanity(doc: unknown): ValidationReport {
  const validation = validateDoc(doc);
  if (!validation.ok) {
    return {
      ok: false,
      validation,
      sanity: { ok: true, errors: [] },
    };
  }
  const sanity = sanityCheck(validation.data as GameDoc);
  return {
    ok: sanity.ok,
    data: validation.data,
    validation,
    sanity,
  };
}