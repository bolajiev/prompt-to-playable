import { describe, expect, test, vi } from "vitest";
import {
  CANVAS_MIN_WIDTH,
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  parseStoredSidebarWidth,
  SIDEBAR_CHROME_WIDTH,
  SIDEBAR_KEYBOARD_STEP,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  SidebarResizer,
} from "../src/ui/sidebar-resize.js";
import { FakeNode, FakeStorage } from "./fakes.js";

describe("clampSidebarWidth", () => {
  test("keeps a width inside the 280-640 band", () => {
    expect(clampSidebarWidth(480, 1280)).toBe(480);
    expect(clampSidebarWidth(100, 1280)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900, 1280)).toBe(SIDEBAR_MAX_WIDTH);
  });

  test("never lets the sidebar squeeze the canvas below 320px", () => {
    expect(clampSidebarWidth(640, 1000)).toBe(
      1000 - CANVAS_MIN_WIDTH - SIDEBAR_CHROME_WIDTH
    );
    expect(clampSidebarWidth(100, 400)).toBe(SIDEBAR_MIN_WIDTH);
  });

  test("rounds fractional widths", () => {
    expect(clampSidebarWidth(480.4, 1280)).toBe(480);
    expect(clampSidebarWidth(480.6, 1280)).toBe(481);
  });

  test("treats a non-finite width as the minimum", () => {
    expect(clampSidebarWidth(Number.NaN, 1280)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, 1280)).toBe(
      SIDEBAR_MAX_WIDTH
    );
  });
});

describe("parseStoredSidebarWidth", () => {
  test("parses positive numbers", () => {
    expect(parseStoredSidebarWidth("480")).toBe(480);
    expect(parseStoredSidebarWidth(" 480.5 ")).toBe(480.5);
  });

  test("rejects missing, malformed and non-positive values", () => {
    expect(parseStoredSidebarWidth(null)).toBeNull();
    expect(parseStoredSidebarWidth("")).toBeNull();
    expect(parseStoredSidebarWidth("nope")).toBeNull();
    expect(parseStoredSidebarWidth("0")).toBeNull();
    expect(parseStoredSidebarWidth("-20")).toBeNull();
    expect(parseStoredSidebarWidth("Infinity")).toBeNull();
  });
});

function createHarness(
  initial: Record<string, string> = {},
  viewport = 1280
) {
  const handle = new FakeNode();
  const storage = new FakeStorage();
  for (const [key, value] of Object.entries(initial)) {
    storage.setItem(key, value);
  }
  const widths: number[] = [];
  let viewportWidth = viewport;
  const resizer = new SidebarResizer(handle as unknown as HTMLElement, {
    storage,
    viewportWidth: () => viewportWidth,
    onWidth: (width) => widths.push(width),
  });
  return {
    handle,
    storage,
    widths,
    resizer,
    setViewport: (width: number) => {
      viewportWidth = width;
    },
  };
}

describe("SidebarResizer", () => {
  test("restores a stored width on load, clamps it and exposes ARIA bounds", () => {
    const { resizer, widths, handle } = createHarness({
      [SIDEBAR_WIDTH_STORAGE_KEY]: "480",
    });
    expect(resizer.width).toBe(480);
    expect(widths).toEqual([480]);
    expect(handle.getAttribute("aria-valuemin")).toBe(String(SIDEBAR_MIN_WIDTH));
    expect(handle.getAttribute("aria-valuemax")).toBe(String(SIDEBAR_MAX_WIDTH));
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
  });

  test("restoring clamps a stale width to the live viewport", () => {
    const { resizer } = createHarness(
      { [SIDEBAR_WIDTH_STORAGE_KEY]: "900" },
      1000
    );
    expect(resizer.width).toBe(1000 - CANVAS_MIN_WIDTH - SIDEBAR_CHROME_WIDTH);
  });

  test("falls back to the default width for missing or malformed storage", () => {
    expect(createHarness().resizer.width).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(
      createHarness({ [SIDEBAR_WIDTH_STORAGE_KEY]: "junk" }).resizer.width
    ).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  test("arrow keys resize by 16px and persist", () => {
    const { handle, resizer, storage } = createHarness();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    handle.emit("keydown", { key: "ArrowLeft", preventDefault, stopPropagation });
    expect(resizer.width).toBe(DEFAULT_SIDEBAR_WIDTH + SIDEBAR_KEYBOARD_STEP);
    expect(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(
      String(DEFAULT_SIDEBAR_WIDTH + SIDEBAR_KEYBOARD_STEP)
    );
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);

    handle.emit("keydown", { key: "ArrowRight" });
    expect(resizer.width).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(
      String(DEFAULT_SIDEBAR_WIDTH)
    );

    handle.emit("keydown", { key: "a" });
    expect(resizer.width).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  test("keyboard resizing clamps at both ends", () => {
    const wide = createHarness({ [SIDEBAR_WIDTH_STORAGE_KEY]: "636" });
    wide.handle.emit("keydown", { key: "ArrowLeft" });
    expect(wide.resizer.width).toBe(SIDEBAR_MAX_WIDTH);
    wide.handle.emit("keydown", { key: "ArrowLeft" });
    expect(wide.resizer.width).toBe(SIDEBAR_MAX_WIDTH);

    const narrow = createHarness({ [SIDEBAR_WIDTH_STORAGE_KEY]: "284" });
    narrow.handle.emit("keydown", { key: "ArrowRight" });
    expect(narrow.resizer.width).toBe(SIDEBAR_MIN_WIDTH);
    narrow.handle.emit("keydown", { key: "ArrowRight" });
    expect(narrow.resizer.width).toBe(SIDEBAR_MIN_WIDTH);
  });

  test("dragging the handle resizes live and persists once on release", () => {
    const { handle, resizer, storage, widths } = createHarness({
      [SIDEBAR_WIDTH_STORAGE_KEY]: "480",
    });

    handle.emit("pointerdown", { button: 0, pointerId: 1, clientX: 700 });
    handle.emit("pointermove", { pointerId: 1, clientX: 660 });
    expect(resizer.width).toBe(520);
    expect(widths.at(-1)).toBe(520);
    // Live frames are not persisted; only the release commits.
    expect(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("480");
    // Foreign pointer ids are ignored while dragging.
    handle.emit("pointermove", { pointerId: 9, clientX: 100 });
    expect(resizer.width).toBe(520);

    handle.emit("pointerup", { pointerId: 1, clientX: 660 });
    expect(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("520");

    // After release the drag is over: moves no longer resize.
    handle.emit("pointermove", { pointerId: 1, clientX: 400 });
    expect(resizer.width).toBe(520);
    expect(handle.dataset.dragging).toBeUndefined();
  });

  test("a drag clamps to the band mid-move", () => {
    const { handle, resizer } = createHarness({
      [SIDEBAR_WIDTH_STORAGE_KEY]: "480",
    });
    handle.emit("pointerdown", { button: 0, pointerId: 2, clientX: 500 });
    handle.emit("pointermove", { pointerId: 2, clientX: -500 });
    expect(resizer.width).toBe(SIDEBAR_MAX_WIDTH);
    handle.emit("pointercancel", { pointerId: 2 });
    expect(resizer.width).toBe(SIDEBAR_MAX_WIDTH);
  });

  test("ignores non-primary pointer buttons", () => {
    const { handle, resizer } = createHarness({
      [SIDEBAR_WIDTH_STORAGE_KEY]: "480",
    });
    handle.emit("pointerdown", { button: 2, pointerId: 3, clientX: 700 });
    handle.emit("pointermove", { pointerId: 3, clientX: 600 });
    expect(resizer.width).toBe(480);
  });

  test("clampToViewport keeps the canvas minimum and persists", () => {
    const { resizer, setViewport, storage } = createHarness(
      { [SIDEBAR_WIDTH_STORAGE_KEY]: "640" },
      1280
    );
    setViewport(1000);
    expect(resizer.clampToViewport()).toBe(
      1000 - CANVAS_MIN_WIDTH - SIDEBAR_CHROME_WIDTH
    );
    expect(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(
      String(1000 - CANVAS_MIN_WIDTH - SIDEBAR_CHROME_WIDTH)
    );

    // Back to a wide viewport: the clamped width is kept, not restored.
    setViewport(1280);
    expect(resizer.clampToViewport()).toBe(
      1000 - CANVAS_MIN_WIDTH - SIDEBAR_CHROME_WIDTH
    );
  });
});
