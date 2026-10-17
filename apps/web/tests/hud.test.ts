import { describe, expect, test } from "vitest";
import type { GameState } from "@prompt-to-playable/engine";
import { EXPLORE_HINT, exploreHint, Hud } from "../src/ui/hud.js";
import { FakeDocument, FakeNode } from "./fakes.js";

describe("explore HUD decision", () => {
  test("explore mode with zero objectives means free roam", () => {
    expect(exploreHint("explore", 0)).toBe(EXPLORE_HINT);
    expect(EXPLORE_HINT).toContain("Explore freely");
    expect(EXPLORE_HINT).toContain("WASD move");
    expect(EXPLORE_HINT).toContain("Space jump");
    expect(EXPLORE_HINT).toContain("drag to orbit");
  });

  test("inspect, walkthrough, drive, machine, world and game never get the explore hint", () => {
    expect(exploreHint("inspect", 0)).toBeNull();
    expect(exploreHint("walkthrough", 0)).toBeNull();
    expect(exploreHint("drive", 0)).toBeNull();
    expect(exploreHint("machine", 0)).toBeNull();
    expect(exploreHint("world", 0)).toBeNull();
    expect(exploreHint("game", 0)).toBeNull();
  });

  test("any objective keeps the objective list", () => {
    expect(exploreHint("explore", 1)).toBeNull();
    expect(exploreHint("explore", 3)).toBeNull();
  });
});

function stateWith(objectives: unknown[]): GameState {
  return {
    status: "running",
    time: 0,
    objectives,
    entities: [],
    entityRuntime: {},
    doc: { meta: { title: "Quiet Clearing", archetype: "explore" } },
  } as unknown as GameState;
}

function inspectState(): GameState {
  return {
    status: "running",
    time: 0,
    objectives: [],
    entities: [],
    entityRuntime: {},
    doc: {
      meta: { title: "PCB Viewer", archetype: "collect-a-thon", mode: "inspect" },
    },
  } as unknown as GameState;
}

function renderHud(state: GameState): FakeNode {
  const doc = new FakeDocument();
  const root = new FakeNode(doc);
  const hud = new Hud(root as unknown as HTMLElement);
  hud.update(state);
  return root;
}

describe("Hud explore rendering", () => {
  test("shows the explore hint instead of an empty objective list", () => {
    const root = renderHud(stateWith([]));

    const hint = root.find("explore-hint");
    expect(hint?.textContent).toBe(EXPLORE_HINT);
    expect(root.children.some((child) => child.className === "objectives")).toBe(
      false
    );
  });

  test("still renders objective rows when objectives exist", () => {
    const root = renderHud(
      stateWith([
        {
          id: "goal",
          type: "collect",
          status: "active",
          progress: 1,
          count: 3,
          description: "Collect crystals",
        },
      ])
    );

    const list = root.children.find((child) => child.className === "objectives");
    expect(list).toBeDefined();
    expect(list?.children).toHaveLength(1);
    expect(list?.children[0].className).toBe("objective active");
    expect(list?.children[0].children[0]?.textContent).toBe("Collect crystals");
    expect(root.find("explore-hint")).toBeUndefined();
  });

  test("inspect scenes with zero objectives get no explore hint", () => {
    const root = renderHud(inspectState());
    expect(root.find("explore-hint")).toBeUndefined();
  });
});
