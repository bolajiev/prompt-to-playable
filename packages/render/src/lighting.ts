import type {
  Lighting,
  Skybox,
  Terrain,
  Vec3,
  World,
} from "@prompt-to-playable/schema";
import * as THREE from "three";

/**
 * Lighting/environment vocabulary for generated worlds. The preset tables and
 * color math below are pure data + functions so they can be unit-tested in
 * node; only the texture makers and `applyWorldEnvironment` touch Three.js,
 * and canvas creation is guarded for non-browser runtimes.
 */

/** Light intensities, colors and sun placement for one `world.lighting` mood. */
export interface LightingProfile {
  ambient: number;
  hemisphere: number;
  directional: number;
  ambientColor: string;
  hemisphereSky: string;
  hemisphereGround: string;
  directionalColor: string;
  /** Directional light offset from the origin (world units). */
  sunPosition: Vec3;
  /** Fallback scene background when no canvas (and thus no sky) is available. */
  background: string;
}

/**
 * Per-`world.lighting` profiles. Morning/evening/night/indoor may be dimmer
 * than day, but every profile keeps a high ambient floor plus hemisphere fill,
 * so a generated game is never pitch black; night uses cold moonlit colors.
 */
export const LIGHTING_PROFILES: Record<Lighting, LightingProfile> = {
  dawn: {
    ambient: 1.3,
    hemisphere: 0.6,
    directional: 1.45,
    ambientColor: "#ffe7d1",
    hemisphereSky: "#ffd8b0",
    hemisphereGround: "#5c4a3f",
    directionalColor: "#ffc98a",
    sunPosition: [10, 6, -8],
    background: "#20161c",
  },
  day: {
    ambient: 1.4,
    hemisphere: 0.7,
    directional: 1.6,
    ambientColor: "#ffffff",
    hemisphereSky: "#cfe3ff",
    hemisphereGround: "#4b5563",
    directionalColor: "#fff6e0",
    sunPosition: [8, 14, 6],
    background: "#0f172a",
  },
  dusk: {
    ambient: 1.28,
    hemisphere: 0.55,
    directional: 1.3,
    ambientColor: "#ffd4c0",
    hemisphereSky: "#ff9f7a",
    hemisphereGround: "#3f3a4d",
    directionalColor: "#ff9e63",
    sunPosition: [-10, 5, 8],
    background: "#1a1424",
  },
  night: {
    ambient: 1.22,
    hemisphere: 0.52,
    directional: 1.05,
    ambientColor: "#cdd9ff",
    hemisphereSky: "#93a7e8",
    hemisphereGround: "#1f2a44",
    directionalColor: "#a9c2ff",
    sunPosition: [-6, 12, -10],
    background: "#0b1120",
  },
  indoor: {
    ambient: 1.25,
    hemisphere: 0.55,
    directional: 1,
    ambientColor: "#f4e8d0",
    hemisphereSky: "#e6d9c2",
    hemisphereGround: "#3a3632",
    directionalColor: "#fff0d0",
    sunPosition: [6, 12, 6],
    background: "#101827",
  },
};

/** Ambient intensity every profile must keep for scenes to stay readable. */
export const MIN_AMBIENT_INTENSITY = 1.2;
/** Hemisphere fill every profile must keep for scenes to stay readable. */
export const MIN_HEMISPHERE_INTENSITY = 0.5;
/** Combined ambient + hemisphere fill floor (the "never black" guarantee). */
export const MIN_FILL_INTENSITY = 1.7;
/** Directional floor per mood; nights are moonlit, never unlit. */
export const MIN_DIRECTIONAL_INTENSITY = 1;

export function lightingProfile(lighting: Lighting | undefined): LightingProfile {
  return LIGHTING_PROFILES[lighting ?? "day"];
}

/** Three-stop vertical sky gradient for one `world.skybox`. */
export interface SkyboxGradient {
  top: string;
  middle: string;
  bottom: string;
}

export const SKYBOX_GRADIENTS: Record<Skybox, SkyboxGradient> = {
  cave: { top: "#03060c", middle: "#0b101c", bottom: "#161e2e" },
  outdoor: { top: "#0a1226", middle: "#20335a", bottom: "#4a628f" },
  lab: { top: "#061019", middle: "#0d2130", bottom: "#1b3a4b" },
};

/** Horizon tint each lighting mood blends into the skybox, with blend weight. */
export const LIGHTING_HORIZON: Record<Lighting, { color: string; mix: number }> = {
  dawn: { color: "#ffb37a", mix: 0.55 },
  day: { color: "#bcd4ff", mix: 0.18 },
  dusk: { color: "#ff7a4d", mix: 0.6 },
  night: { color: "#101b33", mix: 0.45 },
  indoor: { color: "#26384a", mix: 0.3 },
};

export interface GradientStop {
  offset: number;
  color: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function channelToHex(channel: number): string {
  return Math.round(Math.min(255, Math.max(0, channel)))
    .toString(16)
    .padStart(2, "0");
}

/** Linear RGB blend of two `#rrggbb` colors; `t` is clamped to [0, 1]. */
export function mixHexColors(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const mix = Math.min(1, Math.max(0, t));
  return `#${channelToHex(ar + (br - ar) * mix)}${channelToHex(
    ag + (bg - ag) * mix
  )}${channelToHex(ab + (bb - ab) * mix)}`;
}

/**
 * Deterministic sky gradient for a `(skybox, lighting)` pair: the skybox owns
 * the overall ramp, the lighting mood warms/cools the horizon.
 */
export function skyGradient(
  skybox: Skybox | undefined,
  lighting?: Lighting
): SkyboxGradient {
  const base = SKYBOX_GRADIENTS[skybox ?? "outdoor"];
  const horizon = LIGHTING_HORIZON[lighting ?? "day"];
  return {
    top: base.top,
    middle: mixHexColors(base.middle, horizon.color, horizon.mix * 0.6),
    bottom: mixHexColors(base.bottom, horizon.color, horizon.mix),
  };
}

/** Canvas-ready gradient stops, ordered top (0) to bottom (1). */
export function skyGradientStops(
  skybox: Skybox | undefined,
  lighting?: Lighting
): GradientStop[] {
  const gradient = skyGradient(skybox, lighting);
  return [
    { offset: 0, color: gradient.top },
    { offset: 0.55, color: gradient.middle },
    { offset: 1, color: gradient.bottom },
  ];
}

export interface FogSettings {
  color: string;
  near: number;
  far: number;
}

/** Fog starts at 3/4 and ends at 2.5x of the world's largest horizontal span. */
export const FOG_NEAR_RATIO = 0.75;
export const FOG_FAR_RATIO = 2.5;

/** Subtle fog matched to the sky horizon, scaled so large worlds stay visible. */
export function fogSettings(
  skybox: Skybox | undefined,
  lighting: Lighting | undefined,
  bounds: Vec3 | undefined
): FogSettings {
  const gradient = skyGradient(skybox, lighting);
  const span = Math.max(bounds?.[0] ?? 0, bounds?.[2] ?? 0, 1);
  return {
    color: gradient.middle,
    near: span * FOG_NEAR_RATIO,
    far: span * FOG_FAR_RATIO,
  };
}

/** Checker/grid ground colors, keyed by terrain type. */
export interface GroundPalette {
  base: string;
  alternate: string;
  line: string;
  obstacle: string;
}

export const GROUND_PALETTES: Record<Terrain["type"], GroundPalette> = {
  flat: {
    base: "#232f45",
    alternate: "#1b2436",
    line: "#3b4c6b",
    obstacle: "#2c3a54",
  },
  mesh: {
    base: "#22322d",
    alternate: "#1a2723",
    line: "#3a5a4e",
    obstacle: "#2b423a",
  },
};

export function groundPalette(terrain: Terrain | undefined): GroundPalette {
  return GROUND_PALETTES[terrain?.type ?? "flat"];
}

/** World units covered by one ground texture tile (8 checker cells per tile). */
export const GROUND_TILE_WORLD_SIZE = 8;
const GROUND_TEXTURE_SIZE = 256;
const GROUND_CHECKER_CELLS = 8;
const SKY_TEXTURE_WIDTH = 4;
const SKY_TEXTURE_HEIGHT = 256;

/** Texture repeats (x, z) so a bounds-sized plane keeps ~1-unit checker cells. */
export function groundRepeat(bounds: Vec3 | undefined): [number, number] {
  const repeatX = Math.max(
    1,
    Math.round((bounds?.[0] ?? 40) / GROUND_TILE_WORLD_SIZE)
  );
  const repeatZ = Math.max(
    1,
    Math.round((bounds?.[2] ?? 40) / GROUND_TILE_WORLD_SIZE)
  );
  return [repeatX, repeatZ];
}

function createCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Vertical sky gradient as a CanvasTexture; `null` outside the browser. */
export function createSkyTexture(
  skybox: Skybox | undefined,
  lighting?: Lighting
): THREE.CanvasTexture | null {
  const canvas = createCanvas(SKY_TEXTURE_WIDTH, SKY_TEXTURE_HEIGHT);
  if (!canvas) return null;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const gradient = context.createLinearGradient(
    0,
    0,
    0,
    canvas.height
  );
  for (const stop of skyGradientStops(skybox, lighting)) {
    gradient.addColorStop(stop.offset, stop.color);
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Checker + grid ground texture tinted by terrain; `null` outside the browser. */
export function createGroundTexture(
  terrain: Terrain | undefined,
  bounds?: Vec3
): THREE.CanvasTexture | null {
  const canvas = createCanvas(GROUND_TEXTURE_SIZE, GROUND_TEXTURE_SIZE);
  if (!canvas) return null;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const palette = groundPalette(terrain);
  const cell = GROUND_TEXTURE_SIZE / GROUND_CHECKER_CELLS;
  for (let row = 0; row < GROUND_CHECKER_CELLS; row += 1) {
    for (let column = 0; column < GROUND_CHECKER_CELLS; column += 1) {
      context.fillStyle =
        (row + column) % 2 === 0 ? palette.base : palette.alternate;
      context.fillRect(column * cell, row * cell, cell, cell);
    }
  }

  context.strokeStyle = palette.line;
  context.lineWidth = 2;
  for (let index = 0; index <= GROUND_CHECKER_CELLS; index += 1) {
    const position = index * cell;
    context.beginPath();
    context.moveTo(position, 0);
    context.lineTo(position, GROUND_TEXTURE_SIZE);
    context.stroke();
    context.beginPath();
    context.moveTo(0, position);
    context.lineTo(GROUND_TEXTURE_SIZE, position);
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  const [repeatX, repeatZ] = groundRepeat(bounds);
  texture.repeat.set(repeatX, repeatZ);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Name of the injected environment group, so re-application can replace it. */
export const WORLD_ENVIRONMENT_NAME = "__worldEnvironment";
const ENVIRONMENT_OWNED = "__worldEnvironmentOwned";

/**
 * Background for the empty studio scene (no document loaded yet): near-black so
 * the stage matches the black theme. Explicit world presets keep their own
 * sky/background untouched - only the no-document default look changes.
 */
export const EMPTY_SCENE_BACKGROUND = "#050507";

/** Neutral world used before a game loads (and for any undefined field). */
export const DEFAULT_WORLD: World = {
  bounds: [40, 20, 40],
  lighting: "day",
  skybox: "outdoor",
  gravity: 9.8,
  terrain: { type: "flat", obstacles: [] },
};

function disposeMaterial(material: THREE.Material): void {
  const textured = material as THREE.MeshStandardMaterial;
  textured.map?.dispose?.();
  material.dispose();
}

function disposeEnvironment(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) materials.add(entry);
    } else if (material) {
      materials.add(material);
    }
  });
  for (const material of materials) disposeMaterial(material);
}

function clearEnvironment(scene: THREE.Scene): void {
  const previous = scene.getObjectByName(WORLD_ENVIRONMENT_NAME);
  if (previous) {
    scene.remove(previous);
    disposeEnvironment(previous);
  }
  const background = scene.background;
  if (
    background instanceof THREE.Texture &&
    background.userData[ENVIRONMENT_OWNED] === true
  ) {
    background.dispose();
  }
}

/**
 * Applies the complete world environment to a scene: sky background, matched
 * fog, mood lights, a bounds-sized textured ground plane and terrain obstacles.
 * Re-applying replaces the previous environment (idempotent) and only reads
 * `world` — it never mutates the game document or engine state.
 */
export function applyWorldEnvironment(
  scene: THREE.Scene,
  world?: World
): void {
  const value = world ?? DEFAULT_WORLD;
  const preset = lightingProfile(value.lighting);
  const terrain = value.terrain ?? { type: "flat" as const, obstacles: [] };
  const bounds = value.bounds ?? DEFAULT_WORLD.bounds;

  clearEnvironment(scene);

  if (world === undefined) {
    scene.background = new THREE.Color(EMPTY_SCENE_BACKGROUND);
  } else {
    const skyTexture = createSkyTexture(value.skybox, value.lighting);
    if (skyTexture) {
      skyTexture.userData[ENVIRONMENT_OWNED] = true;
      scene.background = skyTexture;
    } else {
      scene.background = new THREE.Color(preset.background);
    }
  }

  const fog = fogSettings(value.skybox, value.lighting, bounds);
  scene.fog = new THREE.Fog(new THREE.Color(fog.color), fog.near, fog.far);

  const group = new THREE.Group();
  group.name = WORLD_ENVIRONMENT_NAME;

  const ambient = new THREE.AmbientLight(
    new THREE.Color(preset.ambientColor),
    preset.ambient
  );
  ambient.name = `${WORLD_ENVIRONMENT_NAME}:ambient`;
  const hemisphere = new THREE.HemisphereLight(
    new THREE.Color(preset.hemisphereSky),
    new THREE.Color(preset.hemisphereGround),
    preset.hemisphere
  );
  hemisphere.name = `${WORLD_ENVIRONMENT_NAME}:hemisphere`;
  const sun = new THREE.DirectionalLight(
    new THREE.Color(preset.directionalColor),
    preset.directional
  );
  sun.name = `${WORLD_ENVIRONMENT_NAME}:sun`;
  sun.position.set(...preset.sunPosition);
  group.add(ambient, hemisphere, sun);

  const palette = groundPalette(terrain);
  const groundTexture = createGroundTexture(terrain, bounds);
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(groundTexture ? "#ffffff" : palette.base),
    map: groundTexture,
    roughness: 0.95,
    metalness: 0.02,
  });
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(bounds[0], bounds[2]),
    groundMaterial
  );
  ground.name = `${WORLD_ENVIRONMENT_NAME}:ground`;
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  const obstacleMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(palette.obstacle),
    roughness: 0.9,
    metalness: 0.02,
  });
  terrain.obstacles.forEach((obstacle, index) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(...obstacle.size),
      obstacleMaterial
    );
    mesh.name = `${WORLD_ENVIRONMENT_NAME}:obstacle:${index}`;
    mesh.position.set(...obstacle.position);
    mesh.userData.obstacle = true;
    group.add(mesh);
  });

  scene.add(group);
}
