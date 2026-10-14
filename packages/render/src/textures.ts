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

/** Square canvas edge in pixels; patterns are drawn for any size but tested at this one. */
export const TEXTURE_IMAGE_SIZE = 128;

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

function drawTexture(name: TextureImageName): THREE.CanvasTexture | null {
  const canvas = document.createElement("canvas");
  const size = TEXTURE_IMAGE_SIZE;
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

/** Dark board with glowing traces and solder pads. */
function drawCircuit(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = "#04231a";
  ctx.fillRect(0, 0, size, size);

  const step = size / 4;
  ctx.strokeStyle = "#34d399";
  ctx.lineWidth = 3;
  for (let i = 0; i < 4; i += 1) {
    const y = step / 2 + i * step;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();

    const x = step / 2 + ((i + 1) % 4) * step;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }

  ctx.fillStyle = "#a7f3d0";
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      ctx.fillRect(
        i * step + step / 2 - 4,
        j * step + step / 2 - 4,
        8,
        8
      );
    }
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
