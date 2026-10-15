import { describe, expect, test } from "vitest";
import { landingUrl, normalizeStudioUrl } from "../scripts/studio-url.js";

describe("studio url normalization", () => {
  test("a bare host or root path defaults to the studio page", () => {
    expect(normalizeStudioUrl("http://localhost:3312")).toBe(
      "http://localhost:3312/app.html"
    );
    expect(normalizeStudioUrl("http://localhost:3312/")).toBe(
      "http://localhost:3312/app.html"
    );
    expect(normalizeStudioUrl("https://example.com")).toBe("https://example.com/app.html");
  });

  test("a root url keeps its query string and hash", () => {
    expect(normalizeStudioUrl("http://localhost:3312/?prompt=hi")).toBe(
      "http://localhost:3312/app.html?prompt=hi"
    );
    expect(normalizeStudioUrl("http://localhost:3312/#kits")).toBe(
      "http://localhost:3312/app.html#kits"
    );
  });

  test("explicit paths are used as-is", () => {
    expect(normalizeStudioUrl("http://localhost:3312/app.html")).toBe(
      "http://localhost:3312/app.html"
    );
    expect(normalizeStudioUrl("https://example.com/preview.html?x=1")).toBe(
      "https://example.com/preview.html?x=1"
    );
    expect(normalizeStudioUrl("https://example.com/nested/")).toBe(
      "https://example.com/nested/"
    );
  });

  test("landingUrl returns the origin root of a page url", () => {
    expect(landingUrl("http://localhost:3312/app.html")).toBe("http://localhost:3312/");
    expect(landingUrl("https://example.com/deep/page.html?x=1")).toBe(
      "https://example.com/"
    );
  });
});
