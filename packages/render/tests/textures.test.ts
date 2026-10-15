import { afterEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import {
  CIRCUIT_TILE_SIZE,
  CIRCUIT_TILE_WORLD_SIZE,
  GLASS_OPACITY,
  GLASS_ROUGHNESS,
  TEXTURE_IMAGE_NAMES,
  TEXTURE_IMAGE_SIZE,
  TEXTURE_NAMES,
  TEXTURE_CLONE_KEY,
  textureForName,
  textureMapForPart,
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

  test("circuit is a 1024px solder-mask tile; legacy patterns keep 128px", async () => {
    vi.resetModules();
    fake = installFakeDocument();
    const module = await import("../src/textures.js");
    expect(CIRCUIT_TILE_SIZE).toBe(1024);

    module.textureForName("circuit");
    expect(fake.canvases).toHaveLength(1);
    expect(fake.canvases[0]!.width).toBe(CIRCUIT_TILE_SIZE);
    expect(fake.canvases[0]!.height).toBe(CIRCUIT_TILE_SIZE);

    module.textureForName("wood");
    expect(fake.canvases).toHaveLength(2);
    expect(fake.canvases[1]!.width).toBe(TEXTURE_IMAGE_SIZE);
    expect(fake.canvases[1]!.height).toBe(TEXTURE_IMAGE_SIZE);
  });

  test("circuit draws traces, pads and vias", async () => {
    vi.resetModules();
    fake = installFakeDocument();
    const module = await import("../src/textures.js");
    module.textureForName("circuit");

    const lineTos = fake.calls.filter((call) => call === "lineTo").length;
    const arcs = fake.calls.filter((call) => call === "arc").length;
    expect(lineTos).toBeGreaterThan(10);
    expect(arcs).toBeGreaterThan(5);
    expect(fake.calls).toContain("set:lineJoin");
    expect(fake.calls).toContain("set:strokeStyle");
    expect(fake.calls).toContain("fill");
    expect(fake.calls).toContain("fillRect");
  });

  test("circuit draws deterministically: same commands across module loads", async () => {
    vi.resetModules();
    const first = installFakeDocument();
    const firstModule = await import("../src/textures.js");
    firstModule.textureForName("circuit");
    const firstCalls = [...first.calls];
    const firstSizes = first.canvases.map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
    }));
    first.restore();

    vi.resetModules();
    fake = installFakeDocument();
    const secondModule = await import("../src/textures.js");
    secondModule.textureForName("circuit");

    expect(firstCalls.length).toBeGreaterThan(100);
    expect(fake.calls).toEqual(firstCalls);
    expect(
      fake.canvases.map((canvas) => ({
        width: canvas.width,
        height: canvas.height,
      }))
    ).toEqual(firstSizes);
  });
});

describe("textureMapForPart", () => {
  test("node fallback returns null for every name", async () => {
    vi.resetModules();
    const module = await import("../src/textures.js");
    expect(typeof document).toBe("undefined");
    expect(module.textureMapForPart("circuit", [2, 0.1, 1])).toBeNull();
    expect(module.textureMapForPart("wood", [2, 0.1, 1])).toBeNull();
  });

  test("glass and unknown names return null", async () => {
    vi.resetModules();
    fake = installFakeDocument();
    const module = await import("../src/textures.js");
    expect(module.textureMapForPart("glass", [1, 1, 1])).toBeNull();
    expect(module.textureMapForPart("marble", [1, 1, 1])).toBeNull();
  });

  test("non-circuit names reuse the shared cached texture", async () => {
    vi.resetModules();
    fake = installFakeDocument();
    const module = await import("../src/textures.js");
    const wood = module.textureMapForPart("wood", [2, 0.1, 2]);
    expect(wood).toBe(module.textureForName("wood"));
  });

  test("circuit clones per part with repeat derived from the board footprint", async () => {
    vi.resetModules();
    fake = installFakeDocument();
    const module = await import("../src/textures.js");
    const base = module.textureForName("circuit")!;
    const map = module.textureMapForPart("circuit", [4, 0.12, 2])!;

    expect(map).toBeInstanceOf(THREE.CanvasTexture);
    expect(map).not.toBe(base);
    expect(map.image).toBe(base.image);
    expect(map.wrapS).toBe(THREE.RepeatWrapping);
    expect(map.wrapT).toBe(THREE.RepeatWrapping);
    expect(map.repeat.x).toBe(4 / CIRCUIT_TILE_WORLD_SIZE);
    expect(map.repeat.y).toBe(2 / CIRCUIT_TILE_WORLD_SIZE);
    expect(map.userData[TEXTURE_CLONE_KEY]).toBe(true);

    const tiny = module.textureMapForPart("circuit", [0.2, 0.1, 0.2])!;
    expect(tiny.repeat.x).toBe(1);
    expect(tiny.repeat.y).toBe(1);
  });

  test("circuit traces mix straight runs with 45-degree turns", async () => {
    vi.resetModules();
    fake = installFakeDocument();
    const module = await import("../src/textures.js");
    module.textureForName("circuit");

    const traces: Array<Array<[number, number]>> = [];
    let current: Array<[number, number]> = [];
    for (const event of fake.events) {
      if (event.method === "moveTo") {
        current = [[event.args[0] as number, event.args[1] as number]];
      } else if (event.method === "lineTo") {
        current.push([event.args[0] as number, event.args[1] as number]);
      } else if (event.method === "stroke") {
        if (current.length > 1) traces.push(current);
        current = [];
      }
    }

    const direction = (a: [number, number], b: [number, number]): string =>
      `${Math.sign(b[0] - a[0])},${Math.sign(b[1] - a[1])}`;
    let straightRuns = 0;
    let turns = 0;
    for (const trace of traces) {
      for (let i = 2; i < trace.length; i += 1) {
        if (
          direction(trace[i - 2], trace[i - 1]) ===
          direction(trace[i - 1], trace[i])
        ) {
          straightRuns += 1;
        } else {
          turns += 1;
        }
      }
    }
    expect(traces.length).toBeGreaterThanOrEqual(5);
    expect(straightRuns).toBeGreaterThan(0);
    expect(turns).toBeGreaterThan(0);
  });
});
