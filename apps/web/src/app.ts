import * as THREE from "three";
import { Engine, resolveMode, type GameState } from "@prompt-to-playable/engine";
import { applyWorldEnvironment, Renderer } from "@prompt-to-playable/render";
import type { GameDoc } from "@prompt-to-playable/schema";
import { Chat, isAbortError } from "./ui/chat.js";
import { Hud } from "./ui/hud.js";
import { ValidationBadge } from "./ui/badge.js";
import { GenerationProgress } from "./ui/progress.js";
import { Onboarding } from "./ui/onboarding.js";
import {
  audioCueFor,
  AudioPlayer,
  toAudioCueState,
  type AudioCueState,
} from "./ui/audio.js";
import {
  applyCameraFocus,
  CameraRig,
  chaseCameraPosition,
  clampDistance,
  clampPitch,
  firstPersonEye,
  firstPersonLookAt,
  INSPECT_DISTANCE,
  INSPECT_PITCH,
  resolveCameraMode,
  usesVehicleInput,
  type CameraMode,
  type FocusCameraState,
} from "./ui/camera-rig.js";
import {
  createKeyboardState,
  PREVENT_DEFAULT_CODES,
  toWorldInput,
} from "./ui/input.js";
import { hudForMode, interactPrompt } from "./ui/mode-hud.js";
import { Panels } from "./ui/panels.js";
import {
  gestureOutcome,
  hoverEdgeEvents,
  pickEntityId,
  type PointerSample,
} from "./ui/picking.js";

export interface AppElements {
  canvas: HTMLCanvasElement;
  chatForm: HTMLFormElement;
  chatInput: HTMLInputElement;
  chatLog: HTMLElement;
  hud: HTMLElement;
  badge: HTMLElement;
  examples: HTMLElement;
  emptyState: HTMLElement;
  progress: HTMLElement;
  progressStage: HTMLElement;
  progressTime: HTMLElement;
  progressCancel: HTMLButtonElement;
  /** Mode-specific control hint pill (also the static fallback before a load). */
  controls: HTMLElement;
  /** First-person reticle, hidden outside walkthrough mode. */
  crosshair: HTMLElement;
  /** Contextual "press E" chip, hidden when nothing is in interact range. */
  interactPrompt: HTMLElement;
  /** Speed / lap / time cluster, hidden outside drive mode. */
  driveHud: HTMLElement;
  driveSpeed: HTMLElement;
  driveLap: HTMLElement;
  driveTime: HTMLElement;
  /** Overlay for `state.ui.panels` cards. */
  panels: HTMLElement;
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
  private readonly onboarding: Onboarding;
  private readonly progress: GenerationProgress;
  private readonly panels: Panels;
  private readonly keyboard = createKeyboardState();
  private readonly cameraRig = new CameraRig();
  private readonly audio = new AudioPlayer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly dom: AppElements;
  private previousCueState: AudioCueState | null = null;

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
  private abortController: AbortController | null = null;
  private dragPointerId: number | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private cameraMode: CameraMode = "orbit";
  private hoveredId: string | null = null;
  private gestureStart: PointerSample | null = null;
  private modeLines: string | null = null;
  private interactLine: string | null = null;
  private focusState: FocusCameraState = { active: false, savedDistance: null };

  constructor(elements: AppElements, options: AppOptions = {}) {
    this.dom = elements;
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
    this.progress = new GenerationProgress(
      {
        root: elements.progress,
        stage: elements.progressStage,
        time: elements.progressTime,
        cancel: elements.progressCancel,
      },
      { onCancel: () => this.abortController?.abort() }
    );
    this.onboarding = new Onboarding(
      { examples: elements.examples, emptyState: elements.emptyState },
      { onPick: (prompt) => this.chat.send(prompt) }
    );
    this.panels = new Panels(elements.panels, {
      onClose: (id) => this.closePanel(id),
    });

    this.handleResize();
    globalThis.addEventListener("resize", this.handleResize);
    globalThis.addEventListener("keydown", this.handleKeyDown);
    globalThis.addEventListener("keyup", this.handleKeyUp);
    globalThis.addEventListener("blur", this.handleBlur);
    globalThis.addEventListener("pointerdown", this.handleUserGesture);
    globalThis.addEventListener("keydown", this.handleUserGesture);

    elements.canvas.addEventListener("pointerdown", this.handlePointerDown);
    elements.canvas.addEventListener("pointermove", this.handlePointerMove);
    elements.canvas.addEventListener("pointerup", this.handlePointerUp);
    elements.canvas.addEventListener("pointercancel", this.handlePointerCancel);
    elements.canvas.addEventListener("pointerleave", this.handlePointerLeave);
    elements.canvas.addEventListener("wheel", this.handleWheel, {
      passive: false,
    });
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

  /** Autoplay policy: the AudioContext may only be created from a gesture. */
  private handleUserGesture = (): void => {
    this.audio.resume();
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.dragPointerId = event.pointerId;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.gestureStart = {
      x: event.clientX,
      y: event.clientY,
      time: this.now(),
    };
    this.cameraRig.beginDrag();
    this.clearHover();
    try {
      event.target instanceof Element &&
        event.target.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is best-effort (synthetic or already-released pointers).
    }
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.dragPointerId !== null) {
      if (event.pointerId !== this.dragPointerId) return;
      const dx = event.clientX - this.lastPointerX;
      const dy = event.clientY - this.lastPointerY;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      // The chase camera owns its orientation; orbit/first-person drag looks.
      if (this.cameraMode !== "chase") {
        this.cameraRig.drag(dx, dy, this.cameraMode);
      }
      return;
    }
    this.updateHover(event);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    this.endPointerGesture(event, false);
  };

  private handlePointerCancel = (event: PointerEvent): void => {
    this.endPointerGesture(event, true);
  };

  /**
   * Shared release path for pointerup and pointercancel. Cancelled gestures
   * abort the press without ever pushing a click.
   */
  private endPointerGesture(event: PointerEvent, cancelled: boolean): void {
    if (this.dragPointerId === null || event.pointerId !== this.dragPointerId) {
      return;
    }
    this.dragPointerId = null;
    this.cameraRig.endDrag();
    const down = this.gestureStart;
    this.gestureStart = null;
    if (this.lastValidatedDoc === null) return;
    const up = { x: event.clientX, y: event.clientY, time: this.now() };
    if (gestureOutcome(down, up, cancelled) !== "click") return;
    const id = this.pickEntity(event.clientX, event.clientY);
    if (id !== null) this.engine.pushEvent({ type: "click", targetId: id });
  };

  private handlePointerLeave = (): void => {
    if (this.dragPointerId === null) this.clearHover();
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (this.cameraMode === "chase") return;
    this.cameraRig.zoom(event.deltaY);
  };

  /** Highlights the entity under an idle pointer (hover only, no dragging). */
  private updateHover(event: PointerEvent): void {
    if (this.lastValidatedDoc === null) return;
    this.setHovered(this.pickEntity(event.clientX, event.clientY));
  }

  private clearHover(): void {
    this.setHovered(null);
  }

  /**
   * Single hover transition point: updates the highlight and cursor, then
   * pushes hoverLeave (previous) and hoverEnter (next) to the engine.
   * Change-only throttling keeps the queue quiet while the pointer moves
   * within one entity.
   */
  private setHovered(id: string | null): void {
    if (id === this.hoveredId) return;
    const previous = this.hoveredId;
    this.hoveredId = id;
    this.renderer.setHighlight(id);
    this.webgl.domElement.style.cursor = id === null ? "" : "pointer";
    for (const event of hoverEdgeEvents(previous, id)) {
      this.engine.pushEvent(event);
    }
  }

  /** Drops hover visuals without hover edges (a reload resets engine state). */
  private resetHover(): void {
    this.hoveredId = null;
    this.renderer.setHighlight(null);
    this.webgl.domElement.style.cursor = "";
  }

  /** Nearest entity id under a client-space point, or null. */
  private pickEntity(clientX: number, clientY: number): string | null {
    const rect = this.webgl.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    return pickEntityId(this.raycaster, this.camera, this.scene.children, {
      x,
      y,
    });
  }

  private closePanel(id: string): void {
    if (this.lastValidatedDoc === null) return;
    this.engine.closePanel(id);
    this.panels.update(this.engine.getState().ui.panels);
  }

  private loop = (): void => {
    if (!this.running) return;

    const now = this.now();
    const dt = Math.min(now - this.lastTime, 100);
    this.lastTime = now;

    if (this.lastValidatedDoc !== null) {
      let state = this.engine.getState();
      if (state.status === "running") {
        const raw = this.keyboard.toInput();
        const input = this.usesVehicleControls(state)
          ? raw
          : toWorldInput(raw, this.cameraRig.forwardGround());
        state = this.engine.step(dt, input);
      }
      this.renderer.reconcile(state);
      this.hud.update(state);
      this.panels.update(state.ui.panels);
      this.updateModeHud(state);
      this.updateInteractPrompt(state);
      this.updateCamera(state, dt / 1000);
      this.updateAudio(state);
    }

    this.webgl.render(this.scene, this.camera);
    this.frameHandle = this.requestFrame(this.loop);
  }

  /** Mode-specific control hint, crosshair and drive readouts. */
  private updateModeHud(state: GameState): void {
    const mode = resolveMode(state.doc);
    const view = hudForMode(mode, state);

    const lines = view.lines.join(" · ");
    if (lines !== this.modeLines) {
      this.modeLines = lines;
      this.dom.controls.textContent = lines;
    }
    this.dom.crosshair.hidden = !view.crosshair;

    const driving = mode === "drive";
    this.dom.driveHud.hidden = !driving;
    if (!driving) return;
    this.dom.driveSpeed.textContent = `${view.speedKmh ?? 0} km/h`;
    this.dom.driveLap.textContent =
      view.lap === undefined ? "Lap —" : `Lap ${view.lap}`;
    this.dom.driveTime.textContent = `${(view.time ?? 0).toFixed(1)}s`;
  }

  /**
   * Vehicles consume raw throttle/steer (`moveZ`/`moveX`) and own their
   * heading, so their input must not be rotated into world space. Every other
   * player kind moves camera-relative.
   */
  private usesVehicleControls(state: GameState): boolean {
    const player = state.entities.find((entity) => entity.kind === "player");
    return usesVehicleInput(this.cameraMode, player?.props?.vehicle === true);
  }

  private updateAudio(state: GameState): void {
    const next = toAudioCueState(state);
    const cue = audioCueFor(this.previousCueState, next);
    this.previousCueState = next;
    if (cue !== null) this.audio.play(cue);
  }

  /**
   * Contextual interact chip. Recomputes the mirrored engine selection every
   * frame but only touches the DOM when the copy changes. Won/lost states are
   * skipped because the engine is no longer stepped, so E could not fire.
   */
  private updateInteractPrompt(state: GameState): void {
    const line = state.status === "running" ? interactPrompt(state) : null;
    if (line === this.interactLine) return;
    this.interactLine = line;
    this.dom.interactPrompt.hidden = line === null;
    this.dom.interactPrompt.textContent = line ?? "";
  }

  /**
   * Mode-dependent camera update. Orbit and chase ease toward their desired
   * positions with `position.lerp` so the renderer's lose-shake offsets
   * (applied during `reconcile` and undone at the next one) compose without
   * accumulating.
   *
   * - orbit: existing rig behavior (inspect keeps its closer defaults; an
   *   active `ui.focus` frames that entity and eases the distance toward
   *   `FOCUS_DISTANCE`, restoring the pre-focus distance when cleared);
   * - firstPerson: eye snapped directly to the player + eye height (no trail),
   *   looking along rig yaw/pitch immediately;
   * - chase: fixed distance behind the vehicle heading, no orbit drag.
   */
  private updateCamera(state: GameState, dtSeconds: number): void {
    const player = state.entities.find((entity) => entity.kind === "player");
    const runtime = player ? state.entityRuntime[player.id] : undefined;
    const origin: [number, number, number] = [0, 0, 0];
    const position = runtime?.position ?? player?.position ?? origin;
    const px = position[0];
    const py = position[1];
    const pz = position[2];

    if (this.cameraMode === "firstPerson") {
      if (!player) return;
      const eye = firstPersonEye([px, py, pz]);
      const look = firstPersonLookAt(
        eye,
        this.cameraRig.yaw,
        this.cameraRig.pitch
      );
      // First person must not trail the player: snap the eye to the target
      // and apply the look immediately (no positional lag while walking).
      this.camera.position.set(eye[0], eye[1], eye[2]);
      this.camera.lookAt(look[0], look[1], look[2]);
      return;
    }

    if (this.cameraMode === "chase") {
      if (!player) return;
      const heading = runtime?.heading ?? player.rotation?.[1] ?? 0;
      const desired = chaseCameraPosition([px, py, pz], heading);
      this.camera.position.lerp(
        new THREE.Vector3(desired[0], desired[1], desired[2]),
        0.15
      );
      this.camera.lookAt(px, py + 1, pz);
      return;
    }

    this.cameraRig.update(dtSeconds);
    const focusEntity =
      state.ui.focus === undefined
        ? undefined
        : state.entities.find((entity) => entity.id === state.ui.focus);
    const focusPosition = focusEntity
      ? state.entityRuntime[focusEntity.id]?.position ?? focusEntity.position
      : undefined;
    const focus = applyCameraFocus(
      this.focusState,
      state.ui.focus,
      focusPosition,
      this.cameraRig.distance,
      dtSeconds
    );
    this.focusState = focus.state;
    this.cameraRig.distance = focus.distance;
    const targetPosition: [number, number, number] = focus.target ?? [px, py, pz];
    const target = new THREE.Vector3(
      targetPosition[0],
      targetPosition[1],
      targetPosition[2]
    );
    const desired = this.cameraRig.desiredPosition(targetPosition);
    this.camera.position.lerp(
      new THREE.Vector3(desired[0], desired[1], desired[2]),
      0.1
    );
    this.camera.lookAt(target);
  }

  private async handlePrompt(prompt: string): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    this.progress.start();
    this.onboarding.setBusy(true);
    try {
      if (this.lastValidatedDoc === null) {
        await this.generate(prompt, controller.signal);
      } else {
        await this.edit(prompt, controller.signal);
      }
    } finally {
      if (this.abortController === controller) this.abortController = null;
      this.progress.stop();
      this.onboarding.setBusy(false);
    }
  }

  private async generate(prompt: string, signal: AbortSignal): Promise<void> {
    const doc = await this.postJson<GameDoc>("/generate", { prompt }, signal);
    this.loadGame(doc);
    this.history.push(prompt);
    this.chat.appendMessage("system", `Loaded "${doc.meta.title}".`);
  }

  private async edit(prompt: string, signal: AbortSignal): Promise<void> {
    const result = await this.postJson<EditResponse>(
      "/edit",
      {
        prompt,
        game: this.lastValidatedDoc,
        history: [...this.history],
      },
      signal
    );
    this.loadGame(result.doc);
    this.history.push(prompt);
    this.chat.appendMessage("system", `Applied edit to "${result.doc.meta.title}".`);
  }

  private loadGame(doc: GameDoc): void {
    this.lastValidatedDoc = doc;
    this.engine.load(doc);
    applyWorldEnvironment(this.scene, doc.world);
    this.cameraRig.reset();
    this.focusState = { active: false, savedDistance: null };
    const mode = resolveMode(doc);
    const player = doc.entities.find((entity) => entity.kind === "player");
    this.cameraMode = resolveCameraMode(doc, player?.props?.vehicle === true);
    if (mode === "inspect") {
      this.cameraRig.distance = clampDistance(INSPECT_DISTANCE);
      this.cameraRig.pitch = clampPitch(INSPECT_PITCH);
    } else if (this.cameraMode === "firstPerson") {
      // Orbit's default pitch looks down at the player; first person starts
      // level and lets the drag adjust from there.
      this.cameraRig.pitch = 0;
    }
    this.modeLines = null;
    this.previousCueState = null;
    this.resetHover();
    this.interactLine = null;
    this.dom.interactPrompt.hidden = true;
    this.dom.interactPrompt.textContent = "";
    const state = this.engine.getState();
    this.badge.setValidated(true);
    this.hud.update(state);
    this.panels.update(state.ui.panels);
    this.updateModeHud(state);
    this.renderer.reconcile(state);
    this.lastTime = this.now();
    this.onboarding.complete();
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.apiBase + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
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
  const examples = root.querySelector<HTMLElement>("#examples");
  const emptyState = root.querySelector<HTMLElement>("#empty-state");
  const progress = root.querySelector<HTMLElement>("#progress");
  const progressStage = root.querySelector<HTMLElement>("#progress-stage");
  const progressTime = root.querySelector<HTMLElement>("#progress-time");
  const progressCancel = root.querySelector<HTMLButtonElement>("#progress-cancel");
  const controls = root.querySelector<HTMLElement>("#controls");
  const crosshair = root.querySelector<HTMLElement>("#crosshair");
  const interactPrompt = root.querySelector<HTMLElement>("#interact-prompt");
  const driveHud = root.querySelector<HTMLElement>("#drive-hud");
  const driveSpeed = root.querySelector<HTMLElement>("#drive-speed");
  const driveLap = root.querySelector<HTMLElement>("#drive-lap");
  const driveTime = root.querySelector<HTMLElement>("#drive-time");
  const panels = root.querySelector<HTMLElement>("#panels");

  const missing: string[] = [];
  if (!canvas) missing.push("#game");
  if (!chatForm) missing.push("#chat-form");
  if (!chatInput) missing.push("#chat-input");
  if (!chatLog) missing.push("#chat-log");
  if (!hud) missing.push("#hud");
  if (!badge) missing.push("#badge");
  if (!examples) missing.push("#examples");
  if (!emptyState) missing.push("#empty-state");
  if (!progress) missing.push("#progress");
  if (!progressStage) missing.push("#progress-stage");
  if (!progressTime) missing.push("#progress-time");
  if (!progressCancel) missing.push("#progress-cancel");
  if (!controls) missing.push("#controls");
  if (!crosshair) missing.push("#crosshair");
  if (!interactPrompt) missing.push("#interact-prompt");
  if (!driveHud) missing.push("#drive-hud");
  if (!driveSpeed) missing.push("#drive-speed");
  if (!driveLap) missing.push("#drive-lap");
  if (!driveTime) missing.push("#drive-time");
  if (!panels) missing.push("#panels");
  if (
    missing.length > 0 ||
    !canvas ||
    !chatForm ||
    !chatInput ||
    !chatLog ||
    !hud ||
    !badge ||
    !examples ||
    !emptyState ||
    !progress ||
    !progressStage ||
    !progressTime ||
    !progressCancel ||
    !controls ||
    !crosshair ||
    !interactPrompt ||
    !driveHud ||
    !driveSpeed ||
    !driveLap ||
    !driveTime ||
    !panels
  ) {
    throw new Error(`Missing required DOM elements: ${missing.join(", ")}`);
  }

  return {
    canvas,
    chatForm,
    chatInput,
    chatLog,
    hud,
    badge,
    examples,
    emptyState,
    progress,
    progressStage,
    progressTime,
    progressCancel,
    controls,
    crosshair,
    interactPrompt,
    driveHud,
    driveSpeed,
    driveLap,
    driveTime,
    panels,
  };
}

export function createApp(options: AppOptions = {}): App {
  return new App(resolveElements(document), options);
}
