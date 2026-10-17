import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright";
import { resolveChromiumExecutable } from "./playwright-env.js";
import { landingUrl, normalizeStudioUrl } from "./studio-url.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = join(ROOT, "artifacts", "qa");

/** Hero heading the landing smoke beat asserts on. */
export const LANDING_HERO_TEXT = "Describe a world. Walk into it.";

export const QA_PROMPT =
  "a small room where I collect 3 glowing crystals while avoiding one guard";
export const QA_EDIT_PROMPT = "add a second guard";
export const QA_EXPLORE_PROMPT = "a quiet forest clearing with a campfire at dusk";
export const QA_INSPECT_PROMPT =
  "a 3D circuit board with labeled chips I can click";
export const QA_WALKTHROUGH_PROMPT =
  "a small house I can walk through that has a door and a lamp";
export const QA_RACE_PROMPT =
  "a car racing game on an oval track with three checkpoints";

const VIEWPORT = { width: 1280, height: 720 };
const NAVIGATION_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 290_000;
const MOVE_HOLD_MS = 1_000;
const MIN_MOVE_DISTANCE = 0.05;
const MIN_CANVAS_COLORS = 16;
/** Hold time for the drive beat's throttle burst. */
const DRIVE_HOLD_MS = 3_000;
/** Minimum vehicle speed (units/s) a drive beat must reach under throttle. */
const MIN_DRIVE_SPEED = 2;
/** Interact key press is held this long so the fixed-step engine sees it. */
const INTERACT_PRESS_MS = 120;
/** Upper bound for observing an interact reaction (door slides run ~0.9 s). */
const INTERACT_SETTLE_MS = 1_200;
/** Poll interval while waiting for an interact reaction. */
const INTERACT_POLL_MS = 200;
/** Position/color/visible delta that counts as a reacted entity. */
const MIN_RUNTIME_CHANGE = 0.08;
/** Per-burst hold/recompute interval while walking toward an interactable. */
const WALK_STEP_MS = 180;
/** Total walk-up budget before giving up and pressing interact anyway. */
const WALK_BUDGET_MS = 4_000;
/** Engine fallback for entities without `props.interactRange`. */
const DEFAULT_INTERACT_RANGE = 2.5;
/**
 * Ground-forward basis at camera yaw 0 (`forwardFromYaw(0)` in the web
 * `CameraRig`). A fresh load resets the rig, so walkthrough input keeps this
 * fixed basis until the QA run itself drags the canvas.
 */
const YAW_ZERO_FORWARD: readonly [number, number] = [
  -0.4472135954999579,
  -0.8944271909999159,
];
/** Sine of 22.5 degrees: axis threshold for choosing a WASD key. */
const AXIS_KEY_THRESHOLD = 0.383;

export interface QaOptions {
  /**
   * Host root (`http://host:port`) or a full studio page URL; a root/empty
   * path is normalized to `/app.html` before any beat runs.
   */
  url: string;
  outDir?: string;
  /**
   * Stop after the landing smoke + studio load beats (browser/element smoke
   * checks, no live calls).
   */
  landingOnly?: boolean;
  /**
   * Extra fifth beat: reload, generate an explore scene from QA_EXPLORE_PROMPT,
   * then assert the free-roam HUD hint, a lit canvas and zero new console errors.
   */
  explore?: boolean;
  /**
   * Extra beats six to eight: fresh loads generating the inspect, walkthrough
   * and drive kits from their canonical prompts, asserting the mode HUD,
   * hover picking, door/lamp reaction and vehicle speed. Each kit beat costs
   * one live generation call.
   */
  kits?: boolean;
  /**
   * Skip the base generation/play/edit beats and run only the kit beats
   * (implies `kits`). Used to re-check one kit without paying for the base
   * generation and edit calls.
   */
  kitsOnly?: boolean;
}

export interface QaBeat {
  beat: string;
  ok: boolean;
  detail: string;
  screenshot?: string;
}

export type MovementMethod = "debug-hook" | "pixel-diff" | "none";

export interface QaResult {
  ok: boolean;
  url: string;
  beats: QaBeat[];
  consoleErrors: string[];
  movementMethod: MovementMethod;
  consoleLogPath: string;
}

interface ConsoleRecord {
  type: string;
  text: string;
  location: string;
}

type PlayerPosition = [number, number, number];

/**
 * Headless Chromium with software WebGL. `DISPLAY` is dropped because a stale
 * X display makes ANGLE try XCB and fail instead of using SwiftShader.
 */
export async function launchQaChromium(): Promise<Browser> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "DISPLAY" && value !== undefined) env[key] = value;
  }
  return chromium.launch({
    headless: true,
    executablePath: resolveChromiumExecutable(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
    env,
  });
}

function log(message: string): void {
  console.log(`[qa] ${message}`);
}

function expectCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Minimal 8-bit PNG decode used to prove the canvas is not a flat color. */
export function pngStats(buffer: Buffer): { width: number; height: number; distinct: number } {
  expectCondition(buffer.readUInt32BE(0) === 0x89504e47, "canvas screenshot is not a PNG");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      expectCondition(data[12] === 0, "interlaced PNG is unsupported");
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  expectCondition(width > 0 && height > 0, "PNG has no IHDR dimensions");
  expectCondition(
    bitDepth === 8 && (colorType === 2 || colorType === 6),
    `unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType})`
  );

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  expectCondition(raw.length >= height * (stride + 1), "PNG pixel data is truncated");

  const colors = new Set<number>();
  const previous = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  let position = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[position] ?? -1;
    position += 1;
    const source = raw.subarray(position, position + stride);
    position += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels] ?? 0 : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= channels ? previous[i - channels] ?? 0 : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = source[i] ?? 0;
          break;
        case 1:
          value = (source[i] ?? 0) + left;
          break;
        case 2:
          value = (source[i] ?? 0) + up;
          break;
        case 3:
          value = (source[i] ?? 0) + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          value = (source[i] ?? 0) + predictor;
          break;
        }
        default:
          throw new Error(`unknown PNG filter type ${filter}`);
      }
      row[i] = value & 0xff;
    }
    for (let x = 0; x < width; x += 2) {
      const o = x * channels;
      const r = (row[o] ?? 0) >> 3;
      const g = (row[o + 1] ?? 0) >> 3;
      const b = (row[o + 2] ?? 0) >> 3;
      colors.add((r << 10) | (g << 5) | b);
    }
    row.copy(previous);
  }

  return { width, height, distinct: colors.size };
}

async function canvasScreenshot(page: Page, path?: string): Promise<Buffer> {
  return page.locator("#game").screenshot(path ? { path } : undefined);
}

async function waitForValidated(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector("#badge")?.getAttribute("data-validated") === "true",
    undefined,
    { timeout }
  );
}

async function waitForObjective(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const items = document.querySelectorAll("#hud ul.objectives li");
      return (
        items.length > 0 &&
        Array.from(items).some((item) => (item.textContent ?? "").trim().length > 0)
      );
    },
    undefined,
    { timeout }
  );
}

async function chatErrorCount(page: Page): Promise<number> {
  return page.locator("#chat-log .line.error").count();
}

async function newChatError(page: Page, before: number): Promise<string | null> {
  const count = await chatErrorCount(page);
  if (count <= before) return null;
  const text = await page.locator("#chat-log .line.error").last().innerText();
  return text.replace(/\s+/g, " ").slice(0, 600);
}

/** Waits for generation success (badge) or a new chat error line. */
async function waitForGenerateOutcome(
  page: Page,
  errorsBefore: number,
  timeout: number
): Promise<void> {
  await page.waitForFunction(
    (before) => {
      const validated =
        document.querySelector("#badge")?.getAttribute("data-validated") === "true";
      const errors = document.querySelectorAll("#chat-log .line.error").length;
      return validated || errors > before;
    },
    errorsBefore,
    { timeout }
  );
}

/** Waits for an applied edit (chat text) or a new chat error line. */
async function waitForEditOutcome(
  page: Page,
  errorsBefore: number,
  timeout: number
): Promise<void> {
  await page.waitForFunction(
    (before) => {
      const applied = (document.querySelector("#chat-log")?.textContent ?? "").includes(
        "Applied edit to"
      );
      const errors = document.querySelectorAll("#chat-log .line.error").length;
      return applied || errors > before;
    },
    errorsBefore,
    { timeout }
  );
}

async function hasDebugHook(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      typeof (window as unknown as { __gameDebug?: { getState?: unknown } }).__gameDebug
        ?.getState === "function"
  );
}

async function readPlayerPosition(page: Page): Promise<PlayerPosition | null> {
  return page.evaluate(() => {
    const debug = (
      window as unknown as {
        __gameDebug?: { getState: () => unknown };
      }
    ).__gameDebug;
    if (!debug) return null;
    const state = debug.getState() as {
      entities?: Array<{ id?: string; kind?: string }>;
      entityRuntime?: Record<string, { position?: number[] }>;
    };
    const player = state.entities?.find((entity) => entity.kind === "player");
    if (!player?.id) return null;
    const position = state.entityRuntime?.[player.id]?.position;
    if (!position || position.length < 3) return null;
    return [position[0] ?? 0, position[1] ?? 0, position[2] ?? 0] as PlayerPosition;
  });
}

/** Vehicle scalar speed (units/s) from the player runtime, or null. */
async function readPlayerSpeed(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const debug = (
      window as unknown as {
        __gameDebug?: { getState: () => unknown };
      }
    ).__gameDebug;
    if (!debug) return null;
    const state = debug.getState() as {
      entities?: Array<{ id?: string; kind?: string }>;
      entityRuntime?: Record<string, { speed?: number }>;
    };
    const player = state.entities?.find((entity) => entity.kind === "player");
    if (!player?.id) return null;
    const speed = state.entityRuntime?.[player.id]?.speed;
    return typeof speed === "number" && Number.isFinite(speed) ? speed : null;
  });
}

/** Drops focus from the chat input so game keys reach the window listeners. */
async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

/**
 * Fresh load + `/generate` for one kit prompt, returning the elapsed ms once
 * the document is validated and rendered. Each kit beat starts clean so the
 * prompt takes the generation path instead of being treated as an edit.
 * State-keyed: waits for the validated badge (or a new chat error line).
 */
async function generateFromFreshLoad(
  page: Page,
  url: string,
  prompt: string
): Promise<number> {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => document.querySelector("#badge")?.getAttribute("data-validated") === "false",
    undefined,
    { timeout: NAVIGATION_TIMEOUT_MS }
  );
  const errorsBefore = await chatErrorCount(page);
  const started = Date.now();
  await page.fill("#chat-input", prompt);
  await page.click("#chat-submit");
  log(`submitted kit prompt (waiting up to ${RENDER_TIMEOUT_MS / 1000}s)`);
  await waitForGenerateOutcome(page, errorsBefore, RENDER_TIMEOUT_MS);
  const failure = await newChatError(page, errorsBefore);
  expectCondition(failure === null, `generation failed: ${failure}`);
  await waitForValidated(page, RENDER_TIMEOUT_MS);
  return Date.now() - started;
}

interface RuntimeSnapshot {
  position: PlayerPosition;
  visible: boolean;
  tags: string[];
  color: string | null;
}

interface InteractSnapshot {
  runtime: Record<string, RuntimeSnapshot>;
  /** Entities an `on.interact` rule owns (trigger or action target). */
  targets: string[];
}

/**
 * Compact runtime snapshot used to prove that pressing E made something react.
 * `state.doc` rides along in the debug clone, so the entities an interact rule
 * actually owns are known: a door slide moves the door, a lamp toggle changes
 * the lamp's color or its glow child's visibility.
 */
async function readInteractSnapshot(page: Page): Promise<InteractSnapshot | null> {
  return page.evaluate(() => {
    const debug = (
      window as unknown as {
        __gameDebug?: { getState: () => unknown };
      }
    ).__gameDebug;
    if (!debug) return null;
    const state = debug.getState() as {
      doc?: {
        rules?: Array<{
          on?: { event?: string; entity?: string };
          then?: Array<{ entity?: string }>;
        }>;
      };
      entities?: Array<{ id?: string; kind?: string; tags?: string[] }>;
      entityRuntime?: Record<
        string,
        {
          position?: number[];
          visible?: boolean;
          tags?: string[];
          color?: string;
        }
      >;
    };

    const runtime: Record<
      string,
      {
        position: [number, number, number];
        visible: boolean;
        tags: string[];
        color: string | null;
      }
    > = {};
    for (const [id, entry] of Object.entries(state.entityRuntime ?? {})) {
      const position = entry.position ?? [];
      runtime[id] = {
        position: [position[0] ?? 0, position[1] ?? 0, position[2] ?? 0],
        visible: entry.visible !== false,
        tags: [...(entry.tags ?? [])],
        color: entry.color ?? null,
      };
    }

    const targets = new Set<string>();
    for (const rule of state.doc?.rules ?? []) {
      if (rule.on?.event !== "interact") continue;
      if (typeof rule.on.entity === "string") targets.add(rule.on.entity);
      for (const action of rule.then ?? []) {
        if (typeof action.entity === "string") targets.add(action.entity);
      }
    }
    if (targets.size === 0) {
      for (const entity of state.entities ?? []) {
        if (entity.id === undefined) continue;
        if (
          entity.kind === "interactable" ||
          (entity.tags ?? []).includes("interactable")
        ) {
          targets.add(entity.id);
        }
      }
    }

    return { runtime, targets: [...targets] };
  });
}

/** Holds E long enough for the fixed-step engine to sample a rising edge. */
async function pressInteract(page: Page): Promise<void> {
  await page.keyboard.down("e");
  await page.waitForTimeout(INTERACT_PRESS_MS);
  await page.keyboard.up("e");
}

interface RuntimeChange {
  id: string;
  reason: string;
}

/** Position/visibility/color/tag deltas between two snapshots. */
function interactChanges(
  before: InteractSnapshot,
  after: InteractSnapshot
): RuntimeChange[] {
  const changes: RuntimeChange[] = [];
  for (const [id, next] of Object.entries(after.runtime)) {
    const previous = before.runtime[id];
    if (previous === undefined) {
      changes.push({ id, reason: "spawned" });
      continue;
    }
    const moved = Math.hypot(
      next.position[0] - previous.position[0],
      next.position[1] - previous.position[1],
      next.position[2] - previous.position[2]
    );
    if (moved > MIN_RUNTIME_CHANGE) {
      changes.push({ id, reason: `moved ${moved.toFixed(2)}` });
      continue;
    }
    if (previous.visible !== next.visible) {
      changes.push({
        id,
        reason: `visible ${previous.visible}->${next.visible}`,
      });
      continue;
    }
    if (previous.color !== next.color) {
      changes.push({
        id,
        reason: `color ${previous.color ?? "unset"}->${next.color ?? "unset"}`,
      });
      continue;
    }
    if (previous.tags.join("|") !== next.tags.join("|")) {
      changes.push({ id, reason: "tags changed" });
    }
  }
  return changes;
}

/**
 * State-keyed reaction wait: polls `__gameDebug` until an entity owned by an
 * interact rule changes, or the timeout elapses. Returns the last snapshot
 * plus every delta and the interact-owned subset.
 */
async function waitForInteractChange(
  page: Page,
  before: InteractSnapshot,
  targets: ReadonlySet<string>,
  timeoutMs: number
): Promise<{
  after: InteractSnapshot | null;
  changes: RuntimeChange[];
  reacted: RuntimeChange[];
}> {
  const started = Date.now();
  let after = await readInteractSnapshot(page);
  let changes = after === null ? [] : interactChanges(before, after);
  let reacted = changes.filter((change) => targets.has(change.id));
  while (reacted.length === 0 && Date.now() - started < timeoutMs) {
    await page.waitForTimeout(INTERACT_POLL_MS);
    after = await readInteractSnapshot(page);
    changes = after === null ? [] : interactChanges(before, after);
    reacted = changes.filter((change) => targets.has(change.id));
  }
  return { after, changes, reacted };
}

/**
 * Best-effort fallback for walkthroughs whose interactable spawns out of
 * range: burst-walk toward the nearest `interactable` entity using the fixed
 * yaw-0 camera basis, recomputing the direction every step. Returns the final
 * 3D distance to the target, or null when the debug hook exposes nothing.
 */
async function walkTowardNearestInteractable(
  page: Page,
  budgetMs: number
): Promise<number | null> {
  const started = Date.now();
  let lastDistance: number | null = null;

  while (Date.now() - started < budgetMs) {
    const info = await page.evaluate((defaultRange) => {
      const debug = (
        window as unknown as {
          __gameDebug?: { getState: () => unknown };
        }
      ).__gameDebug;
      if (!debug) return null;
      const state = debug.getState() as {
        entities?: Array<{
          id?: string;
          kind?: string;
          tags?: string[];
          props?: { interactRange?: number };
        }>;
        entityRuntime?: Record<string, { position?: number[]; visible?: boolean; tags?: string[] }>;
      };
      const player = state.entities?.find((entity) => entity.kind === "player");
      if (!player?.id) return null;
      const playerPosition = state.entityRuntime?.[player.id]?.position;
      if (!playerPosition || playerPosition.length < 3) return null;

      let best: {
        distance: number;
        dx: number;
        dz: number;
        range: number;
      } | null = null;
      for (const entity of state.entities ?? []) {
        if (entity.id === undefined || entity.id === player.id) continue;
        const runtime = state.entityRuntime?.[entity.id];
        if (!runtime || runtime.visible === false) continue;
        const tags = runtime.tags ?? entity.tags ?? [];
        if (entity.kind !== "interactable" && !tags.includes("interactable")) {
          continue;
        }
        const position = runtime.position;
        if (!position || position.length < 3) continue;
        const dx = (position[0] ?? 0) - (playerPosition[0] ?? 0);
        const dz = (position[2] ?? 0) - (playerPosition[2] ?? 0);
        const distance = Math.hypot(
          dx,
          (position[1] ?? 0) - (playerPosition[1] ?? 0),
          dz
        );
        if (distance < (best?.distance ?? Infinity)) {
          best = {
            distance,
            dx,
            dz,
            range:
              typeof entity.props?.interactRange === "number"
                ? entity.props.interactRange
                : defaultRange,
          };
        }
      }
      return best;
    }, DEFAULT_INTERACT_RANGE);

    if (info === null) return lastDistance;
    lastDistance = info.distance;
    if (info.distance <= Math.max(0.4, info.range * 0.6)) return info.distance;

    const horizontal = Math.hypot(info.dx, info.dz) || 1;
    const [fx, fz] = YAW_ZERO_FORWARD;
    const throttle = (info.dx / horizontal) * fx + (info.dz / horizontal) * fz;
    const strafe = (info.dx / horizontal) * -fz + (info.dz / horizontal) * fx;
    const keys: string[] = [];
    if (throttle > AXIS_KEY_THRESHOLD) keys.push("w");
    else if (throttle < -AXIS_KEY_THRESHOLD) keys.push("s");
    if (strafe > AXIS_KEY_THRESHOLD) keys.push("d");
    else if (strafe < -AXIS_KEY_THRESHOLD) keys.push("a");
    if (keys.length === 0) keys.push("w");

    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(WALK_STEP_MS);
    for (const key of keys) await page.keyboard.up(key);
  }

  return lastDistance;
}

export async function runQa(page: Page, options: QaOptions): Promise<QaResult> {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  mkdirSync(outDir, { recursive: true });

  const studioUrl = normalizeStudioUrl(options.url);
  const landingPageUrl = landingUrl(studioUrl);

  const beats: QaBeat[] = [];
  const consoleMessages: ConsoleRecord[] = [];
  const consoleErrors: string[] = [];
  let movementMethod: MovementMethod = "none";

  page.on("console", (message) => {
    const location = message.location();
    const record: ConsoleRecord = {
      type: message.type(),
      text: message.text(),
      location: location.url ? `${location.url}:${location.lineNumber}` : "",
    };
    consoleMessages.push(record);
    if (record.type === "error") consoleErrors.push(`console: ${record.text}`);
  });
  page.on("pageerror", (error) => {
    const text = errorMessage(error);
    consoleMessages.push({ type: "pageerror", text, location: "" });
    consoleErrors.push(`pageerror: ${text}`);
  });
  page.on("requestfailed", (request) => {
    consoleMessages.push({
      type: "requestfailed",
      text: `${request.method()} ${request.url()} ${
        request.failure()?.errorText ?? "failed"
      }`,
      location: "",
    });
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path !== "/generate" && path !== "/edit") return;
    const status = response.status();
    consoleMessages.push({ type: "response", text: `${status} ${path}`, location: "" });
    log(`response ${status} ${path}`);
    if (status < 200 || status >= 300) {
      void response
        .text()
        .then((body) => {
          consoleMessages.push({
            type: "response-body",
            text: body.replace(/\s+/g, " ").slice(0, 500),
            location: "",
          });
        })
        .catch(() => undefined);
    }
  });

  const record = (beat: QaBeat): void => {
    beats.push(beat);
    log(`${beat.ok ? "ok" : "FAIL"} ${beat.beat}: ${beat.detail}`);
  };

  const runBeat = async (
    name: string,
    screenshot: string | undefined,
    fn: () => Promise<string>
  ): Promise<boolean> => {
    try {
      const detail = await fn();
      record({ beat: name, ok: true, detail, screenshot });
      return true;
    } catch (error) {
      const detail = errorMessage(error);
      const failureShot = join(outDir, `failure-${name}.png`);
      try {
        await page.screenshot({ path: failureShot });
      } catch {
        // Page may already be closed; the report path is optional.
      }
      record({ beat: name, ok: false, detail, screenshot: failureShot });
      return false;
    }
  };

  await page.setViewportSize(VIEWPORT);
  await page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

  // Landing smoke beat: the marketing page at `/` must serve 200, carry the
  // hero heading and link into the studio. Runs for every mode (it makes no
  // live generation call, so `--landing-only` semantics are unaffected).
  const landingSmokeOk = await runBeat(
    "landing-smoke",
    join(outDir, "00-landing.png"),
    async () => {
      const response = await page.goto(landingPageUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      expectCondition(response !== null, `no document response from ${landingPageUrl}`);
      const status = response.status();
      expectCondition(status === 200, `${landingPageUrl} returned HTTP ${status}`);
      const heading = ((await page.locator("h1").first().textContent()) ?? "")
        .replace(/\s+/g, " ")
        .trim();
      expectCondition(
        heading.includes(LANDING_HERO_TEXT),
        `hero heading text missing (got "${heading}")`
      );
      const studioLinks = await page.locator('a[href*="app.html"]').count();
      expectCondition(studioLinks > 0, "landing page has no link to app.html");
      await page.screenshot({ path: join(outDir, "00-landing.png") });
      return `GET / -> ${status}; hero="${heading}"; link(s) to app.html=${studioLinks}`;
    }
  );

  log(`navigating to ${studioUrl}`);
  const landingOk = await runBeat("landing", join(outDir, "01-landing.png"), async () => {
    await page.goto(studioUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await page.waitForSelector("#stage", { state: "visible" });
    await page.waitForSelector("#game", { state: "attached" });
    await page.waitForSelector("#chat-input", { state: "visible" });
    await page.waitForSelector("#chat-submit", { state: "visible" });
    await page.waitForSelector("#hud", { state: "visible" });
    await page.waitForSelector("#badge", { state: "visible" });
    await page.waitForFunction(
      () => {
        const badge = document.querySelector("#badge");
        const controls = document.querySelector("#controls")?.textContent ?? "";
        return (
          badge?.getAttribute("data-validated") === "false" &&
          controls.includes("WASD move")
        );
      },
      undefined,
      { timeout: NAVIGATION_TIMEOUT_MS }
    );
    const controls = ((await page.locator("#controls").textContent()) ?? "").trim();
    expectCondition(
      controls.includes("WASD move"),
      `controls hint missing (got "${controls}")`
    );
    const badge = ((await page.locator("#badge").textContent()) ?? "").trim();
    expectCondition(badge === "unvalidated", `expected unvalidated badge, got "${badge}"`);
    const colors = pngStats(await canvasScreenshot(page)).distinct;
    expectCondition(colors >= MIN_CANVAS_COLORS, `flat canvas (${colors} colors)`);
    await page.screenshot({ path: join(outDir, "01-landing.png") });
    return `loaded; badge="unvalidated"; controls="${controls}"; canvas colors=${colors}`;
  });

  let generatedOk = false;
  if (landingOk && !options.landingOnly && !options.kitsOnly) {
    generatedOk = await runBeat("generated", join(outDir, "02-generated.png"), async () => {
      const errorsBefore = await chatErrorCount(page);
      await page.fill("#chat-input", QA_PROMPT);
      await page.click("#chat-submit");
      log(`submitted generate prompt (waiting up to ${RENDER_TIMEOUT_MS / 1000}s)`);
      const started = Date.now();
      await waitForGenerateOutcome(page, errorsBefore, RENDER_TIMEOUT_MS);
      const failure = await newChatError(page, errorsBefore);
      expectCondition(failure === null, `generation failed: ${failure}`);
      await waitForObjective(page, RENDER_TIMEOUT_MS);
      const colors = pngStats(await canvasScreenshot(page)).distinct;
      expectCondition(colors >= MIN_CANVAS_COLORS, `flat canvas (${colors} colors)`);
      const badge = ((await page.locator("#badge").textContent()) ?? "").trim();
      const objectives = await page.locator("#hud ul.objectives li").allTextContents();
      await page.screenshot({ path: join(outDir, "02-generated.png") });
      return `validated after ${Date.now() - started}ms; badge="${badge}"; objectives=${JSON.stringify(
        objectives.map((text) => text.trim())
      )}; canvas colors=${colors}`;
    });
  } else if (!options.landingOnly && !options.kitsOnly) {
    record({
      beat: "generated",
      ok: false,
      detail: "skipped: landing beat failed",
      screenshot: join(outDir, "02-generated.png"),
    });
  }

  let movedOk = false;
  if (generatedOk) {
    movedOk = await runBeat("playing", join(outDir, "03-playing.png"), async () => {
      const hookAvailable = await hasDebugHook(page);
      const before = hookAvailable ? await readPlayerPosition(page) : null;
      const beforeCanvas = await canvasScreenshot(page);
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      });
      await page.keyboard.down("w");
      await page.waitForTimeout(MOVE_HOLD_MS);
      await page.screenshot({ path: join(outDir, "03-playing.png") });
      await page.keyboard.up("w");
      await page.waitForTimeout(150);

      if (hookAvailable) {
        movementMethod = "debug-hook";
        const after = await readPlayerPosition(page);
        expectCondition(before !== null, "debug hook did not expose the player position");
        expectCondition(after !== null, "debug hook lost the player position");
        const distance = Math.hypot(after[0] - before[0], after[2] - before[2]);
        expectCondition(
          distance > MIN_MOVE_DISTANCE,
          `player did not move while holding w (moved ${distance.toFixed(3)})`
        );
        return `held w for ${MOVE_HOLD_MS}ms; moved ${distance.toFixed(3)} units via __gameDebug`;
      }

      movementMethod = "pixel-diff";
      const afterCanvas = await canvasScreenshot(page);
      const changed = beforeCanvas.compare(afterCanvas) !== 0;
      expectCondition(changed, "canvas did not change while holding w");
      return `held w for ${MOVE_HOLD_MS}ms; canvas changed (pixel-diff; no __gameDebug in this build)`;
    });
  } else if (!options.landingOnly && !options.kitsOnly) {
    record({
      beat: "playing",
      ok: false,
      detail: "skipped: generation beat failed",
      screenshot: join(outDir, "03-playing.png"),
    });
  }

  let editedOk = false;
  if (generatedOk) {
    editedOk = await runBeat("edited", join(outDir, "04-edited.png"), async () => {
      const errorsBefore = await chatErrorCount(page);
      await page.fill("#chat-input", QA_EDIT_PROMPT);
      await page.click("#chat-submit");
      log(`submitted edit prompt (waiting up to ${RENDER_TIMEOUT_MS / 1000}s)`);
      const started = Date.now();
      await waitForEditOutcome(page, errorsBefore, RENDER_TIMEOUT_MS);
      const failure = await newChatError(page, errorsBefore);
      expectCondition(failure === null, `edit failed: ${failure}`);
      await waitForValidated(page, RENDER_TIMEOUT_MS);
      await page.screenshot({ path: join(outDir, "04-edited.png") });
      const logText = ((await page.locator("#chat-log").textContent()) ?? "").trim();
      return `edit applied after ${Date.now() - started}ms; chat log: "${logText.replace(
        /\s+/g,
        " "
      )}"`;
    });
  } else if (!options.landingOnly && !options.kitsOnly) {
    record({
      beat: "edited",
      ok: false,
      detail: "skipped: generation beat failed",
      screenshot: join(outDir, "04-edited.png"),
    });
  }

  const consoleLogPath = join(outDir, "console.log");

  let exploredOk = false;
  if (options.explore && !options.landingOnly && !options.kitsOnly && landingOk) {
    exploredOk = await runBeat(
      "explored",
      join(outDir, "05-explore.png"),
      async () => {
        const consoleErrorsBefore = consoleErrors.length;
        // Fresh load so the prompt takes the /generate path (a loaded game
        // would route the same text to /edit and stay a goal game).
        await page.goto(studioUrl, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        await page.waitForFunction(
          () => document.querySelector("#badge")?.getAttribute("data-validated") === "false",
          undefined,
          { timeout: NAVIGATION_TIMEOUT_MS }
        );
        const errorsBefore = await chatErrorCount(page);
        await page.fill("#chat-input", QA_EXPLORE_PROMPT);
        await page.click("#chat-submit");
        log(`submitted explore prompt (waiting up to ${RENDER_TIMEOUT_MS / 1000}s)`);
        const started = Date.now();
        await waitForGenerateOutcome(page, errorsBefore, RENDER_TIMEOUT_MS);
        const failure = await newChatError(page, errorsBefore);
        expectCondition(failure === null, `explore generation failed: ${failure}`);
        await waitForValidated(page, RENDER_TIMEOUT_MS);
        await page.waitForFunction(
          () =>
            (document.querySelector("#hud")?.textContent ?? "").includes("Explore freely"),
          undefined,
          { timeout: RENDER_TIMEOUT_MS }
        );
        const hudText = ((await page.locator("#hud").textContent()) ?? "")
          .replace(/\s+/g, " ")
          .trim();
        expectCondition(
          hudText.includes("Explore freely"),
          `explore hint missing from HUD (got "${hudText}")`
        );
        const colors = pngStats(await canvasScreenshot(page)).distinct;
        expectCondition(colors >= MIN_CANVAS_COLORS, `flat canvas (${colors} colors)`);
        await page.screenshot({ path: join(outDir, "05-explore.png") });
        const newConsoleErrors = consoleErrors.slice(consoleErrorsBefore);
        expectCondition(
          newConsoleErrors.length === 0,
          `console errors during explore beat: ${newConsoleErrors.join(" | ")}`
        );
        return `explore scene validated after ${Date.now() - started}ms; HUD="${hudText}"; canvas colors=${colors}; new console errors=0`;
      }
    );
  } else if (options.explore && !options.landingOnly && !options.kitsOnly) {
    record({
      beat: "explored",
      ok: false,
      detail: "skipped: landing beat failed",
      screenshot: join(outDir, "05-explore.png"),
    });
  }

  // Kit beats (six to eight): each generates one canonical kit prompt on a
  // fresh load and asserts the mode-specific interaction, not a playthrough.
  let inspectedOk = false;
  if (options.kits && !options.landingOnly && landingOk) {
    inspectedOk = await runBeat(
      "inspect",
      join(outDir, "06-inspect.png"),
      async () => {
        const consoleErrorsBefore = consoleErrors.length;
        const started = await generateFromFreshLoad(page, studioUrl, QA_INSPECT_PROMPT);
        await page.waitForFunction(
          () =>
            (document.querySelector("#controls")?.textContent ?? "").includes(
              "Click parts for info"
            ),
          undefined,
          { timeout: RENDER_TIMEOUT_MS }
        );
        const hint = ((await page.locator("#controls").textContent()) ?? "")
          .replace(/\s+/g, " ")
          .trim();
        expectCondition(
          hint.includes("Click parts for info"),
          `inspect hint missing (got "${hint}")`
        );
        const colors = pngStats(await canvasScreenshot(page)).distinct;
        expectCondition(colors >= MIN_CANVAS_COLORS, `flat canvas (${colors} colors)`);

        // Picking a known chip needs model-space coordinates; hovering sweeps
        // instead: move across the canvas center until the cursor turns into
        // the pointer that only a hovered entity sets.
        const box = await page.locator("#game").boundingBox();
        expectCondition(box !== null, "canvas has no bounding box");
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        let hoverPoint: string | null = null;
        for (const offsetY of [0, -60, 60, -120, 120, -180, 180]) {
          for (let offsetX = -220; offsetX <= 220; offsetX += 40) {
            await page.mouse.move(centerX + offsetX, centerY + offsetY);
            await page.waitForTimeout(30);
            const cursor = await page.evaluate(
              () =>
                document.querySelector<HTMLCanvasElement>("#game")?.style.cursor ?? ""
            );
            if (cursor === "pointer") {
              hoverPoint = `${offsetX},${offsetY}`;
              break;
            }
          }
          if (hoverPoint !== null) break;
        }
        expectCondition(
          hoverPoint !== null,
          "hover never picked an entity (cursor never became pointer)"
        );

        await page.screenshot({ path: join(outDir, "06-inspect.png") });
        const newConsoleErrors = consoleErrors.slice(consoleErrorsBefore);
        expectCondition(
          newConsoleErrors.length === 0,
          `console errors during inspect beat: ${newConsoleErrors.join(" | ")}`
        );
        return `inspect scene validated after ${started}ms; hint="${hint}"; canvas colors=${colors}; hover pointer at center offset (${hoverPoint}); new console errors=0`;
      }
    );
  } else if (options.kits && !options.landingOnly) {
    record({
      beat: "inspect",
      ok: false,
      detail: "skipped: landing beat failed",
      screenshot: join(outDir, "06-inspect.png"),
    });
  }

  let walkedOk = false;
  if (options.kits && !options.landingOnly && landingOk) {
    walkedOk = await runBeat(
      "walkthrough",
      join(outDir, "07-walkthrough.png"),
      async () => {
        const consoleErrorsBefore = consoleErrors.length;
        const started = await generateFromFreshLoad(
          page,
          studioUrl,
          QA_WALKTHROUGH_PROMPT
        );
        await page.waitForFunction(
          () => {
            const crosshair = document.querySelector<HTMLElement>("#crosshair");
            const controls = document.querySelector("#controls")?.textContent ?? "";
            return (
              crosshair !== null && !crosshair.hidden && controls.includes("E interact")
            );
          },
          undefined,
          { timeout: RENDER_TIMEOUT_MS }
        );
        const hint = ((await page.locator("#controls").textContent()) ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const crosshairHidden = await page.evaluate(
          () => document.querySelector("#crosshair")?.hasAttribute("hidden") ?? true
        );
        expectCondition(!crosshairHidden, "crosshair is hidden in walkthrough mode");
        expectCondition(hint.includes("E interact"), `walkthrough hint missing (got "${hint}")`);

        await blurActiveElement(page);
        const before = await readInteractSnapshot(page);
        expectCondition(before !== null, "__gameDebug snapshot unavailable before interact");
        const targets = new Set(before.targets);

        await pressInteract(page);
        let observation = await waitForInteractChange(
          page,
          before,
          targets,
          INTERACT_SETTLE_MS
        );
        let { after, changes, reacted } = observation;
        expectCondition(after !== null, "__gameDebug snapshot unavailable after interact");
        let approach = "interactable already in range";

        if (reacted.length === 0) {
          // The interactable may spawn out of range: walk toward it using the
          // fixed yaw-0 basis, then press E again.
          const distance = await walkTowardNearestInteractable(page, WALK_BUDGET_MS);
          approach =
            distance === null
              ? "no interactable exposed"
              : `walked to ${distance.toFixed(2)} units`;
          await pressInteract(page);
          observation = await waitForInteractChange(
            page,
            before,
            targets,
            INTERACT_SETTLE_MS
          );
          after = observation.after;
          changes = observation.changes;
          reacted = observation.reacted;
          expectCondition(after !== null, "__gameDebug snapshot unavailable after approach");
        }

        const relevant = targets.size > 0 ? reacted : changes;
        const changesText = changes
          .map((change) => `${change.id}(${change.reason})`)
          .join(", ");
        expectCondition(
          relevant.length > 0,
          `pressing E did not change any interact-owned entity (${approach}; changes: ${
            changesText || "none"
          })`
        );

        await page.screenshot({ path: join(outDir, "07-walkthrough.png") });
        const newConsoleErrors = consoleErrors.slice(consoleErrorsBefore);
        expectCondition(
          newConsoleErrors.length === 0,
          `console errors during walkthrough beat: ${newConsoleErrors.join(" | ")}`
        );
        const reactedText = relevant
          .map((change) => `${change.id}(${change.reason})`)
          .join(", ");
        return `walkthrough validated after ${started}ms; hint="${hint}"; crosshair visible; E reacted: ${reactedText}; ${approach}; new console errors=0`;
      }
    );
  } else if (options.kits && !options.landingOnly) {
    record({
      beat: "walkthrough",
      ok: false,
      detail: "skipped: landing beat failed",
      screenshot: join(outDir, "07-walkthrough.png"),
    });
  }

  let droveOk = false;
  if (options.kits && !options.landingOnly && landingOk) {
    droveOk = await runBeat("drive", join(outDir, "08-race.png"), async () => {
      const consoleErrorsBefore = consoleErrors.length;
      const started = await generateFromFreshLoad(page, studioUrl, QA_RACE_PROMPT);
      await page.waitForFunction(
        () => {
          const hud = document.querySelector<HTMLElement>("#drive-hud");
          return hud !== null && !hud.hidden;
        },
        undefined,
        { timeout: RENDER_TIMEOUT_MS }
      );

      await blurActiveElement(page);
      await page.keyboard.down("w");
      await page.waitForTimeout(DRIVE_HOLD_MS);
      const speed = await readPlayerSpeed(page);
      const speedText = ((await page.locator("#drive-speed").textContent()) ?? "").trim();
      const lapText = ((await page.locator("#drive-lap").textContent()) ?? "").trim();
      await page.screenshot({ path: join(outDir, "08-race.png") });
      await page.keyboard.up("w");

      expectCondition(speed !== null, "__gameDebug did not expose the player speed");
      expectCondition(
        speed > MIN_DRIVE_SPEED,
        `player speed ${speed.toFixed(2)} did not exceed ${MIN_DRIVE_SPEED} after ${DRIVE_HOLD_MS}ms of throttle`
      );
      const speedMatch = /^(\d+)\s*km\/h$/.exec(speedText);
      expectCondition(speedMatch !== null, `drive HUD speed missing (got "${speedText}")`);
      expectCondition(
        Number(speedMatch[1]) > 0,
        `drive HUD speed number not positive (got "${speedText}")`
      );

      const newConsoleErrors = consoleErrors.slice(consoleErrorsBefore);
      expectCondition(
        newConsoleErrors.length === 0,
        `console errors during drive beat: ${newConsoleErrors.join(" | ")}`
      );
      return `race scene validated after ${started}ms; held w ${DRIVE_HOLD_MS}ms; speed=${speed.toFixed(
        2
      )} (${speedText}, ${lapText}); new console errors=0`;
    });
  } else if (options.kits && !options.landingOnly) {
    record({
      beat: "drive",
      ok: false,
      detail: "skipped: landing beat failed",
      screenshot: join(outDir, "08-race.png"),
    });
  }

  const consoleLines = consoleMessages.map(
    (message) => `${message.type}\t${message.text}${message.location ? `\t${message.location}` : ""}`
  );
  writeFileSync(consoleLogPath, `${consoleLines.join("\n")}\n`, "utf8");

  const failedBeats = beats.filter((beat) => !beat.ok);
  const exploreOk = !options.explore || options.landingOnly || options.kitsOnly || exploredOk;
  const kitsOk =
    !options.kits ||
    options.landingOnly ||
    (inspectedOk && walkedOk && droveOk);
  const ok =
    landingSmokeOk &&
    landingOk &&
    (options.landingOnly || options.kitsOnly || (generatedOk && movedOk && editedOk)) &&
    exploreOk &&
    kitsOk &&
    consoleErrors.length === 0;

  const result: QaResult = {
    ok,
    url: studioUrl,
    beats,
    consoleErrors,
    movementMethod,
    consoleLogPath,
  };

  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  log(
    `console errors: ${consoleErrors.length}${
      consoleErrors.length > 0 ? ` (${consoleErrors.join(" | ")})` : ""
    }`
  );
  for (const beat of failedBeats) log(`failed beat ${beat.beat}: ${beat.detail}`);
  console.log(
    `${ok ? "PASS" : "FAIL"} qa-browser ${studioUrl} beats=${
      beats.filter((beat) => beat.ok).length
    }/${beats.length} consoleErrors=${consoleErrors.length} movement=${movementMethod}`
  );

  return result;
}

interface CliOptions {
  url?: string;
  outDir?: string;
  landingOnly: boolean;
  explore: boolean;
  kits: boolean;
  kitsOnly: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { landingOnly: false, explore: false, kits: false, kitsOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--landing-only") {
      options.landingOnly = true;
    } else if (arg === "--explore") {
      options.explore = true;
    } else if (arg === "--kits") {
      options.kits = true;
    } else if (arg === "--kits-only") {
      options.kitsOnly = true;
      options.kits = true;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--out requires a directory");
      options.outDir = value;
      i += 1;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      if (options.url !== undefined) throw new Error(`unexpected argument: ${arg}`);
      options.url = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (!options.url) {
      console.error(
        "usage: npx tsx scripts/qa-browser.ts <url> [--out <dir>] [--landing-only] [--explore] [--kits] [--kits-only]\n" +
          "       <url> may be a host root (studio defaults to /app.html) or a full studio page URL"
      );
      process.exitCode = 2;
      return;
    }

    const executablePath = resolveChromiumExecutable();
    log(`chromium executable: ${executablePath ?? "playwright default"}`);
    const browser = await launchQaChromium();
    try {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const result = await runQa(page, {
        url: options.url,
        outDir: options.outDir,
        landingOnly: options.landingOnly,
        explore: options.explore,
        kits: options.kits,
        kitsOnly: options.kitsOnly,
      });
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      await browser.close();
    }
  })().catch((error: unknown) => {
    console.error(`qa-browser crashed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
