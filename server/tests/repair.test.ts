import { describe, expect, test } from "vitest";
import {
  buildRepairPrompt,
  describeRepairFailure,
  MAX_REPAIR_RETRIES,
} from "../src/repair.js";
import type { ValidationIssue } from "../src/validate.js";
import type { SanityIssue } from "../src/sanity.js";

const validationIssue: ValidationIssue = {
  path: "meta.archetype",
  message: "Invalid enum value. Expected 'collect-a-thon' | 'puzzle-switch' | 'platformer-lite' | 'stealth-chase', received 'racing'",
};

const sanityIssue: SanityIssue = {
  code: "missing-objective-target",
  path: "objectives[obj1].target",
  message: "Objective references unknown entity 'door'",
};

describe("MAX_REPAIR_RETRIES", () => {
  test("repair budget is capped at 2 retries", () => {
    expect(MAX_REPAIR_RETRIES).toBe(2);
  });
});

describe("buildRepairPrompt", () => {
  test("explains errors and asks for corrected schema-matching JSON", () => {
    const prompt = buildRepairPrompt({
      errors: [validationIssue, sanityIssue],
      doc: { version: "1.0.0" },
    });
    expect(prompt).toContain("failed validation");
    expect(prompt).toContain("Invalid enum value");
    expect(prompt).toContain("references unknown entity 'door'");
    expect(prompt).toContain('version "1.0.0"');
    expect(prompt).toContain('"version": "1.0.0"');
  });

  test("carries attempt and max retries into the prompt", () => {
    const prompt = buildRepairPrompt({ errors: ["broken"], attempt: 2, maxRetries: 2 });
    expect(prompt).toContain("Attempt 2 of 2");
  });

  test("defaults to attempt 1 of the max retries", () => {
    const prompt = buildRepairPrompt({ errors: ["broken"] });
    expect(prompt).toContain(`Attempt 1 of ${MAX_REPAIR_RETRIES}`);
  });

  test("accepts plain string errors and handles a missing doc", () => {
    const prompt = buildRepairPrompt({ errors: ["nope"] });
    expect(prompt).toContain("1. nope");
    expect(prompt).toContain("(original document was not provided)");
  });
});

describe("describeRepairFailure", () => {
  test("returns a structured failure with human-readable details", () => {
    const failure = describeRepairFailure(["one", validationIssue]);
    expect(failure).toEqual({
      error: "VALIDATION_FAILED",
      details: ["one", validationIssue.message],
    });
  });
});