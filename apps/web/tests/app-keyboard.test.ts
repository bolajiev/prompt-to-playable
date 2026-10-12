import { beforeAll, describe, expect, test } from "vitest";
import { isTextEntry } from "../src/app.js";

class FakeElement {
  isContentEditable = false;
}

class FakeInput extends FakeElement {}

class FakeTextArea extends FakeElement {}

class FakeButton extends FakeElement {}

function asTarget(value: unknown): EventTarget {
  return value as EventTarget;
}

beforeAll(() => {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.HTMLElement = FakeElement;
  globals.HTMLInputElement = FakeInput;
  globals.HTMLTextAreaElement = FakeTextArea;
  globals.HTMLButtonElement = FakeButton;
});

describe("keyboard capture target", () => {
  test("ignores text entry targets", () => {
    expect(isTextEntry(asTarget(new FakeInput()))).toBe(true);
    expect(isTextEntry(asTarget(new FakeTextArea()))).toBe(true);
    const editable = new FakeElement();
    editable.isContentEditable = true;
    expect(isTextEntry(asTarget(editable))).toBe(true);
  });

  test("ignores a focused button so Space keeps its native activation", () => {
    expect(isTextEntry(asTarget(new FakeButton()))).toBe(true);
  });

  test("captures the stage and body so Space still jumps", () => {
    expect(isTextEntry(asTarget(new FakeElement()))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
