import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as THREE from "three";
import type { Skybox, World } from "@prompt-to-playable/schema";
import { validateGame } from "@prompt-to-playable/schema";
import {
  applyWorldEnvironment,
  DEFAULT_WORLD,
  fogSettings,
  FOG_FAR_RATIO,
  FOG_NEAR_RATIO,
  GROUND_PALETTES,
  groundPalette,
  groundRepeat,
  LIGHTING_PROFILES,
  lightingProfile,
  MIN_AMBIENT_INTENSITY,
  MIN_DIRECTIONAL_INTENSITY,
  MIN_FILL_INTENSITY,
  MIN_HEMISPHERE_INTENSITY,
  mixHexColors,
  SKYBOX_GRADIENTS,
  skyGradient,
  skyGradientStops,
  WORLD_ENVIRONMENT_NAME,
} from "../src/lighting.js";
import { EMISSIVE_STRENGTH } from "../src/scene.js";

const MOODS = ["dawn", "day", "dusk", "night", "indoor"] as const;
const SKYBOXES = ["cave", "outdoor", "lab"] as const;
const HEX = /^#[0-9a-f]{6}$/;

function worldFor(options: {
  lighting?: World["lighting"];
  skybox?: Skybox;
  bounds?: World["bounds"];
} = {}): World {
  const result = validateGame({
    version: "1.0.0",
    meta: { title: "Lighting Test", archetype: "collect-a-thon" },
    world: {
      bounds: options.bounds ?? [24, 12, 16],
      lighting: options.lighting ?? "night",
      skybox: options.skybox ?? "cave",
      terrain: {
        type: "flat",
        obstacles: [{ position: [2, 0.5, -3], size: [2, 1, 2] }],
      },
    },
    entities: [
      { id: "player", kind: "player", position: [0, 0, 0], tags: [], active: true },
    ],
    objectives: [],
    rules: [],
    scratch: {},
  });
  if (!result.ok || !result.data) throw new Error("test world invalid");
  return result.data.world;
}

describe("lighting profiles", () => {
  test("every mood keeps a readable brightness floor: scenes are never black", () => {
    for (const mood of MOODS) {
      const profile = LIGHTING_PROFILES[mood];
      expect(profile.ambient).toBeGreaterThanOrEqual(MIN_AMBIENT_INTENSITY);
      expect(profile.hemisphere).toBeGreaterThanOrEqual(MIN_HEMISPHERE_INTENSITY);
      expect(profile.ambient + profile.hemisphere).toBeGreaterThanOrEqual(
        MIN_FILL_INTENSITY
      );
      expect(profile.directional).toBeGreaterThanOrEqual(
        MIN_DIRECTIONAL_INTENSITY
      );
      for (const color of [
        profile.ambientColor,
        profile.hemisphereSky,
        profile.hemisphereGround,
        profile.directionalColor,
        profile.background,
      ]) {
        expect(color).toMatch(HEX);
      }
      expect(profile.sunPosition).toHaveLength(3);
    }
  });

  test("night is moonlit (cool blue) rather than dimmed to black", () => {
    const night = LIGHTING_PROFILES.night;
    const sun = hexToRgbChannels(night.directionalColor);
    expect(sun.blue).toBeGreaterThan(sun.red);
    expect(night.directional).toBeGreaterThanOrEqual(MIN_DIRECTIONAL_INTENSITY);
    expect(night.directional).toBeLessThan(LIGHTING_PROFILES.day.directional);
    expect(LIGHTING_PROFILES.indoor.directional).toBeLessThan(
      LIGHTING_PROFILES.day.directional
    );
  });

  test("defaults to day and maps explicit moods to their table entry", () => {
    expect(lightingProfile(undefined)).toEqual(LIGHTING_PROFILES.day);
    for (const mood of MOODS) {
      expect(lightingProfile(mood)).toEqual(LIGHTING_PROFILES[mood]);
    }
  });
});

describe("sky gradient", () => {
  test("is deterministic and distinct per skybox", () => {
    const first = skyGradient("outdoor", "day");
    expect(first).toEqual(skyGradient("outdoor", "day"));

    const gradients = SKYBOXES.map((skybox) => skyGradient(skybox, "day"));
    expect(gradients[0]).not.toEqual(gradients[1]);
    expect(gradients[1]).not.toEqual(gradients[2]);

    for (const gradient of [
      ...gradients,
      skyGradient(undefined, undefined),
      skyGradient("cave", "dusk"),
    ]) {
      expect(gradient.top).toMatch(HEX);
      expect(gradient.middle).toMatch(HEX);
      expect(gradient.bottom).toMatch(HEX);
    }
  });

  test("mood tints the horizon without changing the skybox zenith", () => {
    expect(skyGradient("outdoor", "dusk").top).toBe(
      SKYBOX_GRADIENTS.outdoor.top
    );
    expect(skyGradient("outdoor", "dusk").bottom).not.toBe(
      skyGradient("outdoor", "day").bottom
    );
  });

  test("stops run top to bottom and match the gradient colors", () => {
    const stops = skyGradientStops("lab", "dawn");
    const gradient = skyGradient("lab", "dawn");
    expect(stops.map((stop) => stop.offset)).toEqual([0, 0.55, 1]);
    expect(stops.map((stop) => stop.color)).toEqual([
      gradient.top,
      gradient.middle,
      gradient.bottom,
    ]);
  });

  test("mixHexColors interpolates and clamps", () => {
    expect(mixHexColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHexColors("#000000", "#ffffff", -1)).toBe("#000000");
    expect(mixHexColors("#000000", "#ffffff", 2)).toBe("#ffffff");
  });
});

describe("fog", () => {
  test("matches the sky horizon and scales with world bounds", () => {
    const gradient = skyGradient("outdoor", "day");
    const small = fogSettings("outdoor", "day", [20, 10, 20]);
    const large = fogSettings("outdoor", "day", [60, 10, 60]);

    expect(small.color).toBe(gradient.middle);
    expect(small.near).toBe(20 * FOG_NEAR_RATIO);
    expect(small.far).toBe(20 * FOG_FAR_RATIO);
    expect(large.near).toBeGreaterThan(small.near);
    expect(large.far).toBeGreaterThan(small.far);
    expect(small.near).toBeLessThan(small.far);
  });
});

describe("ground palette", () => {
  test("terrain types get distinct deterministic tints", () => {
    expect(groundPalette({ type: "flat", obstacles: [] })).toEqual(
      GROUND_PALETTES.flat
    );
    expect(groundPalette(undefined)).toEqual(GROUND_PALETTES.flat);
    expect(GROUND_PALETTES.flat).not.toEqual(GROUND_PALETTES.mesh);
    for (const palette of Object.values(GROUND_PALETTES)) {
      for (const color of Object.values(palette)) expect(color).toMatch(HEX);
    }
  });

  test("checker repeat keeps roughly one world unit per cell", () => {
    expect(groundRepeat([40, 10, 16])).toEqual([5, 2]);
    expect(groundRepeat(undefined)).toEqual([5, 5]);
    expect(groundRepeat([0, 0, 0])).toEqual([1, 1]);
  });
});

describe("emissive accents", () => {
  test("collectibles, interactables and exit doors all glow", () => {
    for (const kind of ["collectible", "interactable", "exitDoor"]) {
      expect(EMISSIVE_STRENGTH[kind]).toBeGreaterThan(0);
    }
    expect(EMISSIVE_STRENGTH.prop).toBeUndefined();
    expect(EMISSIVE_STRENGTH.platform).toBeUndefined();
  });
});

describe("applyWorldEnvironment", () => {
  test("lights, fog, ground and obstacles are added without touching the scene's own objects", () => {
    const scene = new THREE.Scene();
    const marker = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    marker.name = "player";
    scene.add(marker);

    const world = worldFor({ lighting: "night", skybox: "cave" });
    const snapshot = JSON.stringify(world);
    applyWorldEnvironment(scene, world);

    expect(JSON.stringify(world)).toBe(snapshot);
    expect(scene.getObjectByName("player")).toBe(marker);

    const group = scene.getObjectByName(WORLD_ENVIRONMENT_NAME);
    expect(group).toBeDefined();
    const ambient = group?.getObjectByName(
      `${WORLD_ENVIRONMENT_NAME}:ambient`
    ) as THREE.AmbientLight;
    const hemisphere = group?.getObjectByName(
      `${WORLD_ENVIRONMENT_NAME}:hemisphere`
    ) as THREE.HemisphereLight;
    const sun = group?.getObjectByName(
      `${WORLD_ENVIRONMENT_NAME}:sun`
    ) as THREE.DirectionalLight;
    expect(ambient.intensity).toBeGreaterThanOrEqual(MIN_AMBIENT_INTENSITY);
    expect(hemisphere.intensity).toBeGreaterThanOrEqual(
      MIN_HEMISPHERE_INTENSITY
    );
    expect(ambient.intensity + hemisphere.intensity).toBeGreaterThanOrEqual(
      MIN_FILL_INTENSITY
    );
    expect(sun.intensity).toBeGreaterThanOrEqual(MIN_DIRECTIONAL_INTENSITY);

    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    const fog = scene.fog as THREE.Fog;
    expect(fog.color.getHexString()).toBe(
      skyGradient("cave", "night").middle.slice(1)
    );
    expect(fog.near).toBe(24 * FOG_NEAR_RATIO);
    expect(fog.far).toBe(24 * FOG_FAR_RATIO);

    // no DOM canvas in node: background falls back to the mood color
    expect(scene.background).toBeInstanceOf(THREE.Color);

    const ground = group?.getObjectByName(
      `${WORLD_ENVIRONMENT_NAME}:ground`
    ) as THREE.Mesh;
    const plane = ground.geometry as THREE.PlaneGeometry;
    expect(plane.parameters.width).toBe(24);
    expect(plane.parameters.height).toBe(16);
    expect(ground.rotation.x).toBeCloseTo(-Math.PI / 2);

    const obstacleMeshes: THREE.Mesh[] = [];
    group?.traverse((object) => {
      if (object.userData.obstacle === true) obstacleMeshes.push(object as THREE.Mesh);
    });
    expect(obstacleMeshes).toHaveLength(1);
    const bounds = new THREE.Box3().setFromObject(obstacleMeshes[0]);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    expect(size.x).toBeCloseTo(2);
    expect(size.y).toBeCloseTo(1);
    expect(size.z).toBeCloseTo(2);
    expect(center.x).toBeCloseTo(2);
    expect(center.y).toBeCloseTo(0.5);
    expect(center.z).toBeCloseTo(-3);
  });

  test("re-applying replaces the environment instead of stacking it", () => {
    const scene = new THREE.Scene();
    applyWorldEnvironment(scene, worldFor());
    const afterFirst = scene.children.length;
    const { fog: firstFog } = scene;
    applyWorldEnvironment(scene, worldFor());
    expect(scene.children.length).toBe(afterFirst);
    expect(scene.fog).not.toBe(firstFog);
    expect(
      scene.children.filter((child) => child.name === WORLD_ENVIRONMENT_NAME)
    ).toHaveLength(1);

    applyWorldEnvironment(scene, worldFor({ lighting: "day", skybox: "outdoor" }));
    expect(
      scene.children.filter((child) => child.name === WORLD_ENVIRONMENT_NAME)
    ).toHaveLength(1);
    const ambient = scene.getObjectByName(
      `${WORLD_ENVIRONMENT_NAME}:ambient`
    ) as THREE.AmbientLight;
    expect(ambient.intensity).toBe(LIGHTING_PROFILES.day.ambient);
  });

  test("uses the default world when none is provided", () => {
    const scene = new THREE.Scene();
    applyWorldEnvironment(scene);
    const ground = scene.getObjectByName(
      `${WORLD_ENVIRONMENT_NAME}:ground`
    ) as THREE.Mesh;
    const plane = ground.geometry as THREE.PlaneGeometry;
    expect(plane.parameters.width).toBe(DEFAULT_WORLD.bounds[0]);
    expect(plane.parameters.height).toBe(DEFAULT_WORLD.bounds[2]);
    const ambient = scene.getObjectByName(
      `${WORLD_ENVIRONMENT_NAME}:ambient`
    ) as THREE.AmbientLight;
    expect(ambient.intensity).toBe(
      LIGHTING_PROFILES[DEFAULT_WORLD.lighting].ambient
    );
  });
});

describe("package boundaries", () => {
  test('three is only imported by packages/render and apps/web', () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const scanned = [
      "packages/engine/src",
      "packages/schema/src",
      "packages/shared/src",
      "server/src",
      "api",
    ];
    let checked = 0;
    for (const directory of scanned) {
      for (const file of listTypeScriptFiles(join(repoRoot, directory))) {
        checked += 1;
        expect(readFileSync(file, "utf8"), file).not.toMatch(
          /from\s+["']three["']/
        );
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

function listTypeScriptFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function hexToRgbChannels(hex: string): { red: number; blue: number } {
  const value = hex.replace("#", "");
  return {
    red: Number.parseInt(value.slice(0, 2), 16),
    blue: Number.parseInt(value.slice(4, 6), 16),
  };
}
