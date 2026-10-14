import type { GameState, GameStatus } from "@prompt-to-playable/engine";

/**
 * Pure audio layer. `audioCueFor` maps successive engine snapshots to a cue
 * name; `AudioPlayer` turns those names into small WebAudio oscillator/gain
 * envelopes. There are no audio files and no runtime dependencies: a missing
 * or blocked AudioContext makes every method a safe no-op, so node tests and
 * autoplay-restricted browsers can import this module freely.
 */
export type AudioCue = "collect" | "hit" | "jump" | "interact" | "win" | "lose";

/** Snapshot of the state facts the cue mapping depends on. */
export interface AudioCueState {
  status: GameStatus;
  entityIds: readonly string[];
  jump: boolean;
  interact: boolean;
  /** Numeric `scratch.health`, or null when the game tracks no health. */
  health: number | null;
  /** Sum of numeric `scratch["damage.*"]` counters. */
  damage: number;
  /** True when the snapshot carries an `enemyContact` event. */
  contact: boolean;
}

function damageTotal(scratch: GameState["scratch"]): number {
  let total = 0;
  for (const key of Object.keys(scratch)) {
    const value = scratch[key];
    if (key.startsWith("damage.") && typeof value === "number") total += value;
  }
  return total;
}

/** Derives the pure cue snapshot from a full engine state. */
export function toAudioCueState(state: GameState): AudioCueState {
  const health = state.scratch.health;
  return {
    status: state.status,
    entityIds: state.entities.map((entity) => entity.id),
    jump: state.input.jump,
    interact: state.input.interact,
    health: typeof health === "number" ? health : null,
    damage: damageTotal(state.scratch),
    contact: state.events.some((event) => event.type === "enemyContact"),
  };
}

function entityDisappeared(prev: AudioCueState, next: AudioCueState): boolean {
  const present = new Set(next.entityIds);
  return prev.entityIds.some((id) => !present.has(id));
}

function tookDamage(prev: AudioCueState, next: AudioCueState): boolean {
  if (prev.health !== null && next.health !== null && next.health < prev.health) {
    return true;
  }
  if (next.damage > prev.damage) return true;
  return next.contact && !prev.contact;
}

/**
 * Pure state-diff to cue mapping. Returns at most one cue per transition and
 * null when nothing noteworthy changed. Status flips dominate (a final collect
 * still plays the win cue), then damage, then entity removal (pickup/despawn),
 * then the jump/interact input rising edges. `prev === null` is the first
 * snapshot after a load and never emits.
 */
export function audioCueFor(
  prev: AudioCueState | null,
  next: AudioCueState
): AudioCue | null {
  if (prev === null) return null;
  if (next.status !== prev.status) {
    if (next.status === "won") return "win";
    if (next.status === "lost") return "lose";
  }
  if (tookDamage(prev, next)) return "hit";
  if (entityDisappeared(prev, next)) return "collect";
  if (next.jump && !prev.jump) return "jump";
  if (next.interact && !prev.interact) return "interact";
  return null;
}

interface ToneSpec {
  type: OscillatorType;
  from: number;
  to: number;
  duration: number;
  gain: number;
  /** Seconds after `currentTime` when the tone starts. */
  delay?: number;
  attack?: number;
}

export interface AudioPlayerOptions {
  /** Context factory seam for tests; defaults to the global AudioContext. */
  createContext?: () => AudioContext | null;
}

type AudioContextConstructor = new () => AudioContext;

function defaultCreateContext(): AudioContext | null {
  const scope = globalThis as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Constructor) return null;
  try {
    return new Constructor();
  } catch {
    return null;
  }
}

function isPromiseLike(
  value: unknown
): value is { catch: (handler: () => void) => unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { catch?: unknown }).catch === "function"
  );
}

/**
 * Thin WebAudio synthesizer for the cue set. The AudioContext is created on
 * the first `resume()` call (which the app triggers from a user gesture, per
 * autoplay policy) and never at construction time. When the context is
 * missing, creation throws or playback is blocked, every method degrades to a
 * silent no-op.
 */
export class AudioPlayer {
  private context: AudioContext | null = null;
  private disabled = false;
  private readonly createContext: () => AudioContext | null;

  constructor(options: AudioPlayerOptions = {}) {
    this.createContext = options.createContext ?? defaultCreateContext;
  }

  /** True once a live AudioContext exists. */
  get enabled(): boolean {
    return this.context !== null;
  }

  /** Lazily creates the context and resumes it; safe to call repeatedly. */
  resume(): void {
    const context = this.ensureContext();
    if (!context || context.state !== "suspended") return;
    try {
      const result: unknown = context.resume();
      if (isPromiseLike(result)) result.catch(() => undefined);
    } catch {
      this.disabled = true;
    }
  }

  /** Plays one cue; a no-op before `resume()` or without WebAudio support. */
  play(cue: AudioCue): void {
    const context = this.context;
    if (!context) return;
    try {
      switch (cue) {
        case "collect":
          this.tone(context, { type: "triangle", from: 520, to: 1040, duration: 0.14, gain: 0.22 });
          this.tone(context, { type: "sine", from: 780, to: 1560, duration: 0.14, gain: 0.1, delay: 0.02 });
          break;
        case "hit":
          this.tone(context, { type: "sawtooth", from: 180, to: 70, duration: 0.22, gain: 0.26 });
          this.tone(context, { type: "square", from: 90, to: 55, duration: 0.22, gain: 0.1 });
          break;
        case "jump":
          this.tone(context, { type: "sine", from: 320, to: 760, duration: 0.12, gain: 0.2 });
          break;
        case "interact":
          this.tone(context, { type: "square", from: 1100, to: 1100, duration: 0.05, gain: 0.14, attack: 0.004 });
          break;
        case "win":
          [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
            this.tone(context, {
              type: "triangle",
              from: frequency,
              to: frequency,
              duration: 0.16,
              gain: 0.18,
              delay: index * 0.11,
            });
          });
          break;
        case "lose":
          this.tone(context, { type: "sawtooth", from: 440, to: 110, duration: 0.6, gain: 0.2 });
          this.tone(context, { type: "triangle", from: 220, to: 55, duration: 0.6, gain: 0.14, delay: 0.05 });
          break;
      }
    } catch {
      // A closed/blocked context only ever costs sound, never the frame.
    }
  }

  /** Closes the context if one exists; further resume() calls stay disabled. */
  dispose(): void {
    const context = this.context;
    this.context = null;
    this.disabled = true;
    if (!context) return;
    try {
      const result: unknown = context.close();
      if (isPromiseLike(result)) result.catch(() => undefined);
    } catch {
      // Already closed or unsupported.
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    if (this.disabled) return null;
    let context: AudioContext | null;
    try {
      context = this.createContext();
    } catch {
      context = null;
    }
    if (!context) {
      this.disabled = true;
      return null;
    }
    this.context = context;
    return context;
  }

  private tone(context: AudioContext, spec: ToneSpec): void {
    const start = context.currentTime + (spec.delay ?? 0);
    const end = start + spec.duration;
    const attack = Math.min(spec.attack ?? 0.01, spec.duration / 2);
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = spec.type;
    oscillator.frequency.setValueAtTime(Math.max(1, spec.from), start);
    if (spec.to !== spec.from) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(1, spec.to),
        end
      );
    }

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, spec.gain),
      start + attack
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }
}
