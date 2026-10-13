import { describe, expect, test } from "vitest";
import type { GameState } from "@prompt-to-playable/engine";
import { createDebugHook } from "../src/app.js";

function fakeState(ticks: number): GameState {
  return { status: "running", ticks } as unknown as GameState;
}

describe("game debug hook factory", () => {
  test("returns a snapshot accessor that delegates to the source", () => {
    const state = fakeState(42);
    const hook = createDebugHook({ getState: () => state });

    expect(typeof hook.getState).toBe("function");
    expect(hook.getState()).toBe(state);
    expect(hook.getState().ticks).toBe(42);
  });

  test("is read-only and needs no DOM", () => {
    const hook = createDebugHook({ getState: () => fakeState(0) });

    expect(Object.isFrozen(hook)).toBe(true);
    expect(() => {
      (hook as { getState?: unknown }).getState = () => fakeState(1);
    }).toThrow();
    expect(hook.getState().ticks).toBe(0);
  });
});
