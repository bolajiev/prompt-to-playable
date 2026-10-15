import { describe, expect, test } from "vitest";
import { studioHref } from "../src/studio-link.js";

describe("studioHref", () => {
  test("targets the studio page with the prompt as a query parameter", () => {
    expect(studioHref("a car racing game")).toBe(
      "/app.html?prompt=a%20car%20racing%20game"
    );
  });

  test("percent-encodes reserved characters and round-trips the prompt", () => {
    const prompt = "a room with 3 crystals & one guard? maybe #2";
    const href = studioHref(prompt);
    const query = href.slice(href.indexOf("?") + 1);
    expect(href.startsWith("/app.html?prompt=")).toBe(true);
    expect(query).not.toContain("&");
    expect(new URLSearchParams(query).get("prompt")).toBe(prompt);
  });
});
