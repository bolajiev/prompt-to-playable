import * as THREE from "three";
import { Engine, type GameState } from "@prompt-to-playable/engine";
import { applyWorldEnvironment, Renderer } from "@prompt-to-playable/render";
import type { GameDoc } from "@prompt-to-playable/schema";
import { Chat } from "./ui/chat.js";
import { Hud } from "./ui/hud.js";
import { ValidationBadge } from "./ui/badge.js";
import {
  createKeyboardState,
  PREVENT_DEFAULT_CODES,
  toWorldInput,
} from "./ui/input.js";

export interface AppElements {
  canvas: HTMLCanvasElement;
  chatForm: HTMLFormElement;
  chatInput: HTMLInputElement;
  chatLog: HTMLElement;
  hud: HTMLElement;
  badge: HTMLElement;
}

export interface AppOptions {
  /** Base URL prepended to /generate and /edit (default: same origin). */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

interface EditResponse {
  doc: GameDoc;
  patch: unknown[];
}

export function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLButtonElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * Lighting presets and environment helpers live in `@prompt-to-playable/render`
 * (pure tables plus `applyWorldEnvironment`); re-exported here so app consumers
 * keep one import surface.
 */
export {
  applyWorldEnvironment,
  LIGHTING_PROFILES,
  lightingProfile,
  MIN_AMBIENT_INTENSITY,
  MIN_DIRECTIONAL_INTENSITY,
  MIN_FILL_INTENSITY,
  MIN_HEMISPHERE_INTENSITY,
  WORLD_ENVIRONMENT_NAME,
} from "@prompt-to-playable/render";
export type { LightingProfile } from "@prompt-to-playable/render";

export interface GameDebugHook {
  /** Deep-cloned engine snapshot (JSON round-trip), refreshed on every call. */
  getState: () => GameState;
}

/**
 * Pure factory for the browser QA debug hook: a frozen accessor that returns a
 * deep clone of the current state via a JSON round-trip. Callers get the full
 * snapshot but can never reach (or mutate) engine internals. It performs no
 * DOM access and never mutates engine state, so it is unit-testable without a
 * browser.
 */
export function createDebugHook(source: {
  getState: () => GameState;
}): GameDebugHook {
  return Object.freeze({
    getState: () => JSON.parse(JSON.stringify(source.getState())) as GameState,
  });
}

declare global {
  interface Window {
    /** QA aid installed by App: deep-cloned engine snapshots for automation. */
    __gameDebug?: GameDebugHook;
  }
}

/** Installs the deep-clone debug hook on the browser window when one exists. */
function installDebugHook(engine: Engine): void {
  if (typeof window === "undefined") return;
  window.__gameDebug = createDebugHook(engine);
}

function errorMessage(payload: unknown, status: number): string {
  if (payload !== null && typeof payload === "object") {
    const value = payload as { error?: unknown; details?: unknown };
    if (Array.isArray(value.details)) {
      const details = value.details.filter(
        (detail): detail is string => typeof detail === "string"
      );
      if (details.length > 0) return details.join("; ");
    }
    if (typeof value.error === "string") return value.error;
  }
  return `Request failed (HTTP ${status})`;
}

/**
 * Wires the pure engine, the Three.js renderer and the DOM UI together.
 *
 * Boundary rules upheld here:
 * - the engine is only told to `load`/`step`; its state is only ever read;
 * - the renderer is fed immutable snapshots via `reconcile` and never mutates;
 * - all engine access stays in this module; UI modules are view-only.
 */
export class App {
  private readonly engine = new Engine();
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly webgl: THREE.WebGLRenderer;
  private readonly renderer: Renderer;
  private readonly hud: Hud;
  private readonly badge: ValidationBadge;
  private readonly chat: Chat;
  private readonly keyboard = createKeyboardState();

  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly now: () => number;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly history: string[] = [];

  private lastValidatedDoc: GameDoc | null = null;
  private lastTime = 0;
  private running = false;
  private frameHandle: number | null = null;

  constructor(elements: AppElements, options: AppOptions = {}) {
    this.apiBase = options.apiBase ?? "";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => performance.now());
    this.requestFrame =
      options.requestFrame ?? ((callback) => globalThis.requestAnimationFrame(callback));
    this.cancelFrame =
      options.cancelFrame ?? ((handle) => globalThis.cancelAnimationFrame(handle));

    this.scene = new THREE.Scene();
    applyWorldEnvironment(this.scene);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    this.camera.position.set(6, 8, 12);
    this.camera.lookAt(0, 0, 0);

    this.webgl = new THREE.WebGLRenderer({
      canvas: elements.canvas,
      antialias: true,
    });
    this.webgl.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));

    this.renderer = new Renderer(this.scene, this.camera);
    this.hud = new Hud(elements.hud);
    this.badge = new ValidationBadge(elements.badge);
    this.chat = new Chat(elements.chatForm, elements.chatInput, elements.chatLog, {
      onSubmit: (prompt) => this.handlePrompt(prompt),
    });

    this.handleResize();
    globalThis.addEventListener("resize", this.handleResize);
    globalThis.addEventListener("keydown", this.handleKeyDown);
    globalThis.addEventListener("keyup", this.handleKeyUp);
    globalThis.addEventListener("blur", this.handleBlur);
    installDebugHook(this.engine);
  }

  get validatedDoc(): GameDoc | null {
    return this.lastValidatedDoc;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = this.now();
    this.frameHandle = this.requestFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  private handleResize = (): void => {
    const canvas = this.webgl.domElement;
    const width = canvas.clientWidth || globalThis.innerWidth;
    const height = canvas.clientHeight || globalThis.innerHeight;
    if (width === 0 || height === 0) return;
    this.webgl.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (isTextEntry(event.target)) return;
    if (PREVENT_DEFAULT_CODES.has(event.code)) event.preventDefault();
    this.keyboard.setKey(event.code, true);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keyboard.setKey(event.code, false);
  };

  private handleBlur = (): void => {
    this.keyboard.clear();
  };

  private loop = (): void => {
    if (!this.running) return;

    const now = this.now();
    const dt = Math.min(now - this.lastTime, 100);
    this.lastTime = now;

    if (this.lastValidatedDoc !== null) {
      let state = this.engine.getState();
      if (state.status === "running") {
        const input = toWorldInput(
          this.keyboard.toInput(),
          this.cameraForward(state)
        );
        state = this.engine.step(dt, input);
      }
      this.renderer.reconcile(state);
      this.hud.update(state);
      this.updateCamera(state);
    }

    this.webgl.render(this.scene, this.camera);
    this.frameHandle = this.requestFrame(this.loop);
  };

  /** Camera ground-forward `[x, z]` from the camera toward the player on XZ. */
  private cameraForward(state: GameState): [number, number] {
    const player = state.entities.find((entity) => entity.kind === "player");
    if (!player) return [0, -1];
    const position = state.entityRuntime[player.id]?.position ?? player.position;
    const dx = position[0] - this.camera.position.x;
    const dz = position[2] - this.camera.position.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return [0, -1];
    return [dx / length, dz / length];
  }

  private updateCamera(state: GameState): void {
    const player = state.entities.find((entity) => entity.kind === "player");
    if (!player) return;
    const position = state.entityRuntime[player.id]?.position ?? player.position;
    const target = new THREE.Vector3(position[0], position[1], position[2]);
    const desired = target.clone().add(new THREE.Vector3(6, 8, 12));
    this.camera.position.lerp(desired, 0.1);
    this.camera.lookAt(target);
  }

  private async handlePrompt(prompt: string): Promise<void> {
    if (this.lastValidatedDoc === null) {
      await this.generate(prompt);
    } else {
      await this.edit(prompt);
    }
  }

  private async generate(prompt: string): Promise<void> {
    const doc = await this.postJson<GameDoc>("/generate", { prompt });
    this.loadGame(doc);
    this.history.push(prompt);
    this.chat.appendMessage("system", `Loaded "${doc.meta.title}".`);
  }

  private async edit(prompt: string): Promise<void> {
    const result = await this.postJson<EditResponse>("/edit", {
      prompt,
      game: this.lastValidatedDoc,
      history: [...this.history],
    });
    this.loadGame(result.doc);
    this.history.push(prompt);
    this.chat.appendMessage("system", `Applied edit to "${result.doc.meta.title}".`);
  }

  private loadGame(doc: GameDoc): void {
    this.lastValidatedDoc = doc;
    this.engine.load(doc);
    applyWorldEnvironment(this.scene, doc.world);
    const state = this.engine.getState();
    this.badge.setValidated(true);
    this.hud.update(state);
    this.renderer.reconcile(state);
    this.lastTime = this.now();
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.apiBase + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not reach the server (${path}): ${message}`);
    }

    const text = await response.text();
    let payload: unknown;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Server returned invalid JSON (HTTP ${response.status})`);
      }
    }

    if (!response.ok) {
      throw new Error(errorMessage(payload, response.status));
    }
    if (payload === undefined) {
      throw new Error(`Empty response from ${path}`);
    }
    return payload as T;
  }
}

export function resolveElements(root: ParentNode): AppElements {
  const canvas = root.querySelector<HTMLCanvasElement>("#game");
  const chatForm = root.querySelector<HTMLFormElement>("#chat-form");
  const chatInput = root.querySelector<HTMLInputElement>("#chat-input");
  const chatLog = root.querySelector<HTMLElement>("#chat-log");
  const hud = root.querySelector<HTMLElement>("#hud");
  const badge = root.querySelector<HTMLElement>("#badge");

  const missing: string[] = [];
  if (!canvas) missing.push("#game");
  if (!chatForm) missing.push("#chat-form");
  if (!chatInput) missing.push("#chat-input");
  if (!chatLog) missing.push("#chat-log");
  if (!hud) missing.push("#hud");
  if (!badge) missing.push("#badge");
  if (
    missing.length > 0 ||
    !canvas ||
    !chatForm ||
    !chatInput ||
    !chatLog ||
    !hud ||
    !badge
  ) {
    throw new Error(`Missing required DOM elements: ${missing.join(", ")}`);
  }

  return { canvas, chatForm, chatInput, chatLog, hud, badge };
}

export function createApp(options: AppOptions = {}): App {
  return new App(resolveElements(document), options);
}
