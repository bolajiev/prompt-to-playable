import type { EntityLabel } from "@prompt-to-playable/schema";
import * as THREE from "three";

/**
 * Floating labels: a camera-facing `THREE.Sprite` rendered from a canvas
 * (white text on a translucent dark rounded rect). Sprites are born facing
 * the camera, so no per-frame orientation work is needed; the renderer parents
 * them to the entity view, which carries runtime position and visibility.
 *
 * Node safety: without a DOM the sprite is still created (so callers can place
 * it deterministically), just without the canvas map; browsers always get the
 * textured version. The fallback only exists for tests / SSR-ish contexts.
 */

/** Object name used by the renderer to find an entity's label sprite. */
export const LABEL_SPRITE_NAME = "__label";
/** Default sprite height in entity-local units. */
export const LABEL_DEFAULT_SIZE = 0.9;
/** Default text color drawn on the canvas. */
export const LABEL_TEXT_COLOR = "#ffffff";
/** Canvas text size in pixels; canvas dimensions derive from it deterministically. */
export const LABEL_FONT_SIZE = 64;
export const LABEL_CANVAS_PADDING = 24;
const LABEL_CHAR_WIDTH_RATIO = 0.62;
const LABEL_BACKGROUND = "rgba(15, 23, 42, 0.78)";

export interface LabelCanvasSize {
  width: number;
  height: number;
}

/**
 * Deterministic canvas size from the text length (no `measureText`, so the
 * sprite aspect is identical with and without a DOM).
 */
export function labelCanvasSize(text: string): LabelCanvasSize {
  const characters = Math.max(1, text.length);
  return {
    width: Math.ceil(
      characters * LABEL_FONT_SIZE * LABEL_CHAR_WIDTH_RATIO +
        LABEL_CANVAS_PADDING * 2
    ),
    height: LABEL_FONT_SIZE + LABEL_CANVAS_PADDING * 2,
  };
}

/**
 * Build the label sprite: `label.size` (default 0.9) is the sprite height,
 * width follows the canvas aspect; `label.offset` is applied in entity-local
 * space. Never returns null — without a DOM the material is a plain
 * translucent sprite with no map.
 */
export function buildLabelSprite(
  label: EntityLabel,
  color: string = LABEL_TEXT_COLOR
): THREE.Sprite {
  const size = label.size ?? LABEL_DEFAULT_SIZE;
  const { width, height } = labelCanvasSize(label.text);
  const material = new THREE.SpriteMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
  });
  const map = drawLabelTexture(label.text, color, width, height);
  if (map) material.map = map;

  const sprite = new THREE.Sprite(material);
  sprite.name = LABEL_SPRITE_NAME;
  sprite.scale.set(size * (width / height), size, 1);
  const offset = label.offset ?? [0, 0, 0];
  sprite.position.set(offset[0], offset[1], offset[2]);
  sprite.userData.visualOnly = true;
  sprite.userData.labelText = label.text;
  return sprite;
}

function drawLabelTexture(
  text: string,
  color: string,
  width: number,
  height: number
): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const inset = 6;
  const radius = (height - inset * 2) / 3;
  roundedRect(ctx, inset, inset, width - inset * 2, height - inset * 2, radius);
  ctx.fillStyle = LABEL_BACKGROUND;
  ctx.fill();

  ctx.fillStyle = color;
  ctx.font = `bold ${LABEL_FONT_SIZE}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
