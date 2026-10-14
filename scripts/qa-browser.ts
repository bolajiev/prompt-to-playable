import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright";
import { resolveChromiumExecutable } from "./playwright-env.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = join(ROOT, "artifacts", "qa");

export const QA_PROMPT =
  "a small room where I collect 3 glowing crystals while avoiding one guard";
export const QA_EDIT_PROMPT = "add a second guard";
export const QA_EXPLORE_PROMPT = "a quiet forest clearing with a campfire at dusk";

const VIEWPORT = { width: 1280, height: 720 };
const NAVIGATION_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 90_000;
const MOVE_HOLD_MS = 1_000;
const MIN_MOVE_DISTANCE = 0.05;
const MIN_CANVAS_COLORS = 16;

export interface QaOptions {
  url: string;
  outDir?: string;
  /** Stop after the landing beat (browser/element smoke check, no live calls). */
  landingOnly?: boolean;
  /**
   * Extra fifth beat: reload, generate an explore scene from QA_EXPLORE_PROMPT,
   * then assert the free-roam HUD hint, a lit canvas and zero new console errors.
   */
  explore?: boolean;
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

export async function runQa(page: Page, options: QaOptions): Promise<QaResult> {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  mkdirSync(outDir, { recursive: true });

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

  log(`navigating to ${options.url}`);
  const landingOk = await runBeat("landing", join(outDir, "01-landing.png"), async () => {
    await page.goto(options.url, {
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
  if (landingOk && !options.landingOnly) {
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
  } else if (!options.landingOnly) {
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
  } else if (!options.landingOnly) {
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
  } else if (!options.landingOnly) {
    record({
      beat: "edited",
      ok: false,
      detail: "skipped: generation beat failed",
      screenshot: join(outDir, "04-edited.png"),
    });
  }

  const consoleLogPath = join(outDir, "console.log");

  let exploredOk = false;
  if (options.explore && !options.landingOnly && landingOk) {
    exploredOk = await runBeat(
      "explored",
      join(outDir, "05-explore.png"),
      async () => {
        const consoleErrorsBefore = consoleErrors.length;
        // Fresh load so the prompt takes the /generate path (a loaded game
        // would route the same text to /edit and stay a goal game).
        await page.goto(options.url, {
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
  } else if (options.explore && !options.landingOnly) {
    record({
      beat: "explored",
      ok: false,
      detail: "skipped: landing beat failed",
      screenshot: join(outDir, "05-explore.png"),
    });
  }

  const consoleLines = consoleMessages.map(
    (message) => `${message.type}\t${message.text}${message.location ? `\t${message.location}` : ""}`
  );
  writeFileSync(consoleLogPath, `${consoleLines.join("\n")}\n`, "utf8");

  const failedBeats = beats.filter((beat) => !beat.ok);
  const exploreOk = !options.explore || options.landingOnly || exploredOk;
  const ok =
    landingOk &&
    (options.landingOnly || (generatedOk && movedOk && editedOk)) &&
    exploreOk &&
    consoleErrors.length === 0;

  const result: QaResult = {
    ok,
    url: options.url,
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
    `${ok ? "PASS" : "FAIL"} qa-browser ${options.url} beats=${
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
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { landingOnly: false, explore: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--landing-only") {
      options.landingOnly = true;
    } else if (arg === "--explore") {
      options.explore = true;
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
        "usage: npx tsx scripts/qa-browser.ts <url> [--out <dir>] [--landing-only] [--explore]"
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
