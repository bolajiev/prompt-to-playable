import { describe, expect, test } from "vitest";
import {
  COLLAPSED_STORAGE_KEY,
  CollapsedStore,
  isCollapsed,
  parseCollapsedMap,
  serializeCollapsedMap,
  withCollapsed,
} from "../src/ui/collapsible.js";
import { FakeStorage } from "./fakes.js";

describe("collapsed map helpers", () => {
  test("parses a tolerant boolean map", () => {
    expect(parseCollapsedMap(null)).toEqual({});
    expect(parseCollapsedMap("")).toEqual({});
    expect(parseCollapsedMap("not json")).toEqual({});
    expect(parseCollapsedMap("[true]")).toEqual({});
    expect(parseCollapsedMap('"agent-trace"')).toEqual({});
    expect(
      parseCollapsedMap(
        '{"agent-trace":true,"controls-panel":false,"other":"yes","n":1}'
      )
    ).toEqual({ "agent-trace": true, "controls-panel": false });
  });

  test("sections default to expanded", () => {
    expect(isCollapsed({}, "agent-trace")).toBe(false);
    expect(isCollapsed({ "agent-trace": true }, "agent-trace")).toBe(true);
    expect(isCollapsed({ "agent-trace": false }, "agent-trace")).toBe(false);
  });

  test("withCollapsed sets true and drops false entries", () => {
    const collapsed = withCollapsed({}, "agent-trace", true);
    expect(collapsed).toEqual({ "agent-trace": true });
    expect(withCollapsed(collapsed, "agent-trace", false)).toEqual({});
    expect(serializeCollapsedMap(collapsed)).toBe('{"agent-trace":true}');
  });
});

describe("CollapsedStore", () => {
  test("reads and writes the ptp.collapsed document", () => {
    const storage = new FakeStorage();
    const store = new CollapsedStore(storage);

    expect(store.isCollapsed("agent-trace")).toBe(false);
    store.setCollapsed("agent-trace", true);
    expect(storage.getItem(COLLAPSED_STORAGE_KEY)).toBe(
      '{"agent-trace":true}'
    );

    store.setCollapsed("controls-panel", true);
    expect(
      JSON.parse(storage.getItem(COLLAPSED_STORAGE_KEY) ?? "")
    ).toEqual({ "agent-trace": true, "controls-panel": true });

    store.setCollapsed("agent-trace", false);
    expect(
      JSON.parse(storage.getItem(COLLAPSED_STORAGE_KEY) ?? "")
    ).toEqual({ "controls-panel": true });
  });

  test("a new store restores persisted state", () => {
    const storage = new FakeStorage();
    new CollapsedStore(storage).setCollapsed("agent-trace", true);
    expect(new CollapsedStore(storage).isCollapsed("agent-trace")).toBe(true);
  });

  test("a null storage keeps defaults and never throws", () => {
    const store = new CollapsedStore(null);
    expect(store.isCollapsed("agent-trace")).toBe(false);
    store.setCollapsed("agent-trace", true);
    expect(store.isCollapsed("agent-trace")).toBe(true);
  });
});
