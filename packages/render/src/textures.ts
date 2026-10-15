import type { PartTexture } from "@prompt-to-playable/schema";
import * as THREE from "three";

/**
 * Procedural canvas textures for part materials. Textures are generated once
 * per name and cached for the lifetime of the process: they are deterministic
 * (fixed drawing commands, no randomness) and shared by every material that
 * references the same name, so renderer disposal never disposes them.
 *
 * `glass` is intentionally NOT an image texture: it resolves to translucent
 * standard-material parameters (`GLASS_OPACITY` / `GLASS_ROUGHNESS`) that
 * `parts.ts` applies, keeping flat glass readable without a pattern.
 *
 * Node safety: without a DOM (`typeof document === "undefined"`) no canvas can
 * be created, so `textureForName` returns `null` and materials simply render
 * untextured. Tests rely on this fallback.
 */

export const TEXTURE_NAMES = [
  "circuit",
  "wood",
  "brick",
  "metal",
  "grid",
  "glass",
] as const;

export type TextureName = (typeof TEXTURE_NAMES)[number];

/** Names backed by a drawn canvas image (everything except `glass`). */
export const TEXTURE_IMAGE_NAMES = [
  "circuit",
  "wood",
  "brick",
  "metal",
  "grid",
] as const;

export type TextureImageName = (typeof TEXTURE_IMAGE_NAMES)[number];

/** Square canvas edge for legacy patterns (wood/brick/metal/grid). */
export const TEXTURE_IMAGE_SIZE = 128;

/** Square canvas edge of the circuit solder-mask tile: high-res PCB detail. */
export const CIRCUIT_TILE_SIZE = 1024;

/**
 * World units (entity-local) one circuit tile spans when mapped to a part.
 * Tuned against the authored board scale: the heypcb-grade PCB is ~12 units
 * long (about 200 mm), so a 2-unit tile lands trace widths near 0.2 mm and pad
 * diameters near 1.2 mm equivalents (real PCB proportions) while keeping
 * traces and pads readable from the inspect camera's auto-fit distance
 * (~15 units) where a 1-unit tile renders pads sub-2px and traces sub-pixel.
 */
export const CIRCUIT_TILE_WORLD_SIZE = 2;

/** userData flag on per-part texture clones so renderer disposal can free them. */
export const TEXTURE_CLONE_KEY = "textureClone";

/** Translucent material parameters applied to `texture: "glass"` parts. */
export const GLASS_OPACITY = 0.25;
export const GLASS_ROUGHNESS = 0.1;

export function isTextureName(value: unknown): value is TextureName {
  return (
    typeof value === "string" &&
    (TEXTURE_NAMES as readonly string[]).includes(value)
  );
}

const cache = new Map<TextureImageName, THREE.CanvasTexture>();

/**
 * Canvas texture for a part texture name, or `null` when the name is unknown,
 * refers to `glass` (material parameters instead), or no DOM is available.
 * Results for drawn names are cached, so repeated calls return the same
 * `THREE.CanvasTexture` instance.
 */
export function textureForName(name: string): THREE.CanvasTexture | null {
  if (!isTextureName(name)) return null;
  if (name === "glass") return null;
  const cached = cache.get(name);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const texture = drawTexture(name);
  if (!texture) return null;
  cache.set(name, texture);
  return texture;
}

/** Canvas edge per drawn name: circuit gets a high-res tile, others stay small. */
const TEXTURE_IMAGE_SIZES: Record<TextureImageName, number> = {
  circuit: CIRCUIT_TILE_SIZE,
  wood: TEXTURE_IMAGE_SIZE,
  brick: TEXTURE_IMAGE_SIZE,
  metal: TEXTURE_IMAGE_SIZE,
  grid: TEXTURE_IMAGE_SIZE,
};

/**
 * Texture map for one part of the given local size. Non-circuit names return
 * the shared cached texture unchanged. `circuit` returns a cheap per-part clone
 * whose `repeat` follows the part footprint, so traces keep their real-world
 * scale on boards of any size (clone images share the cached canvas). Clones
 * are tagged with `TEXTURE_CLONE_KEY` for disposal; `glass` and unknown names
 * resolve to `null` (glass uses translucent material parameters instead).
 */
export function textureMapForPart(
  name: string,
  size: readonly [number, number, number]
): THREE.CanvasTexture | null {
  const texture = textureForName(name);
  if (!texture) return null;
  if (name !== "circuit") return texture;
  const clone = texture.clone();
  clone.repeat.set(
    Math.max(1, Math.round(Math.abs(size[0]) / CIRCUIT_TILE_WORLD_SIZE)),
    Math.max(1, Math.round(Math.abs(size[2]) / CIRCUIT_TILE_WORLD_SIZE))
  );
  clone.userData[TEXTURE_CLONE_KEY] = true;
  clone.needsUpdate = true;
  return clone;
}

function drawTexture(name: TextureImageName): THREE.CanvasTexture | null {
  const canvas = document.createElement("canvas");
  const size = TEXTURE_IMAGE_SIZES[name];
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  switch (name) {
    case "circuit":
      drawCircuit(ctx, size);
      break;
    case "wood":
      drawWood(ctx, size);
      break;
    case "brick":
      drawBrick(ctx, size);
      break;
    case "metal":
      drawMetal(ctx, size);
      break;
    case "grid":
      drawGrid(ctx, size);
      break;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Dark green solder mask with gold traces, pads and vias. */
const CIRCUIT_MASK_COLOR = "#1b4d2e";
const CIRCUIT_MASK_SHADOW = "#123a22";
const CIRCUIT_GOLD = "#d4af37";
/** Fixed seed: the tile must be pixel-identical across runs and processes. */
const CIRCUIT_SEED = 0x1b4d2e;

/** Tiny deterministic PRNG (mulberry32); no Math.random anywhere. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Diagonal + orthogonal walk directions, indexed so +1/-1 turns are 45 degrees. */
const CIRCUIT_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * PCB-grade circuit tile: dark solder mask, subtle mask mottling, 5 routed
 * traces that mix straight runs with 45-degree turns, gold pads with dark
 * drill centers and small vias. Every sequence is driven by a fixed-seed PRNG,
 * so the tile is identical for every run.
 */
function drawCircuit(ctx: CanvasRenderingContext2D, size: number): void {
  const unit = size / 1024;
  const rand = mulberry32(CIRCUIT_SEED);

  ctx.fillStyle = CIRCUIT_MASK_COLOR;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 64; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const radius = (18 + rand() * 70) * unit;
    ctx.fillStyle =
      rand() < 0.5 ? "rgba(255, 255, 255, 0.022)" : "rgba(0, 0, 0, 0.045)";
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const step = size / 16;
  const margin = size * 0.04;
  ctx.strokeStyle = CIRCUIT_GOLD;
  ctx.lineWidth = 6 * unit;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const traceEnds: Array<readonly [number, number]> = [];
  for (let trace = 0; trace < 5; trace += 1) {
    let x = (0.25 + rand() * 0.5) * size;
    let y = (0.25 + rand() * 0.5) * size;
    let direction = Math.floor(rand() * 8) % 8;
    const segments = 4 + Math.floor(rand() * 3);

    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let segment = 0; segment < segments; segment += 1) {
      const length = (1 + Math.floor(rand() * 3)) * step;
      // Weighted roll: half of the segments run straight, the rest bend 45
      // degrees left or right (falling back to straight, then the opposite
      // turn, when a candidate would leave the tile margin).
      const roll = rand();
      const turn = roll < 0.5 ? 0 : roll < 0.75 ? -1 : 1;
      const candidates = turn === 0 ? [0, 1, -1] : [turn, 0, -turn];
      let advanced = false;
      for (const delta of candidates) {
        const nextDirection = (direction + delta + 8) % 8;
        const [dx, dy] = CIRCUIT_DIRECTIONS[nextDirection]!;
        const nextX = x + dx * length;
        const nextY = y + dy * length;
        if (
          nextX < margin ||
          nextX > size - margin ||
          nextY < margin ||
          nextY > size - margin
        ) {
          continue;
        }
        direction = nextDirection;
        x = nextX;
        y = nextY;
        ctx.lineTo(x, y);
        advanced = true;
        break;
      }
      if (!advanced) break;
    }
    ctx.stroke();
    traceEnds.push([x, y]);
  }

  const padRadius = 18 * unit;
  const padSpots: Array<readonly [number, number]> = [...traceEnds];
  const grid = size / 4;
  for (let i = 0; i < 4; i += 1) {
    const column = Math.floor(rand() * 4);
    const row = Math.floor(rand() * 4);
    padSpots.push([column * grid + grid / 2, row * grid + grid / 2]);
  }

  ctx.fillStyle = CIRCUIT_GOLD;
  for (const [padX, padY] of padSpots) {
    ctx.fillStyle = CIRCUIT_GOLD;
    ctx.beginPath();
    ctx.arc(padX, padY, padRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = CIRCUIT_MASK_SHADOW;
    ctx.beginPath();
    ctx.arc(padX, padY, padRadius * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.lineWidth = 3 * unit;
  for (let i = 0; i < 14; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    ctx.strokeStyle = CIRCUIT_GOLD;
    ctx.beginPath();
    ctx.arc(x, y, 6 * unit, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = CIRCUIT_MASK_SHADOW;
    ctx.beginPath();
    ctx.arc(x, y, 2.5 * unit, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Warm planks with grain curves and subtle seams. */
function drawWood(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = "#8a5a2b";
  ctx.fillRect(0, 0, size, size);

  const bands = 8;
  for (let i = 0; i < bands; i += 1) {
    const y = (i + 0.5) * (size / bands);
    ctx.strokeStyle = i % 2 === 0 ? "#a9743c" : "#6b4420";
    ctx.lineWidth = 2 + (i % 3);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.quadraticCurveTo(size / 2, y + 6, size, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(60, 32, 10, 0.5)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 8; i += 1) {
    const x = (i + 0.5) * (size / 8);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 4, size);
    ctx.stroke();
  }
}

/** Offset running-bond bricks over a mortar base. */
function drawBrick(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = "#d8cfc0";
  ctx.fillRect(0, 0, size, size);

  const rows = 4;
  const brickWidth = size / 2;
  const brickHeight = size / rows;
  const gap = 4;

  ctx.fillStyle = "#a34a2a";
  for (let row = 0; row < rows; row += 1) {
    const offset = row % 2 === 0 ? 0 : -brickWidth / 2;
    for (let col = -1; col < 3; col += 1) {
      ctx.fillRect(
        col * brickWidth + offset + gap / 2,
        row * brickHeight + gap / 2,
        brickWidth - gap,
        brickHeight - gap
      );
    }
  }
}

/** Brushed-metal banding with corner rivets. */
function drawMetal(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = "#8b95a3";
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 32; i += 1) {
    const y = (i + 0.5) * (size / 32);
    ctx.strokeStyle =
      i % 2 === 0 ? "rgba(255, 255, 255, 0.18)" : "rgba(30, 41, 59, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#5b6673";
  const rivets: ReadonlyArray<readonly [number, number]> = [
    [12, 12],
    [size - 12, 12],
    [12, size - 12],
    [size - 12, size - 12],
  ];
  for (const [x, y] of rivets) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Technical cyan grid on a dark panel. */
function drawGrid(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, size, size);

  const step = size / 8;
  ctx.strokeStyle = "rgba(56, 189, 248, 0.55)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i += 1) {
    const offset = i * step;
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, offset);
    ctx.lineTo(size, offset);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(56, 189, 248, 0.9)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();
}
