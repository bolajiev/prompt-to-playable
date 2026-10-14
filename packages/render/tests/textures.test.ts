import { afterEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import {
  GLASS_OPACITY,
  GLASS_ROUGHNESS,
  TEXTURE_IMAGE_NAMES,
  TEXTURE_NAMES,
  textureForName,
} from "../src/textures.js";
import { installFakeDocument, type FakeDom } from "./fake-dom.js";

let fake: FakeDom | null = null;

afterEach(() => {
  fake?.restore();
  fake = null;
});

describe("textureForName", () => {
  test("declares the full part texture vocabulary from the schema", () => {
    expect([...TEXTURE_NAMES]).toEqual([
      "circuit",
      "wood",
      "brick",
      "metal",
      "grid",
      "glass",
    ]);
    expect([...TEXTURE_IMAGE_NAMES]).toEqual([
      "circuit",
      "wood",
      "brick",
      "metal",
      "grid",
    ]);
  });

  test("unknown names return null", () => {
    expect(textureForName("castle")).toBeNull();
    expect(textureForName("")).toBeNull();
    expect(textureForName("GLASS")).toBeNull();
  });

  test("node fallback returns null for every name without a document", () => {
    expect(typeof document).toBe("undefined");
    for (const name of TEXTURE_NAMES) {
      expect(textureForName(name), name).toBeNull();
    }
  });

  test("glass resolves to material parameters instead of an image texture", () => {
    fake = installFakeDocument();
    expect(textureForName("glass")).toBeNull();
    expect(GLASS_OPACITY).toBe(0.25);
    expect(GLASS_ROUGHNESS).toBe(0.1);
  });

  test("canvas names resolve to cached CanvasTextures with repeat wrapping", () => {
    fake = installFakeDocument();
    for (const name of TEXTURE_IMAGE_NAMES) {
      const texture = textureForName(name);
      expect(texture, name).toBeInstanceOf(THREE.CanvasTexture);
      expect(texture!.wrapS, name).toBe(THREE.RepeatWrapping);
      expect(texture!.wrapT, name).toBe(THREE.RepeatWrapping);
      expect(texture!.colorSpace, name).toBe(THREE.SRGBColorSpace);
      expect(textureForName(name), name).toBe(texture);
    }
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls).toContain("fillRect");
    expect(fake.calls).toContain("stroke");
  });

  test("draws deterministically: same commands for the same name", async () => {
    vi.resetModules();
    const first = installFakeDocument();
    const firstModule = await import("../src/textures.js");
    firstModule.textureForName("wood");
    const firstCalls = [...first.calls];
    first.restore();

    vi.resetModules();
    fake = installFakeDocument();
    const secondModule = await import("../src/textures.js");
    secondModule.textureForName("wood");

    expect(firstCalls.length).toBeGreaterThan(0);
    expect(fake.calls).toEqual(firstCalls);
  });
});
