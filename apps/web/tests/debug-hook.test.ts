import { describe, expect, test } from "vitest";
import type { GameState } from "@prompt-to-playable/engine";
import { createDebugHook } from "../src/app.js";

function fakeState(ticks: number): GameState {
  return { status: "running", ticks } as unknown as GameState;
}

describe("game debug hook factory", () => {
  test("returns a deep-cloned snapshot that never aliases the source", () => {
    const state = fakeState(42);
    const hook = createDebugHook({ getState: () => state });

    expect(typeof hook.getState).toBe("function");
    const snapshot = hook.getState();
    expect(snapshot).not.toBe(state);
    expect(snapshot).toEqual({ status: "running", ticks: 42 });
    expect(snapshot.ticks).toBe(42);
  });

  test("clones nested state so page scripts cannot mutate engine internals", () => {
    const state = {
      status: "running",
      ticks: 1,
      entityRuntime: { player: { position: [1, 2, 3] } },
    } as unknown as GameState;
    const hook = createDebugHook({ getState: () => state });

    const snapshot = hook.getState();
    snapshot.ticks = 99;
    snapshot.entityRuntime.player.position[0] = 42;

    expect(state.ticks).toBe(1);
    expect(state.entityRuntime.player.position[0]).toBe(1);
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
