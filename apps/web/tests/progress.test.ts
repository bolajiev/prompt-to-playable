import { afterEach, describe, expect, test, vi } from "vitest";
import {
  formatElapsed,
  GenerationProgress,
  STAGE_THRESHOLDS_MS,
  stageMessage,
  type ProgressElements,
} from "../src/ui/progress.js";
import { FakeNode } from "./fakes.js";

const [buildAt, checkAt, almostAt] = STAGE_THRESHOLDS_MS;

describe("stageMessage", () => {
  test("moves through the four stages deterministically", () => {
    expect(stageMessage(0)).toBe("understanding the request…");
    expect(stageMessage(1_500)).toBe("understanding the request…");
    expect(stageMessage(buildAt)).toBe("building the world…");
    expect(stageMessage(buildAt + 1)).toBe("building the world…");
    expect(stageMessage(checkAt)).toBe("checking the rules…");
    expect(stageMessage(checkAt + 1)).toBe("checking the rules…");
    expect(stageMessage(almostAt)).toBe("almost there…");
    expect(stageMessage(10 * 60_000)).toBe("almost there…");
  });

  test("is stable at the exact boundaries (repeated calls agree)", () => {
    for (const ms of [0, buildAt - 1, buildAt, checkAt - 1, checkAt, almostAt - 1, almostAt]) {
      expect(stageMessage(ms)).toBe(stageMessage(ms));
    }
    expect(stageMessage(buildAt - 1)).not.toBe(stageMessage(buildAt));
  });

  test("clamps degenerate durations to sensible ends", () => {
    expect(stageMessage(-1)).toBe("understanding the request…");
    expect(stageMessage(Number.NaN)).toBe("understanding the request…");
    expect(stageMessage(Number.NEGATIVE_INFINITY)).toBe(
      "understanding the request…"
    );
    expect(stageMessage(Number.POSITIVE_INFINITY)).toBe("almost there…");
  });
});

describe("formatElapsed", () => {
  test("renders tenths of a second", () => {
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(1_234)).toBe("1.2s");
    expect(formatElapsed(59_950)).toBe("60.0s");
  });

  test("never renders negative or non-finite values", () => {
    expect(formatElapsed(-500)).toBe("0.0s");
    expect(formatElapsed(Number.NaN)).toBe("0.0s");
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("0.0s");
  });
});

describe("GenerationProgress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createHarness(nowRef: { value: number }, onCancel = vi.fn()) {
    const root = new FakeNode();
    const stage = new FakeNode();
    const time = new FakeNode();
    const cancel = new FakeNode();
    const progress = new GenerationProgress(
      { root, stage, time, cancel } as unknown as ProgressElements,
      { now: () => nowRef.value, intervalMs: 250, onCancel }
    );
    return { progress, root, stage, time, cancel, onCancel };
  }

  test("starts hidden, then ticks copy and elapsed time until stopped", () => {
    vi.useFakeTimers();
    const nowRef = { value: 1_000 };
    const { progress, root, stage, time } = createHarness(nowRef);

    expect(progress.isActive).toBe(false);
    progress.start();
    expect(progress.isActive).toBe(true);
    expect(root.hidden).toBe(false);
    expect(stage.textContent).toBe("understanding the request…");
    expect(time.textContent).toBe("0.0s");

    nowRef.value = 13_000;
    vi.advanceTimersByTime(250);
    expect(stage.textContent).toBe("checking the rules…");
    expect(time.textContent).toBe("12.0s");

    progress.stop();
    expect(progress.isActive).toBe(false);
    expect(root.hidden).toBe(true);

    nowRef.value = 40_000;
    vi.advanceTimersByTime(2_000);
    expect(stage.textContent).toBe("checking the rules…");
  });

  test("start is idempotent and stop is safe before start", () => {
    vi.useFakeTimers();
    const nowRef = { value: 0 };
    const { progress, root, stage, time } = createHarness(nowRef);

    progress.stop();
    expect(root.hidden).toBe(true);

    progress.start();
    nowRef.value = 1_000;
    progress.start();
    vi.advanceTimersByTime(250);
    expect(stage.textContent).toBe("understanding the request…");
    expect(time.textContent).toBe("1.0s");
  });

  test("the cancel control forwards to onCancel", () => {
    const nowRef = { value: 0 };
    const { cancel, onCancel } = createHarness(nowRef);
    cancel.emit("click");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
