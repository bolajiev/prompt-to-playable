import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import {
  playwrightBrowsersRoot,
  resolveChromiumExecutable,
} from "./playwright-env.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = join(ROOT, "artifacts", "demo");

export const DEMO_PROMPT =
  "a small room where I collect 3 glowing crystals while avoiding one guard";
export const DEMO_EDIT_PROMPT = "add a second guard that patrols the room";

const VIEWPORT = { width: 1280, height: 720 } as const;
const VIDEO_SIZE = { width: 1280, height: 720 } as const;
const NAVIGATION_TIMEOUT_MS = 60_000;
const GENERATE_TIMEOUT_MS = 90_000;
const EDIT_TIMEOUT_MS = 90_000;
const PLAY_TIMEOUT_MS = 100_000;
const PROBE_MS = 30_000;
const REPLAY_MS = 10_000;
const CONTROL_PERIOD_MS = 120;
const FLEE_DISTANCE = 4.5;
const RESUME_DISTANCE = 7;
const DEFAULT_PLAYER_SPEED_ESTIMATE = 6;
const CONTACT_MARGIN = 1.3;
const THREAT_LOOKAHEAD_S = 0.9;
const WALL_REPULSION = 1.6;
const BOUNDS_MARGIN = 0.8;
const INTERACT_RANGE = 2.3;
const EXHAUST_MS = 12_000;
const PROGRESS_STALL_MS = 20_000;

/** Camera is a constant offset from the player, so its ground-forward is fixed. */
const CAMERA_OFFSET: readonly [number, number, number] = [6, 8, 12];
const CAMERA_BASIS = (() => {
  const length = Math.hypot(CAMERA_OFFSET[0], CAMERA_OFFSET[2]);
  return { fx: -CAMERA_OFFSET[0] / length, fz: -CAMERA_OFFSET[2] / length };
})();

interface EntitySnapshot {
  id: string;
  kind: string;
  tags?: string[];
  active?: boolean;
  position?: number[];
  size?: number[];
  solid?: boolean;
  speed?: number;
}

interface ActionLike {
  type: string;
  objective?: string;
  entity?: string;
  target?: string;
}

interface RuleTriggerLike {
  event?: string;
  zone?: string;
  entity?: string;
  tag?: string;
  objective?: string;
}

interface RuleLike {
  id?: string;
  on?: RuleTriggerLike;
  then?: ActionLike[];
}

interface RuntimeSnapshot {
  position?: number[];
  velocity?: number[];
  active?: boolean;
  state?: string;
  tags?: string[];
}

interface ObjectiveSnapshot {
  id: string;
  type: string;
  target?: string;
  targets?: string[];
  count?: number;
  progress: number;
  status: string;
}

export interface GameSnapshot {
  status: "running" | "won" | "lost";
  time: number;
  entities: EntitySnapshot[];
  entityRuntime: Record<string, RuntimeSnapshot>;
  objectives: ObjectiveSnapshot[];
  doc?: {
    meta?: { title?: string };
    world?: { bounds?: number[] };
    entities?: EntitySnapshot[];
    rules?: RuleLike[];
  };
}

interface BeatRecord {
  startMs: number;
  endMs: number;
  detail: string;
}

interface Caption {
  text: string;
  startMs: number;
  endMs: number;
}

interface FinalSnapshot {
  status: string;
  time: number;
  title: string | null;
  guards: number;
  guardModes: string[];
  objectives: string[];
  player: [number, number, number] | null;
}

interface SteerOutcome {
  result: "won" | "lost" | "timeout" | "done";
  seconds: number;
  jumps: number;
  interacts: number;
  guards: number;
  guardModes: string[];
  objectives: string;
}

export interface DemoOptions {
  url: string;
  outDir?: string;
  prompt?: string;
  editPrompt?: string;
}

export interface DemoResult {
  ok: boolean;
  url: string;
  outDir: string;
  beats: Record<string, BeatRecord>;
  captions: Caption[];
  final: FinalSnapshot | null;
  diagnosis: CollectabilityDiagnosis | null;
  consoleErrors: string[];
  failure: string | null;
  error?: string;
}

interface ConsoleRecord {
  type: string;
  text: string;
  location: string;
}

class BeatRecorder {
  private readonly t0 = Date.now();
  readonly beats: Record<string, BeatRecord> = {};
  private readonly open = new Map<string, number>();

  now(): number {
    return Date.now() - this.t0;
  }

  start(name: string): void {
    this.open.set(name, this.now());
  }

  end(name: string, detail = ""): void {
    const startMs = this.open.get(name) ?? this.now();
    this.beats[name] = { startMs, endMs: this.now(), detail };
    this.open.delete(name);
  }

  has(name: string): boolean {
    return this.beats[name] !== undefined;
  }
}

function log(message: string): void {
  console.log(`[demo] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Full Chromium is preferred over the headless shell because it is the build
 * validated for Playwright video recording; falls back to the QA resolver.
 */
export function resolveDemoChromium(): string | undefined {
  const root = playwrightBrowsersRoot();
  if (existsSync(root)) {
    const revisions: number[] = [];
    for (const entry of readdirSync(root)) {
      const match = /^chromium-(\d+)$/.exec(entry);
      if (match) revisions.push(Number(match[1]));
    }
    revisions.sort((a, b) => b - a);
    for (const revision of revisions) {
      for (const relative of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const candidate = join(root, `chromium-${revision}`, relative);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return resolveChromiumExecutable();
}

export async function launchDemoChromium(): Promise<Browser> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "DISPLAY" && value !== undefined) env[key] = value;
  }
  return chromium.launch({
    headless: true,
    executablePath: resolveDemoChromium(),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      "--hide-scrollbars",
    ],
    env,
  });
}

async function readSnapshot(page: Page): Promise<GameSnapshot> {
  return page.evaluate(() => {
    const debug = (
      window as unknown as {
        __gameDebug?: { getState: () => GameSnapshot };
      }
    ).__gameDebug;
    if (!debug) throw new Error("__gameDebug hook is not installed");
    return debug.getState();
  });
}

async function blurActive(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
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

async function lastChatLine(page: Page): Promise<string> {
  const text = (await page.locator("#chat-log").innerText()).trim();
  return text.replace(/\s+/g, " ").slice(-300);
}

async function waitForLandingReady(page: Page): Promise<void> {
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
        badge?.getAttribute("data-validated") === "false" && controls.includes("WASD move")
      );
    },
    undefined,
    { timeout: NAVIGATION_TIMEOUT_MS }
  );
}

/** 5xx / transport failures are worth one more submission; 4xx are not. */
function isTransientError(text: string): boolean {
  return /HTTP 5\d\d|Could not reach the server|invalid JSON|Failed to fetch|network/i.test(
    text
  );
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

async function waitForChatOutcome(
  page: Page,
  mode: "generate" | "edit",
  errorsBefore: number,
  timeout: number
): Promise<void> {
  await page.waitForFunction(
    ({ kind, before }) => {
      const text = document.querySelector("#chat-log")?.textContent ?? "";
      const errors = document.querySelectorAll("#chat-log .line.error").length;
      const success =
        kind === "generate"
          ? text.includes('Loaded "')
          : text.includes("Applied edit to");
      return success || errors > before;
    },
    { kind: mode, before: errorsBefore },
    { timeout }
  );
}

async function waitForGuards(page: Page, minimum: number, timeout: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      (count) => {
        const debug = (
          window as unknown as {
            __gameDebug?: { getState: () => GameSnapshot };
          }
        ).__gameDebug;
        if (!debug) return false;
        const state = debug.getState();
        return (
          state.entities.filter(
            (entity) =>
              entity.kind === "enemy" &&
              (state.entityRuntime[entity.id]?.active ?? entity.active ?? true)
          ).length >= count
        );
      },
      minimum,
      { timeout, polling: 250 }
    );
    return true;
  } catch {
    return false;
  }
}

function toXZ(position: readonly number[] | undefined): [number, number] {
  return [position?.[0] ?? 0, position?.[2] ?? 0];
}

function distance2D(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function normalize(x: number, z: number): [number, number] | null {
  const length = Math.hypot(x, z);
  if (length < 1e-6) return null;
  return [x / length, z / length];
}

function playerXZ(state: GameSnapshot): [number, number] | null {
  const player = state.entities.find((entity) => entity.kind === "player");
  if (!player) return null;
  const runtime = state.entityRuntime[player.id];
  if (!runtime?.position) return null;
  return toXZ(runtime.position);
}

function playerSpeed(state: GameSnapshot): number {
  return (
    state.entities.find((entity) => entity.kind === "player")?.speed ??
    DEFAULT_PLAYER_SPEED_ESTIMATE
  );
}

interface EnemyCandidate {
  id: string;
  position: [number, number];
  velocity: [number, number];
  mode: string;
}

function activeEnemies(state: GameSnapshot): EnemyCandidate[] {
  const enemies: EnemyCandidate[] = [];
  for (const entity of state.entities) {
    if (entity.kind !== "enemy") continue;
    const runtime = state.entityRuntime[entity.id];
    if (!runtime || runtime.active === false || entity.active === false) continue;
    enemies.push({
      id: entity.id,
      position: toXZ(runtime.position),
      velocity: [runtime.velocity?.[0] ?? 0, runtime.velocity?.[2] ?? 0],
      mode: runtime.state ?? "unknown",
    });
  }
  return enemies;
}

interface TargetCandidate {
  id: string;
  position: [number, number];
}

function packPosition(position: readonly number[] | undefined): [number, number] {
  return [position?.[0] ?? 0, position?.[2] ?? 0];
}

function collectibleCandidates(state: GameSnapshot): TargetCandidate[] {
  const wanted = new Set<string>();
  for (const objective of state.objectives) {
    if (objective.status !== "active") continue;
    if (objective.target) wanted.add(objective.target);
    for (const id of objective.targets ?? []) wanted.add(id);
  }

  const candidates: TargetCandidate[] = [];
  for (const entity of state.entities) {
    const runtime = state.entityRuntime[entity.id];
    if (!runtime || runtime.active === false || entity.active === false) continue;
    const tags = runtime.tags ?? entity.tags ?? [];
    const looksCollectible =
      entity.kind === "collectible" || tags.some((tag) => /collect|crystal/i.test(tag));
    if (!wanted.has(entity.id) && !looksCollectible) continue;
    candidates.push({ id: entity.id, position: packPosition(runtime.position) });
  }
  return candidates;
}

function progressSum(state: GameSnapshot): number {
  return state.objectives.reduce((sum, objective) => sum + (objective.progress ?? 0), 0);
}

function describeObjectives(state: GameSnapshot): string {
  return state.objectives
    .map((objective) => {
      const target = objective.targets?.join(",") ?? objective.target ?? "";
      const count = typeof objective.count === "number" ? `/${objective.count}` : "";
      return `${objective.id}(${objective.type}${target ? `:${target}` : ""}) ${objective.progress}${count} ${objective.status}`;
    })
    .join(" | ");
}

/** Grounded player AABB vertical extent ([feet, head]); zones must overlap it. */
export const PLAYER_BOX_BOTTOM = 0;
export const PLAYER_BOX_TOP = 1.8;

export interface CollectabilityDiagnosis {
  solvable: boolean;
  issues: string[];
}

function progressesObjective(
  actions: readonly ActionLike[] | undefined,
  objectiveId: string,
  targetId: string
): boolean {
  return (actions ?? []).some(
    (action) =>
      (action.type === "objectiveProgress" && action.objective === objectiveId) ||
      (action.type === "setObjective" && action.objective === objectiveId) ||
      (action.type === "despawn" && action.entity === targetId) ||
      (action.type === "disable" && action.entity === targetId)
  );
}

function hasZonePath(
  zone: EntitySnapshot,
  target: EntitySnapshot,
  objective: ObjectiveSnapshot,
  rules: readonly RuleLike[]
): boolean {
  if (zone.solid === true) return false;
  const size = zone.size ?? [2, 2, 2];
  const bottom = (zone.position?.[1] ?? 0) - size[1] / 2;
  const top = (zone.position?.[1] ?? 0) + size[1] / 2;
  if (!(bottom <= PLAYER_BOX_TOP && top >= PLAYER_BOX_BOTTOM)) return false;
  return rules.some((rule) => {
    if (rule.on?.event !== "playerEnter") return false;
    if (rule.on.zone !== undefined && rule.on.zone !== zone.id) return false;
    if (rule.on.entity !== undefined && rule.on.entity !== zone.id) return false;
    if (rule.on.tag !== undefined && !(zone.tags ?? []).includes(rule.on.tag)) return false;
    return progressesObjective(rule.then, objective.id, target.id);
  });
}

function hasInteractPath(
  target: EntitySnapshot,
  objective: ObjectiveSnapshot,
  rules: readonly RuleLike[]
): boolean {
  const interactable =
    target.kind === "interactable" || (target.tags ?? []).includes("interactable");
  if (!interactable) return false;
  return rules.some((rule) => {
    if (rule.on?.event !== "interact") return false;
    if (rule.on.zone !== undefined) return false;
    if (rule.on.entity !== undefined && rule.on.entity !== target.id) return false;
    if (rule.on.tag !== undefined && !(target.tags ?? []).includes(rule.on.tag)) return false;
    return progressesObjective(rule.then, objective.id, target.id);
  });
}

/**
 * Static check that every active collect/activate target can actually be
 * collected by walking (playerEnter on a co-located, non-solid zone whose AABB
 * overlaps the grounded player box [0, 1.8]) or by pressing E (interactable
 * target with an interact rule). Catches generations where the crystal is
 * unreachable by the engine's zone-volume check.
 */
export function diagnoseCollectability(state: GameSnapshot): CollectabilityDiagnosis {
  const doc = state.doc;
  if (!doc?.entities) return { solvable: true, issues: ["no document snapshot"] };
  const rules = doc.rules ?? [];
  const issues: string[] = [];

  for (const objective of state.objectives) {
    if (objective.status !== "active") continue;
    if (objective.type !== "collect" && objective.type !== "activate") continue;
    const ids = objective.targets ?? (objective.target ? [objective.target] : []);
    for (const id of ids) {
      const target = doc.entities.find((entity) => entity.id === id);
      if (!target) {
        issues.push(`${objective.id}/${id}: target entity missing`);
        continue;
      }
      if (hasInteractPath(target, objective, rules)) continue;
      if (target.position === undefined) {
        issues.push(`${objective.id}/${id}: target has no position`);
        continue;
      }
      const zones = doc.entities.filter(
        (entity) =>
          entity.kind === "zone" &&
          entity.active !== false &&
          entity.position !== undefined &&
          distance2D(
            [entity.position[0] ?? 0, entity.position[2] ?? 0],
            [target.position?.[0] ?? 0, target.position?.[2] ?? 0]
          ) < 0.75
      );
      if (zones.length === 0) {
        issues.push(`${objective.id}/${id}: no co-located zone and not interactable`);
        continue;
      }
      if (!zones.some((zone) => hasZonePath(zone, target, objective, rules))) {
        issues.push(
          `${objective.id}/${id}: ${zones.length} co-located zone(s) but no usable playerEnter path`
        );
      }
    }
  }

  return { solvable: issues.length === 0, issues };
}

/** World direction -> camera-relative key set (camera basis is a constant offset). */
export function directionKeys(dx: number, dz: number): string[] {
  const { fx, fz } = CAMERA_BASIS;
  const forward = dx * fx + dz * fz;
  const right = -dx * fz + dz * fx;
  const keys: string[] = [];
  if (forward > 0.2) keys.push("w");
  else if (forward < -0.2) keys.push("s");
  if (right > 0.2) keys.push("d");
  else if (right < -0.2) keys.push("a");
  return keys;
}

class KeyDriver {
  private readonly held = new Set<string>();

  constructor(private readonly page: Page) {}

  async set(keys: readonly string[]): Promise<void> {
    const desired = new Set(keys);
    for (const key of [...this.held]) {
      if (!desired.has(key)) {
        await this.page.keyboard.up(key);
        this.held.delete(key);
      }
    }
    for (const key of desired) {
      if (!this.held.has(key)) {
        await this.page.keyboard.down(key);
        this.held.add(key);
      }
    }
  }

  async releaseAll(): Promise<void> {
    await this.set([]);
  }

  async tap(key: string, holdMs = 90): Promise<void> {
    await this.page.keyboard.down(key);
    await this.page.waitForTimeout(holdMs);
    await this.page.keyboard.up(key);
  }
}

export interface SteeringDecision {
  direction: [number, number];
  reason: "seek" | "flee" | "wander" | "unstick";
  targetId: string | null;
  targetDistance: number | null;
}

export interface SteeringTuning {
  fleeDistance: number;
  resumeDistance: number;
}

export const DEFAULT_STEERING: SteeringTuning = {
  fleeDistance: FLEE_DISTANCE,
  resumeDistance: RESUME_DISTANCE,
};

/** Keeps a desired direction inside the world bounds by sliding along the wall. */
export function slideWithinBounds(
  state: GameSnapshot,
  player: readonly [number, number],
  dx: number,
  dz: number
): [number, number] {
  const bounds = state.doc?.world?.bounds;
  if (!bounds || bounds.length < 3) return [dx, dz];
  const limitX = Math.max(0, (bounds[0] ?? 0) / 2 - BOUNDS_MARGIN);
  const limitZ = Math.max(0, (bounds[2] ?? 0) / 2 - BOUNDS_MARGIN);
  let x = dx;
  let z = dz;
  if (limitX > 0 && ((player[0] >= limitX && x > 0) || (player[0] <= -limitX && x < 0))) {
    x = 0;
  }
  if (limitZ > 0 && ((player[1] >= limitZ && z > 0) || (player[1] <= -limitZ && z < 0))) {
    z = 0;
  }
  if (Math.hypot(x, z) > 1e-6) return [x, z];
  return normalize(-player[0], -player[1]) ?? [0, 0];
}

/**
 * Guard-aware target seeker. Each update picks the nearest uncollected
 * objective target and returns a world direction:
 * - flee: a guard is closer than `fleeDistance` -> run directly away from it
 *   until the distance exceeds `resumeDistance` (hysteresis stops the player
 *   from orbiting a chasing guard just inside contact range);
 * - seek: otherwise head straight for the target (the player is faster than
 *   the guards, so regaining distance is enough to collect safely);
 * - wander: no target visible (used for the post-edit replay);
 * - unstick: no displacement for 1.5s -> sidestep perpendicular, alternating
 *   sides.
 */
export class SteeringController {
  private fleeing = false;
  private readonly exhausted = new Map<string, number>();
  private lastPosition: [number, number] | null = null;
  private stuckSince = 0;
  private escapeUntil = 0;
  private escapeSign = 1;
  private lastProgress = -1;
  private progressAt = 0;

  constructor(private readonly tuning: SteeringTuning = DEFAULT_STEERING) {}

  /**
   * True when the guard's relative velocity closes the gap to inside contact
   * range within `THREAT_LOOKAHEAD_S`, even while still outside `fleeDistance`.
   * Uses live guard velocity from the runtime snapshot, so head-on approaches
   * trigger an evade before the (latency-bounded) control loop reacts.
   */
  private predictsContact(
    player: readonly [number, number],
    direction: [number, number],
    guards: readonly EnemyCandidate[],
    speed: number
  ): boolean {
    const playerVelocityX = direction[0] * speed;
    const playerVelocityZ = direction[1] * speed;
    for (const guard of guards) {
      const dx = player[0] - guard.position[0];
      const dz = player[1] - guard.position[1];
      const distance = Math.hypot(dx, dz);
      if (distance < 1e-6) return true;
      const relativeX = playerVelocityX - guard.velocity[0];
      const relativeZ = playerVelocityZ - guard.velocity[1];
      const closing = -(relativeX * dx + relativeZ * dz) / distance;
      if (closing <= 0.01) continue;
      const timeToContact = (distance - CONTACT_MARGIN) / closing;
      if (timeToContact < THREAT_LOOKAHEAD_S) return true;
    }
    return false;
  }

  update(state: GameSnapshot, nowMs: number): SteeringDecision {
    if (this.stuckSince === 0) {
      this.stuckSince = nowMs;
      this.progressAt = nowMs;
    }

    const player = playerXZ(state);
    if (!player) {
      return { direction: [0, 0], reason: "wander", targetId: null, targetDistance: null };
    }

    let nearestGuardDistance = Infinity;
    let nearestGuardPosition: [number, number] | null = null;
    const guards: EnemyCandidate[] = activeEnemies(state);
    for (const enemy of guards) {
      const distance = distance2D(player, enemy.position);
      if (distance < nearestGuardDistance) {
        nearestGuardDistance = distance;
        nearestGuardPosition = enemy.position;
      }
    }

    const progress = progressSum(state);
    if (progress > this.lastProgress) {
      this.lastProgress = progress;
      this.progressAt = nowMs;
    }

    let target: TargetCandidate | null = null;
    let targetDistance: number | null = null;
    for (const candidate of collectibleCandidates(state)) {
      if ((this.exhausted.get(candidate.id) ?? 0) > nowMs) continue;
      const distance = distance2D(player, candidate.position);
      if (!target || distance < (targetDistance ?? Infinity)) {
        target = candidate;
        targetDistance = distance;
      }
    }
    if (target && nowMs - this.progressAt > PROGRESS_STALL_MS) {
      this.exhausted.set(target.id, nowMs + EXHAUST_MS);
      this.progressAt = nowMs;
      target = null;
      targetDistance = null;
    }

    let dx = 0;
    let dz = 0;
    let reason: SteeringDecision["reason"] = "wander";
    if (target) {
      const direction = normalize(
        target.position[0] - player[0],
        target.position[1] - player[1]
      );
      dx = direction?.[0] ?? 0;
      dz = direction?.[1] ?? 0;
      reason = "seek";
    } else {
      dx = Math.cos(state.time * 0.8);
      dz = Math.sin(state.time * 0.8);
    }

    const threatened =
      nearestGuardPosition !== null &&
      (nearestGuardDistance < this.tuning.fleeDistance ||
        this.predictsContact(player, [dx, dz], guards, playerSpeed(state)));

    if (this.fleeing) {
      if (nearestGuardPosition === null || nearestGuardDistance > this.tuning.resumeDistance) {
        this.fleeing = false;
      }
    } else if (threatened) {
      this.fleeing = true;
    }

    if (this.fleeing && nearestGuardPosition) {
      const evadeRadius = this.tuning.fleeDistance + 1.5;
      let ex = 0;
      let ez = 0;
      for (const enemy of guards) {
        const distance = distance2D(player, enemy.position);
        if (distance >= evadeRadius) continue;
        const vector = normalize(
          player[0] - enemy.position[0],
          player[1] - enemy.position[1]
        );
        if (!vector) continue;
        const weight = (evadeRadius - distance) / evadeRadius;
        ex += vector[0] * weight;
        ez += vector[1] * weight;
      }
      const away = normalize(ex, ez);
      if (away) {
        const bounds = state.doc?.world?.bounds;
        let vx = away[0];
        let vz = away[1];
        if (bounds && bounds.length >= 3) {
          const limitX = Math.max(0, (bounds[0] ?? 0) / 2 - 0.3);
          const limitZ = Math.max(0, (bounds[2] ?? 0) / 2 - 0.3);
          const margin = 3;
          if (limitX > margin) {
            if (player[0] > limitX - margin) {
              vx -= ((player[0] - (limitX - margin)) / margin) * WALL_REPULSION;
            } else if (player[0] < -(limitX - margin)) {
              vx += ((-player[0] - (limitX - margin)) / margin) * WALL_REPULSION;
            }
          }
          if (limitZ > margin) {
            if (player[1] > limitZ - margin) {
              vz -= ((player[1] - (limitZ - margin)) / margin) * WALL_REPULSION;
            } else if (player[1] < -(limitZ - margin)) {
              vz += ((-player[1] - (limitZ - margin)) / margin) * WALL_REPULSION;
            }
          }
        }
        const direction = normalize(vx, vz) ?? away;
        dx = direction[0];
        dz = direction[1];
        reason = "flee";
      }
    }

    [dx, dz] = slideWithinBounds(state, player, dx, dz);

    const moved = this.lastPosition ? distance2D(player, this.lastPosition) : Infinity;
    if (moved > 0.05) {
      this.lastPosition = player;
      this.stuckSince = nowMs;
    } else if (nowMs - this.stuckSince > 1_500 && nowMs > this.escapeUntil) {
      this.escapeUntil = nowMs + 700;
      this.escapeSign = -this.escapeSign;
      this.lastPosition = player;
      this.stuckSince = nowMs;
    }
    if (nowMs < this.escapeUntil) {
      const perpendicularX = -dz * this.escapeSign;
      const perpendicularZ = dx * this.escapeSign;
      dx = perpendicularX;
      dz = perpendicularZ;
      reason = "unstick";
    }

    const direction = normalize(dx, dz) ?? [0, 0];
    return { direction, reason, targetId: target?.id ?? null, targetDistance };
  }
}

interface SteerOptions {
  /** Stop when the level reports won/lost, or when this wall-clock budget ends. */
  durationMs: number;
  onSample?: (sample: {
    status: string;
    player: [number, number] | null;
    targetId: string | null;
    progress: number;
    guards: number;
  }) => void;
}

/**
 * Bang-bang steering at ~8 Hz: each cycle reads the live engine snapshot,
 * asks the SteeringController for a world direction, then holds the matching
 * camera-relative keys. E is tapped in range (covers both zone-overlap and
 * interact-to-collect levels) and Space is tapped once early on to show jump.
 */
async function steer(
  page: Page,
  driver: KeyDriver,
  options: SteerOptions
): Promise<SteerOutcome> {
  const started = Date.now();
  const deadline = started + options.durationMs;
  const controller = new SteeringController();
  let jumps = 0;
  let interacts = 0;
  let lastInteract = 0;
  let nextJump = started + 1_000;
  let guards = 0;
  let guardModes: string[] = [];
  let bestObjectives = "";

  while (Date.now() < deadline) {
    const state = await readSnapshot(page);
    const enemies = activeEnemies(state);
    guards = enemies.length;
    guardModes = enemies.map((enemy) => `${enemy.id}:${enemy.mode}`);
    bestObjectives = describeObjectives(state);

    if (state.status !== "running") {
      await driver.releaseAll();
      return {
        result: state.status === "won" ? "won" : "lost",
        seconds: (Date.now() - started) / 1000,
        jumps,
        interacts,
        guards,
        guardModes,
        objectives: bestObjectives,
      };
    }

    const player = playerXZ(state);
    if (!player) {
      await page.waitForTimeout(150);
      continue;
    }

    const decision = controller.update(state, Date.now());
    await driver.set(directionKeys(decision.direction[0], decision.direction[1]));

    if (nextJump > 0 && Date.now() >= nextJump) {
      await driver.tap("Space", 140);
      jumps += 1;
      nextJump = 0;
    }

    if (
      decision.targetId !== null &&
      decision.targetDistance !== null &&
      decision.targetDistance < INTERACT_RANGE &&
      Date.now() - lastInteract > 700
    ) {
      await driver.tap("e", 90);
      interacts += 1;
      lastInteract = Date.now();
    }

    options.onSample?.({
      status: state.status,
      player,
      targetId: decision.targetId,
      progress: progressSum(state),
      guards,
    });

    await page.waitForTimeout(CONTROL_PERIOD_MS);
  }

  await driver.releaseAll();
  return {
    result: "timeout",
    seconds: (Date.now() - started) / 1000,
    jumps,
    interacts,
    guards,
    guardModes,
    objectives: bestObjectives,
  };
}

function describeSteer(outcome: SteerOutcome): string {
  return `${outcome.result} after ${outcome.seconds.toFixed(1)}s; jumps=${outcome.jumps}; interacts=${outcome.interacts}; guards=${outcome.guards} [${outcome.guardModes.join(",") || "none"}]; objectives=${outcome.objectives}`;
}

async function finalSnapshot(page: Page): Promise<FinalSnapshot | null> {
  try {
    const state = await readSnapshot(page);
    const player = playerXZ(state);
    const playerEntity = state.entities.find((entity) => entity.kind === "player");
    const playerPosition = playerEntity
      ? state.entityRuntime[playerEntity.id]?.position
      : undefined;
    return {
      status: state.status,
      time: state.time,
      title: state.doc?.meta?.title ?? null,
      guards: activeEnemies(state).length,
      guardModes: activeEnemies(state).map((enemy) => `${enemy.id}:${enemy.mode}`),
      objectives: state.objectives.map((objective) => describeObjectives({
        ...state,
        objectives: [objective],
      })),
      player: playerPosition
        ? [playerPosition[0] ?? 0, playerPosition[1] ?? 0, playerPosition[2] ?? 0]
        : player
          ? [player[0], 0, player[1]]
          : null,
    };
  } catch {
    return null;
  }
}

function buildCaptions(beats: Record<string, BeatRecord>): Caption[] {
  const captions: Caption[] = [];
  const push = (text: string, startBeat: string, endBeat: string): void => {
    const start = beats[startBeat];
    const end = beats[endBeat] ?? start;
    if (!start || !end) return;
    captions.push({
      text,
      startMs: start.startMs,
      endMs: Math.max(end.endMs, start.startMs + 1_500),
    });
  };

  push("Describe a game in plain language", "landing", "prompt");
  push("AI generates a playable 3D game — validated, no generated code runs", "generating", "generating");
  push("Play it with WASD / Space / E — real objectives and collision", "playing", "playing");
  push("Keep shaping it by talking", "edit", "edit");
  push("Updated live: a second guard patrols the room", "replay", "replay");
  push("Plain language in, playable game out", "end", "end");
  return captions;
}

export async function runDemo(page: Page, options: DemoOptions): Promise<DemoResult> {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  mkdirSync(outDir, { recursive: true });
  const prompt = options.prompt ?? DEMO_PROMPT;
  const editPrompt = options.editPrompt ?? DEMO_EDIT_PROMPT;

  const recorder = new BeatRecorder();
  const consoleErrors: string[] = [];
  const consoleRecords: ConsoleRecord[] = [];
  const driver = new KeyDriver(page);

  let failure: string | null = null;
  let final: FinalSnapshot | null = null;
  let playOutcome: SteerOutcome | null = null;
  let replayOutcome: SteerOutcome | null = null;
  let diagnosis: CollectabilityDiagnosis | null = null;
  const samples: Array<Record<string, unknown>> = [];
  const sampleFor =
    (beat: string) =>
    (sample: {
      status: string;
      player: [number, number] | null;
      targetId: string | null;
      progress: number;
      guards: number;
    }): void => {
      samples.push({ beat, tMs: recorder.now(), ...sample });
    };

  page.on("console", (message) => {
    const location = message.location();
    const record: ConsoleRecord = {
      type: message.type(),
      text: message.text(),
      location: location.url ? `${location.url}:${location.lineNumber}` : "",
    };
    consoleRecords.push(record);
    if (record.type === "error") consoleErrors.push(`console: ${record.text}`);
  });
  page.on("pageerror", (error) => {
    const text = errorMessage(error);
    consoleRecords.push({ type: "pageerror", text, location: "" });
    consoleErrors.push(`pageerror: ${text}`);
  });
  page.on("requestfailed", (request) => {
    consoleRecords.push({
      type: "requestfailed",
      text: `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
      location: "",
    });
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path !== "/generate" && path !== "/edit") return;
    log(`response ${response.status()} ${path}`);
    consoleRecords.push({ type: "response", text: `${response.status()} ${path}`, location: "" });
  });

  try {
    await page.setViewportSize(VIEWPORT);
    await page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));

    recorder.start("landing");
    log(`navigating to ${options.url}`);
    await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await waitForLandingReady(page);
    await page.waitForTimeout(1_200);
    recorder.end("landing", 'landing ready; badge="unvalidated"');
    log(`landing ready (t=${recorder.now()}ms)`);

    recorder.start("prompt");
    await page.locator("#chat-input").pressSequentially(prompt, { delay: 20 });
    recorder.end("prompt", `typed: ${prompt}`);
    log(`prompt typed (t=${recorder.now()}ms)`);

    recorder.start("generating");
    let generateError: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const errorsBefore = await chatErrorCount(page);
      await page.locator("#chat-submit").click();
      await waitForChatOutcome(page, "generate", errorsBefore, GENERATE_TIMEOUT_MS);
      generateError = await newChatError(page, errorsBefore);
      log(
        `generation attempt ${attempt}: ${
          generateError ? `error: ${generateError}` : "submitted"
        }`
      );
      if (!generateError) break;
      if (!isTransientError(generateError) || attempt === 3) break;
      await page.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      await waitForLandingReady(page);
      await page.waitForTimeout(2_000);
      await page.locator("#chat-input").pressSequentially(prompt, { delay: 12 });
    }
    if (generateError) throw new Error(`generation failed: ${generateError}`);
    await waitForValidated(page, GENERATE_TIMEOUT_MS);
    await waitForObjective(page, GENERATE_TIMEOUT_MS);
    const generated = await readSnapshot(page);
    await page.screenshot({ path: join(outDir, "02-generated.png") });
    await page.waitForTimeout(2_500);
    recorder.end(
      "generating",
      `${generated.doc?.meta?.title ?? "game"}; objectives=${describeObjectives(generated)}`
    );
    log(`validated (t=${recorder.now()}ms): ${describeObjectives(generated)}`);

    diagnosis = diagnoseCollectability(generated);
    log(
      `collectability: ${
        diagnosis.solvable ? "solvable" : `issues: ${diagnosis.issues.join("; ")}`
      }`
    );

    let collectionBroken = !diagnosis.solvable;
    playOutcome = null;
    if (diagnosis.solvable) {
      recorder.start("playing");
      await blurActive(page);
      let outcome = await steer(page, driver, { durationMs: PROBE_MS, onSample: sampleFor("playing") });
      if (outcome.result === "timeout") {
        const probeState = await readSnapshot(page);
        if (progressSum(probeState) > 0) {
          const rest = await steer(page, driver, {
            durationMs: PLAY_TIMEOUT_MS - PROBE_MS,
            onSample: sampleFor("playing"),
          });
          outcome = {
            ...rest,
            seconds: outcome.seconds + rest.seconds,
            jumps: outcome.jumps + rest.jumps,
            interacts: outcome.interacts + rest.interacts,
          };
        } else {
          collectionBroken = true;
        }
      }
      await driver.releaseAll();
      if (!collectionBroken) {
        playOutcome = outcome;
        await page.screenshot({
          path: join(
            outDir,
            outcome.result === "won" ? "03-won.png" : `03-${outcome.result}.png`
          ),
        });
        await page.waitForTimeout(1_500);
        recorder.end("playing", describeSteer(outcome));
        log(`play beat: ${describeSteer(outcome)}`);
        if (outcome.result !== "won") {
          failure = `play beat ended with ${outcome.result} (no win)`;
        }
      } else {
        recorder.end(
          "playing",
          `${describeSteer(outcome)}; zero collection progress -> repair edit`
        );
        log(`play probe found no collection progress; falling back to repair edit`);
      }
    }

    const needsRepair = collectionBroken;
    const effectiveEditPrompt = needsRepair
      ? `${editPrompt}; the crystals cannot be collected — fix the pickup zones so walking into each crystal collects it`
      : editPrompt;
    recorder.start("edit");
    await blurActive(page);
    await page.locator("#chat-input").pressSequentially(effectiveEditPrompt, { delay: 20 });
    let editError: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const errorsBefore = await chatErrorCount(page);
      await page.locator("#chat-submit").click();
      await waitForChatOutcome(page, "edit", errorsBefore, EDIT_TIMEOUT_MS);
      editError = await newChatError(page, errorsBefore);
      log(`edit attempt ${attempt}: ${editError ? `error: ${editError}` : "submitted"}`);
      if (!editError) break;
      if (!isTransientError(editError) || attempt === 3) break;
      await page.waitForTimeout(4_000);
      await page.locator("#chat-input").pressSequentially(effectiveEditPrompt, { delay: 12 });
    }
    if (editError) throw new Error(`edit failed: ${editError}`);
    await waitForValidated(page, EDIT_TIMEOUT_MS);
    const edited = await readSnapshot(page);
    writeFileSync(join(outDir, "generated-doc.json"), `${JSON.stringify(generated.doc, null, 2)}\n`, "utf8");
    writeFileSync(join(outDir, "edited-doc.json"), `${JSON.stringify(edited.doc, null, 2)}\n`, "utf8");
    const editedGuards = activeEnemies(edited).length;
    const guardsSeen = await waitForGuards(page, 2, 15_000);
    await page.waitForTimeout(1_200);
    recorder.end(
      "edit",
      `applied${needsRepair ? " (repair fallback)" : ""}; guardsAfterEdit=${editedGuards} (>=2 awaited: ${guardsSeen}); objectives=${describeObjectives(edited)}`
    );
    log(`edit applied (t=${recorder.now()}ms); guards=${editedGuards}`);

    if (needsRepair) {
      recorder.start("replay");
      await blurActive(page);
      playOutcome = await steer(page, driver, { durationMs: PLAY_TIMEOUT_MS, onSample: sampleFor("replay") });
      await driver.releaseAll();
      await page.screenshot({
        path: join(
          outDir,
          playOutcome.result === "won" ? "03-won.png" : `03-after-edit-${playOutcome.result}.png`
        ),
      });
      await page.waitForTimeout(1_500);
      recorder.end("replay", `post-edit play (repair fallback): ${describeSteer(playOutcome)}`);
      log(`post-repair play beat: ${describeSteer(playOutcome)}`);
      if (playOutcome.result !== "won") {
        failure = `post-repair play ended with ${playOutcome.result} (no win)`;
      }
    } else {
      recorder.start("replay");
      await blurActive(page);
      replayOutcome = await steer(page, driver, { durationMs: REPLAY_MS, onSample: sampleFor("replay") });
      await driver.releaseAll();
      await page.screenshot({ path: join(outDir, "04-replay.png") });
      recorder.end("replay", `post-edit replay: ${describeSteer(replayOutcome)}`);
      log(`replay beat: ${describeSteer(replayOutcome)}`);
    }

    recorder.start("end");
    final = await finalSnapshot(page);
    await page.screenshot({ path: join(outDir, "05-end.png") });
    await page.waitForTimeout(2_500);
    recorder.end(
      "end",
      final
        ? `final status=${final.status}; guards=${final.guards}; objectives=${final.objectives.join(" | ")}`
        : "final state unavailable"
    );
    log(`final: status=${final?.status ?? "?"} guards=${final?.guards ?? "?"}`);
  } catch (error) {
    failure = errorMessage(error);
    log(`FAILED: ${failure}`);
  } finally {
    await driver.releaseAll().catch(() => undefined);
    if (!final) final = await finalSnapshot(page).catch(() => null);
  }

  const captions = buildCaptions(recorder.beats);
  const ok = failure === null && playOutcome?.result === "won";

  const consoleLogPath = join(outDir, "console.log");
  const consoleLines = consoleRecords.map(
    (record) =>
      `${record.type}\t${record.text}${record.location ? `\t${record.location}` : ""}`
  );
  writeFileSync(consoleLogPath, `${consoleLines.join("\n")}\n`, "utf8");
  writeFileSync(
    join(outDir, "state-samples.jsonl"),
    `${samples.map((sample) => JSON.stringify(sample)).join("\n")}${samples.length > 0 ? "\n" : ""}`,
    "utf8"
  );

  const result: DemoResult = {
    ok,
    url: options.url,
    outDir,
    beats: recorder.beats,
    captions,
    final,
    diagnosis,
    consoleErrors,
    failure,
    ...(failure ? { error: failure } : {}),
  };

  writeFileSync(
    join(outDir, "beats.json"),
    `${JSON.stringify(
      {
        url: options.url,
        recordedAt: new Date().toISOString(),
        video: "demo.webm",
        beats: recorder.beats,
        captions,
        final,
        diagnosis,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeFileSync(
    join(outDir, "run-summary.json"),
    `${JSON.stringify(
      {
        ok,
        url: options.url,
        beats: recorder.beats,
        captions,
        final,
        diagnosis,
        consoleErrors,
        failure,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  log(
    `console errors: ${consoleErrors.length}${
      consoleErrors.length > 0 ? ` (${consoleErrors.join(" | ")})` : ""
    }`
  );
  return result;
}

interface CliOptions {
  url?: string;
  outDir?: string;
  prompt?: string;
  editPrompt?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--out requires a directory");
      options.outDir = value;
      i += 1;
    } else if (arg === "--prompt") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--prompt requires a value");
      options.prompt = value;
      i += 1;
    } else if (arg === "--edit") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--edit requires a value");
      options.editPrompt = value;
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
        "usage: npx tsx scripts/demo-record.ts <url> [--out <dir>] [--prompt <text>] [--edit <text>]"
      );
      process.exitCode = 2;
      return;
    }

    const outDir = options.outDir ?? DEFAULT_OUT_DIR;
    mkdirSync(outDir, { recursive: true });
    const demoPath = join(outDir, "demo.webm");
    rmSync(demoPath, { force: true });

    const executablePath = resolveDemoChromium();
    log(`chromium executable: ${executablePath ?? "playwright default"}`);
    const browser = await launchDemoChromium();
    let result: DemoResult | null = null;
    let videoSaved = false;

    try {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        recordVideo: { dir: outDir, size: VIDEO_SIZE },
      });
      const page = await context.newPage();
      const video = page.video();
      try {
        result = await runDemo(page, {
          url: options.url,
          outDir,
          prompt: options.prompt,
          editPrompt: options.editPrompt,
        });
      } finally {
        await context.close().catch(() => undefined);
        if (video) {
          try {
            await video.saveAs(demoPath);
            videoSaved = true;
          } catch (error) {
            log(`warning: could not save demo.webm (${errorMessage(error)})`);
          }
        }
      }
    } finally {
      await browser.close();
    }

    if (result === null) {
      console.error("demo-record: run produced no result");
      process.exitCode = 1;
      return;
    }

    console.log(
      `${result.ok ? "PASS" : "FAIL"} demo-record ${result.url} beats=${
        Object.keys(result.beats).length
      } captions=${result.captions.length} video=${videoSaved ? demoPath : "auto-saved webm"} ${
        result.failure ? `failure="${result.failure}"` : ""
      }`
    );
    process.exitCode = result.ok ? 0 : 1;
  })().catch((error: unknown) => {
    console.error(`demo-record crashed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
