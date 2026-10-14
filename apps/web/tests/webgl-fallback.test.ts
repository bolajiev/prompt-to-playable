import { describe, expect, test } from "vitest";
import { webglFallbackMessage } from "../src/app.js";

const FALLBACK =
  "3D couldn't start: your browser blocked WebGL. Try Chrome/Edge with hardware acceleration enabled.";

describe("webglFallbackMessage", () => {
  test("explains the failure and how to recover without error detail", () => {
    expect(webglFallbackMessage()).toBe(FALLBACK);
  });

  test("appends the original three.js error message for diagnosis", () => {
    expect(webglFallbackMessage(new Error("Error creating WebGL context."))).toBe(
      `${FALLBACK} (Error creating WebGL context.)`
    );
  });

  test("ignores non-error values and empty messages", () => {
    expect(webglFallbackMessage("blocked")).toBe(FALLBACK);
    expect(webglFallbackMessage(new Error(""))).toBe(FALLBACK);
  });
});
