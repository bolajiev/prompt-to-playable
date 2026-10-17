/**
 * Captures the landing-page gallery from live generations.
 *
 * Boots the production server (`server/dist/index.js`, PORT 3310 by default,
 * override with the PORT env var) which serves the built studio
 * (`apps/web/dist`), drives headless Chromium with software WebGL (same launch
 * flags as `qa-browser`), generates one scene per shot and writes JPEG q85
 * files to `apps/web/public/shots/`.
 *
 * Usage: `npx tsx scripts/capture-shots.ts [--only world,machine]`
 *
 * Each generation is a live gateway call and can take a couple of minutes;
 * every shot gets exactly one retry on failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { resolveChromiumExecutable } from "./playwright-env.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(ROOT, "apps", "web", "public", "shots");
const PORT = Number(process.env.PORT ?? 3310);
const BASE_URL = `http://localhost:${PORT}`;

const VIEWPORT = { width: 1280, height: 800 };
const DEVICE_SCALE_FACTOR = 1.5;
const NAVIGATION_TIMEOUT_MS = 60_000;
/** One live generation may take minutes on the shared gateway. */
const RENDER_TIMEOUT_MS = 290_000;
const MAX_SHOT_BYTES = 400 * 1024;
const JPEG_QUALITIES = [85, 70, 55];
/** How long SIGTERM gets before the server child is SIGKILLed. */
const SERVER_STOP_GRACE_MS = 2_000;

/** Fixed yaw-0 camera-relative input basis (see `forwardFromYaw(0)`). */
const YAW_ZERO_FORWARD: readonly [number, number] = [
  -0.4472135954999579, -0.8944271909999159,
];
/** Sine of 22.5 degrees: axis threshold for choosing a WASD key. */
const AXIS_KEY_THRESHOLD = 0.383;
/** Orbit rig yaw at rest: `atan2(DEFAULT_CAMERA_OFFSET.x, z)` = atan2(6, 12). */
const DEFAULT_AZIMUTH = Math.atan2(6, 12);
/** Radians of orbit yaw per pixel of horizontal drag (web `YAW_SENSITIVITY`). */
const YAW_SENSITIVITY = 0.006;

type ShotKind =
  | "inspect"
  | "walkthrough"
  | "drive"
  | "explore"
  | "game"
  | "world"
  | "machine";

interface ShotSpec {
  name: string;
  kind: ShotKind;
  prompt: string;
}

/** The landing gallery shots; order is capture order (write order). */
const SHOTS: readonly ShotSpec[] = [
  // The hero image: the open world with its live controls panel in frame.
  {
    name: "world",
    kind: "world",
    prompt: "an open world island with trees, animals and buttons to spawn things",
  },
  // The machine kit with its joint sliders visible next to the five-axis arm.
  {
    name: "machine",
    kind: "machine",
    prompt: "a robotic arm with joint sliders I can control",
  },
  { name: "pcb", kind: "inspect", prompt: "a 3D PCB I can click and inspect" },
  { name: "house", kind: "walkthrough", prompt: "a house I can walk through" },
  { name: "race", kind: "drive", prompt: "a car racing game" },
  {
    name: "forest",
    kind: "explore",
    prompt: "a quiet forest clearing with a campfire at dusk",
  },
  {
    name: "game",
    kind: "game",
    prompt:
      "a room where I collect 3 glowing crystals while avoiding one guard",
  },
];

function log(message: string): void {
  console.log(`[shots] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expectCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ */
/* Server                                                               */
/* ------------------------------------------------------------------ */

interface ServerHandle {
  child: ChildProcess;
  /** Set by the child's `error` listener (e.g. missing `server/dist`). */
  spawnError: Error | null;
}

function startServer(): ServerHandle {
  const child = spawn(
    process.execPath,
    [join(ROOT, "server", "dist", "index.js")],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const handle: ServerHandle = { child, spawnError: null };
  // Without this listener a missing dist emits an unhandled 'error' event and
  // crashes the script instead of reaching the health-poll diagnostic.
  child.on("error", (error: Error) => {
    handle.spawnError = error;
  });
  child.stdout?.on("data", (data: Buffer) => process.stdout.write(`[server] ${data}`));
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(`[server] ${data}`));
  return handle;
}

async function waitForServer(handle: ServerHandle, timeoutMs: number): Promise<void> {
  const { child } = handle;
  const started = Date.now();
  let lastError = "no response";
  while (Date.now() - started < timeoutMs) {
    if (handle.spawnError !== null) {
      throw new Error(
        `server failed to start (${errorMessage(handle.spawnError)}); ` +
          `last /healthz poll: ${lastError}`
      );
    }
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`server did not become healthy (${lastError})`);
}

/** SIGTERM, wait out a short grace period, then SIGKILL; resolves on exit. */
async function stopServer(handle: ServerHandle | null): Promise<void> {
  if (handle === null) return;
  const { child } = handle;
  if (child.pid === undefined || child.exitCode !== null) return;

  const exited = new Promise<void>((done) => {
    if (child.exitCode !== null) {
      done();
      return;
    }
    child.once("exit", () => done());
  });
  child.kill("SIGTERM");
  let graceTimer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((done) => {
      graceTimer = setTimeout(() => done(true), SERVER_STOP_GRACE_MS);
      graceTimer.unref();
    }),
  ]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  if (timedOut && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

/* ------------------------------------------------------------------ */
/* Browser                                                              */
/* ------------------------------------------------------------------ */

/**
 * Headless Chromium with software WebGL. `DISPLAY` is dropped because a stale
 * X display makes ANGLE try XCB and fail instead of using SwiftShader.
 */
async function launchBrowser(): Promise<Browser> {
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

/* ------------------------------------------------------------------ */
/* Generation                                                           */
/* ------------------------------------------------------------------ */

/**
 * Opens the studio with `?prompt=` (exercising the landing deep link, which
 * prefills and auto-submits) and waits for the validated badge. Throws with
 * the chat error text when the generation fails.
 */
async function generateFromPrompt(page: Page, prompt: string): Promise<void> {
  const url = `${BASE_URL}/app.html?prompt=${encodeURIComponent(prompt)}`;
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await page.waitForSelector("#chat-input", { timeout: NAVIGATION_TIMEOUT_MS });
  await page.waitForFunction(
    () => {
      const badge = document.querySelector("#badge");
      const errors = document.querySelectorAll("#chat-log .line.error").length;
      return badge?.getAttribute("data-validated") === "true" || errors > 0;
    },
    undefined,
    { timeout: RENDER_TIMEOUT_MS }
  );
  const failure = await page.locator("#chat-log .line.error").count();
  if (failure > 0) {
    const text = await page.locator("#chat-log .line.error").last().innerText();
    throw new Error(`generation failed: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  await page.waitForFunction(
    () => document.querySelector("#badge")?.getAttribute("data-validated") === "true",
    undefined,
    { timeout: RENDER_TIMEOUT_MS }
  );
}

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

/* ------------------------------------------------------------------ */
/* Kit actions                                                          */
/* ------------------------------------------------------------------ */

/**
 * Inspect: the board's click rules sit on components, whose screen positions
 * depend on the generated layout, so first sweep the pointer to collect points
 * the app itself reports as hover-pickable (cursor turns into `pointer`), then
 * click them until a panel opens. The first click may also trigger the camera
 * focus, so the caller settles before capturing.
 */
async function openInspectPanel(page: Page): Promise<number> {
  await page.waitForFunction(
    () => (document.querySelector("#controls")?.textContent ?? "").includes("Click parts"),
    undefined,
    { timeout: RENDER_TIMEOUT_MS }
  );
  const canvas = page.locator("#game");
  const box = await canvas.boundingBox();
  expectCondition(box !== null, "canvas has no bounding box");

  const candidates: Array<{ x: number; y: number }> = [];
  for (let fy = 0.12; fy <= 0.88; fy += 0.06) {
    for (let fx = 0.06; fx <= 0.94; fx += 0.055) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(15);
      const cursor = await page.evaluate(
        () => document.querySelector<HTMLCanvasElement>("#game")?.style.cursor ?? ""
      );
      if (cursor === "pointer") {
        candidates.push({ x: box.x + box.width * fx, y: box.y + box.height * fy });
      }
    }
  }
  expectCondition(candidates.length > 0, "hover never picked an entity on the board");
  log(`inspect: ${candidates.length} pickable point(s) found; clicking`);

  // Center-first ordering: the assembly center is the most likely component.
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x - (box.x + box.width / 2), a.y - (box.y + box.height / 2)) -
      Math.hypot(b.x - (box.x + box.width / 2), b.y - (box.y + box.height / 2))
  );

  let clicks = 0;
  for (const point of candidates.slice(0, 24)) {
    clicks += 1;
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(240);
    if ((await page.locator("#panels .panel-card").count()) > 0) {
      await page.waitForTimeout(1_200);
      return clicks;
    }
  }
  throw new Error(`no click rule fired on the board (${clicks} clicks)`);
}

interface InteractTarget {
  id: string;
  position: [number, number, number];
  range: number;
}

interface PlayerSnapshot {
  position: [number, number, number];
  interactables: InteractTarget[];
}

/** Reads player position + interactables from the QA debug hook. */
async function readPlayerSnapshot(page: Page): Promise<PlayerSnapshot | null> {
  return page.evaluate(() => {
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
      entityRuntime?: Record<string, { position?: number[]; visible?: boolean }>;
    };
    const player = state.entities?.find((entity) => entity.kind === "player");
    if (!player?.id) return null;
    const position = state.entityRuntime?.[player.id]?.position;
    if (!position || position.length < 3) return null;

    const interactables: Array<{
      id: string;
      position: [number, number, number];
      range: number;
    }> = [];
    for (const entity of state.entities ?? []) {
      if (entity.id === undefined || entity.id === player.id) continue;
      const runtime = state.entityRuntime?.[entity.id];
      if (runtime?.visible === false) continue;
      const tags = entity.tags ?? [];
      if (entity.kind !== "interactable" && !tags.includes("interactable")) continue;
      const pos = runtime?.position;
      if (!pos || pos.length < 3) continue;
      interactables.push({
        id: entity.id,
        position: [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0],
        range:
          typeof entity.props?.interactRange === "number"
            ? entity.props.interactRange
            : 2.5,
      });
    }
    return {
      position: [position[0] ?? 0, position[1] ?? 0, position[2] ?? 0],
      interactables,
    };
  });
}

/** WASD keys that walk the player toward `target` on the yaw-0 input basis. */
function keysTowards(
  player: readonly [number, number, number],
  target: readonly [number, number, number]
): string[] {
  const dx = target[0] - player[0];
  const dz = target[2] - player[2];
  const horizontal = Math.hypot(dx, dz) || 1;
  const [fx, fz] = YAW_ZERO_FORWARD;
  const throttle = (dx / horizontal) * fx + (dz / horizontal) * fz;
  const strafe = (dx / horizontal) * -fz + (dz / horizontal) * fx;
  const keys: string[] = [];
  if (throttle > AXIS_KEY_THRESHOLD) keys.push("w");
  else if (throttle < -AXIS_KEY_THRESHOLD) keys.push("s");
  if (strafe > AXIS_KEY_THRESHOLD) keys.push("d");
  else if (strafe < -AXIS_KEY_THRESHOLD) keys.push("a");
  if (keys.length === 0) keys.push("w");
  return keys;
}

function nearestInteractable(
  snapshot: PlayerSnapshot
): InteractTarget | null {
  let best: InteractTarget | null = null;
  let bestDistance = Infinity;
  for (const target of snapshot.interactables) {
    const distance = Math.hypot(
      target.position[0] - snapshot.position[0],
      target.position[1] - snapshot.position[1],
      target.position[2] - snapshot.position[2]
    );
    if (distance < bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Walkthrough: walk to the nearest interactable (the door), open it, then keep
 * walking along the same approach direction so the shot lands inside.
 */
async function walkInsideHouse(page: Page): Promise<string> {
  await page.waitForFunction(
    () => {
      const crosshair = document.querySelector<HTMLElement>("#crosshair");
      const controls = document.querySelector("#controls")?.textContent ?? "";
      return crosshair !== null && !crosshair.hidden && controls.includes("E interact");
    },
    undefined,
    { timeout: RENDER_TIMEOUT_MS }
  );
  await blurActiveElement(page);

  const initial = await readPlayerSnapshot(page);
  expectCondition(initial !== null, "debug hook unavailable");
  const door = nearestInteractable(initial);
  expectCondition(door !== null, "no interactable entity found");

  const started = Date.now();
  let lastKeys: string[] = ["w"];
  let distance = Infinity;
  while (Date.now() - started < 5_000) {
    const snapshot = await readPlayerSnapshot(page);
    if (snapshot === null) break;
    const target = nearestInteractable(snapshot) ?? door;
    distance = Math.hypot(
      target.position[0] - snapshot.position[0],
      target.position[1] - snapshot.position[1],
      target.position[2] - snapshot.position[2]
    );
    if (distance <= Math.max(0.5, target.range * 0.6)) break;
    lastKeys = keysTowards(snapshot.position, target.position);
    for (const key of lastKeys) await page.keyboard.down(key);
    await page.waitForTimeout(180);
    for (const key of lastKeys) await page.keyboard.up(key);
  }

  await page.keyboard.down("e");
  await page.waitForTimeout(120);
  await page.keyboard.up("e");
  await page.waitForTimeout(1_200);

  for (const key of lastKeys) await page.keyboard.down(key);
  await page.waitForTimeout(1_800);
  for (const key of lastKeys) await page.keyboard.up(key);
  await page.waitForTimeout(400);

  const final = await readPlayerSnapshot(page);
  const moved =
    final === null
      ? "?"
      : Math.hypot(
          final.position[0] - initial.position[0],
          final.position[2] - initial.position[2]
        ).toFixed(1);
  return `door ${door.id} at ${distance.toFixed(1)} units; walked ${moved} units`;
}

/**
 * Drive: hold throttle long enough for the chase camera to converge behind the
 * moving vehicle. Software WebGL runs at a low frame rate, and the camera
 * eases in per rendered frame, so this stays generous on purpose.
 */
async function driveTheCar(page: Page): Promise<string> {
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
  await page.waitForTimeout(6_000);
  const speed = ((await page.locator("#drive-speed").textContent()) ?? "").trim();
  return `throttle held 6s; HUD speed "${speed}"`;
}

/**
 * Explore/game: let the orbit camera settle. The rig eases toward its desired
 * position per rendered frame and SwiftShader renders slowly, so a couple of
 * seconds leaves it visibly mid-flight.
 */
async function settleScene(page: Page, requireObjectives: boolean): Promise<string> {
  if (requireObjectives) {
    await page.waitForFunction(
      () => document.querySelectorAll("#hud ul.objectives li").length > 0,
      undefined,
      { timeout: RENDER_TIMEOUT_MS }
    );
  }
  await page.waitForTimeout(6_000);
  return requireObjectives ? "objectives visible" : "scene settled";
}

/**
 * Make the sidebar fit the controls panel in frame: the panel sits below the
 * chat log, examples and agent trace, and the expanded trace pushes it below
 * the fold. Apply view-only framing measures (collapse the trace, then hide
 * it, then hide the example chips, then cap the chat log) until the panel is
 * fully inside the viewport. Returns which measures were needed.
 */
async function makeRoomForControls(page: Page): Promise<string> {
  const measures: string[] = [];
  const controlsVisible = (): Promise<boolean> =>
    page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>("#controls-panel");
      if (panel === null) return false;
      const rect = panel.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });

  const trace = page.locator("#agent-trace");
  if ((await trace.count()) > 0) {
    const toggleCount = await page.locator("#agent-trace .agent-trace-toggle").count();
    const toggle = toggleCount
      ? ((await page.locator("#agent-trace .agent-trace-toggle").textContent()) ?? "").trim()
      : "";
    if (toggle === "Hide") {
      await page.locator("#agent-trace .agent-trace-head").click();
      await page.waitForTimeout(250);
      measures.push("trace collapsed");
    }
  }

  if (!(await controlsVisible())) {
    const examples = page.locator("#examples");
    if ((await examples.count()) > 0) {
      await examples.evaluate((element) => {
        (element as HTMLElement).hidden = true;
      });
      await page.waitForTimeout(250);
      measures.push("example chips hidden");
    }
  }

  if (!(await controlsVisible())) {
    await page.evaluate(() => {
      const log = document.querySelector<HTMLElement>("#chat-log");
      if (log !== null) log.style.maxHeight = "120px";
    });
    await page.waitForTimeout(250);
    measures.push("chat log capped");
  }

  if (!(await controlsVisible())) {
    if ((await trace.count()) > 0) {
      await trace.evaluate((element) => {
        (element as HTMLElement).hidden = true;
      });
      await page.waitForTimeout(250);
      measures.push("trace hidden");
    }
  }

  return measures.length === 0
    ? "controls panel already in frame"
    : `${measures.join(", ")}; controls panel in frame`;
}

/**
 * World: aim the orbit camera at the densest cluster of ground props (the
 * content the generator scattered), keep the pointer held so the rig's yaw
 * cannot ease back to home, walk a little toward the cluster, and let the
 * camera position settle behind the new yaw. The pointer stays down through
 * the screenshot; the context closes right after.
 */
async function settleWorld(page: Page): Promise<string> {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector<HTMLElement>("#controls-panel");
      return (
        panel !== null &&
        !panel.hidden &&
        panel.querySelector(".control-button") !== null
      );
    },
    undefined,
    { timeout: RENDER_TIMEOUT_MS }
  );
  const room = await makeRoomForControls(page);

  const aim = await page.evaluate(() => {
    const debug = (
      window as unknown as {
        __gameDebug?: { getState: () => unknown };
      }
    ).__gameDebug;
    if (!debug) return null;
    const state = debug.getState() as {
      entities?: Array<{ id?: string; kind?: string; position?: number[] }>;
      entityRuntime?: Record<string, { position?: number[] }>;
    };
    const entities = state.entities ?? [];
    const player = entities.find((entity) => entity.kind === "player");
    const playerPos = player ? state.entityRuntime?.[player.id ?? ""]?.position : undefined;
    if (!playerPos || playerPos.length < 3) return null;

    let sumX = 0;
    let sumZ = 0;
    let count = 0;
    for (const entity of entities) {
      if (entity.id === player?.id || entity.kind !== "prop") continue;
      const position = state.entityRuntime?.[entity.id ?? ""]?.position ?? entity.position;
      if (!position || position.length < 3) continue;
      if ((position[1] ?? 0) > 12) continue; // skip sky props like a moon
      sumX += (position[0] ?? 0) - (playerPos[0] ?? 0);
      sumZ += (position[2] ?? 0) - (playerPos[2] ?? 0);
      count += 1;
    }
    if (count === 0) return null;
    return { dx: sumX / count, dz: sumZ / count, count };
  });

  let aimed = "no ground props to aim at";
  if (aim !== null && Math.hypot(aim.dx, aim.dz) > 1e-3) {
    const desiredYaw = Math.atan2(
      Math.sin(Math.atan2(-aim.dx, -aim.dz) - DEFAULT_AZIMUTH),
      Math.cos(Math.atan2(-aim.dx, -aim.dz) - DEFAULT_AZIMUTH)
    );
    const pixels = desiredYaw / YAW_SENSITIVITY;
    const box = await page.locator("#game").boundingBox();
    if (box !== null) {
      const startX = box.x + box.width / 2 - pixels / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(startX, y);
      await page.mouse.down();
      // Split into steps so pointermove deltas stay per-event sane.
      await page.mouse.move(startX + pixels, y, { steps: 12 });
      aimed = `yaw ${desiredYaw.toFixed(2)} rad toward ${aim.count} props`;
      // Walk forward a touch so the cluster reads closer; the held pointer
      // keeps the yaw, and W follows the new camera-forward basis.
      await page.keyboard.down("w");
      await page.waitForTimeout(1_600);
      await page.keyboard.up("w");
    }
  }

  await page.waitForTimeout(6_000);
  const buttons = await page.locator("#controls-panel .control-button").count();
  const title = (
    (await page.locator("#controls-panel .controls-title").textContent()) ?? ""
  ).trim();
  return `world settled (${room}; ${aimed}); "${title}" visible with ${buttons} button(s)`;
}

/**
 * Machine: same framing settle as the arm's assembly camera, with the first
 * joint slider driven to mid-range so the chain reads posed, not at rest.
 */
async function poseMachine(page: Page): Promise<string> {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector<HTMLElement>("#controls-panel");
      return (
        panel !== null &&
        !panel.hidden &&
        panel.querySelector('input[type="range"]') !== null
      );
    },
    undefined,
    { timeout: RENDER_TIMEOUT_MS }
  );
  const room = await makeRoomForControls(page);
  const slider = page.locator('#controls-panel input[type="range"]').first();
  await slider.evaluate((element) => {
    const input = element as HTMLInputElement;
    const min = Number(input.min);
    const max = Number(input.max);
    input.value = String(min + (max - min) * 0.6);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(4_000);
  const title = (
    (await page.locator("#controls-panel .controls-title").textContent()) ?? ""
  ).trim();
  return `machine settled (${room}); first joint slider driven; panel "${title}"`;
}

/* ------------------------------------------------------------------ */
/* Capture                                                              */
/* ------------------------------------------------------------------ */

async function saveShot(page: Page, name: string): Promise<number> {
  const path = join(SHOTS_DIR, `${name}.jpg`);
  let lastBytes = 0;
  for (const quality of JPEG_QUALITIES) {
    const buffer = await page.screenshot({ type: "jpeg", quality });
    lastBytes = buffer.byteLength;
    if (buffer.byteLength <= MAX_SHOT_BYTES) {
      writeFileSync(path, buffer);
      return buffer.byteLength;
    }
    log(
      `${name}: q${quality} is ${(buffer.byteLength / 1024).toFixed(0)} KB ` +
        `(> ${(MAX_SHOT_BYTES / 1024).toFixed(0)} KB), stepping down`
    );
  }
  // Never leave an oversize (or stale) file behind for a failed shot.
  rmSync(path, { force: true });
  throw new Error(
    `shot ${path} exceeds ${MAX_SHOT_BYTES} bytes even at q${JPEG_QUALITIES.at(-1)} ` +
      `(last attempt ${(lastBytes / 1024).toFixed(0)} KB)`
  );
}

async function captureShot(browser: Browser, spec: ShotSpec): Promise<number> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  try {
    const page = await context.newPage();
    await page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    log(`${spec.name}: generating "${spec.prompt}" (live call, patience)`);
    const generationStarted = Date.now();
    await generateFromPrompt(page, spec.prompt);
    log(`${spec.name}: validated in ${((Date.now() - generationStarted) / 1000).toFixed(0)}s`);

    let detail: string;
    switch (spec.kind) {
      case "inspect": {
        const clicks = await openInspectPanel(page);
        detail = `panel opened after ${clicks} canvas click(s)`;
        break;
      }
      case "walkthrough":
        detail = await walkInsideHouse(page);
        break;
      case "drive":
        detail = await driveTheCar(page);
        break;
      case "explore":
        detail = await settleScene(page, false);
        break;
      case "game":
        detail = await settleScene(page, true);
        break;
      case "world":
        detail = await settleWorld(page);
        break;
      case "machine":
        detail = await poseMachine(page);
        break;
    }

    const bytes = await saveShot(page, spec.name);
    const path = join(SHOTS_DIR, `${spec.name}.jpg`);
    expectCondition(
      bytes === statSync(path).size,
      `shot ${path} size mismatch after write`
    );
    expectCondition(bytes <= MAX_SHOT_BYTES, `shot ${path} exceeds ${MAX_SHOT_BYTES} bytes`);
    log(`${spec.name}: saved ${path} (${(bytes / 1024).toFixed(0)} KB) — ${detail}`);
    return bytes;
  } finally {
    await context.close();
  }
}

async function captureWithRetry(browser: Browser, spec: ShotSpec): Promise<number> {
  try {
    return await captureShot(browser, spec);
  } catch (error) {
    log(`${spec.name}: attempt 1 failed (${errorMessage(error)}) — retrying once`);
    return await captureShot(browser, spec);
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

function parseOnly(argv: readonly string[]): Set<string> | null {
  const index = argv.indexOf("--only");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined) throw new Error("--only requires a comma-separated list");
  return new Set(value.split(",").map((name) => name.trim()).filter(Boolean));
}

async function main(): Promise<void> {
  const only = parseOnly(process.argv.slice(2));
  const specs = SHOTS.filter((spec) => only === null || only.has(spec.name));
  expectCondition(specs.length > 0, "no shots selected");

  mkdirSync(SHOTS_DIR, { recursive: true });
  log(`chromium executable: ${resolveChromiumExecutable() ?? "playwright default"}`);
  log("starting prod server on port 3310 (server/dist must be built)");

  const server = startServer();
  let browser: Browser | null = null;
  try {
    await waitForServer(server, 20_000);
    browser = await launchBrowser();
    const sizes = new Map<string, number>();
    for (const spec of specs) {
      sizes.set(spec.name, await captureWithRetry(browser, spec));
    }
    log("summary:");
    for (const [name, bytes] of sizes) {
      log(`  ${name}.jpg — ${(bytes / 1024).toFixed(0)} KB`);
    }
  } finally {
    if (browser !== null) await browser.close();
    await stopServer(server);
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(`capture-shots crashed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
