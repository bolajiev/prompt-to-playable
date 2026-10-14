import { describe, expect, test, vi } from "vitest";
import { createState, type GameEvent } from "@prompt-to-playable/engine";
import { validateGame, type GameDoc } from "@prompt-to-playable/schema";
import {
  audioCueFor,
  AudioPlayer,
  toAudioCueState,
  type AudioCue,
  type AudioCueState,
} from "../src/ui/audio.js";

function cueState(overrides: Partial<AudioCueState> = {}): AudioCueState {
  return {
    status: "running",
    entityIds: ["player", "gem"],
    jump: false,
    interact: false,
    health: null,
    damage: 0,
    contact: false,
    ...overrides,
  };
}

describe("audioCueFor (state-diff mapping)", () => {
  test("no change yields no cue", () => {
    expect(audioCueFor(cueState(), cueState())).toBeNull();
  });

  test("first snapshot never emits", () => {
    expect(audioCueFor(null, cueState())).toBeNull();
    expect(
      audioCueFor(null, cueState({ status: "won", jump: true, interact: true }))
    ).toBeNull();
  });

  test("an entity disappearing maps to collect", () => {
    expect(
      audioCueFor(cueState(), cueState({ entityIds: ["player"] }))
    ).toBe("collect");
  });

  test("same entity count with a replacement still maps to collect", () => {
    expect(
      audioCueFor(
        cueState({ entityIds: ["player", "gem"] }),
        cueState({ entityIds: ["player", "enemy"] })
      )
    ).toBe("collect");
  });

  test("an entity appearing does not emit", () => {
    expect(
      audioCueFor(
        cueState({ entityIds: ["player"] }),
        cueState({ entityIds: ["player", "enemy"] })
      )
    ).toBeNull();
  });

  test("status flip to won maps to win and to lost maps to lose", () => {
    expect(audioCueFor(cueState(), cueState({ status: "won" }))).toBe("win");
    expect(audioCueFor(cueState(), cueState({ status: "lost" }))).toBe("lose");
  });

  test("status flip dominates same-tick collect or damage", () => {
    expect(
      audioCueFor(
        cueState(),
        cueState({ status: "won", entityIds: ["player"], damage: 5 })
      )
    ).toBe("win");
    expect(
      audioCueFor(cueState(), cueState({ status: "lost", health: 0 }))
    ).toBe("lose");
  });

  test("health loss maps to hit", () => {
    expect(
      audioCueFor(cueState({ health: 3 }), cueState({ health: 2 }))
    ).toBe("hit");
  });

  test("health gain and null-to-number leave health silent", () => {
    expect(
      audioCueFor(cueState({ health: 2 }), cueState({ health: 3 }))
    ).toBeNull();
    expect(audioCueFor(cueState(), cueState({ health: 3 }))).toBeNull();
    expect(audioCueFor(cueState({ health: 3 }), cueState())).toBeNull();
  });

  test("a rising damage counter maps to hit", () => {
    expect(
      audioCueFor(cueState({ damage: 1 }), cueState({ damage: 2 }))
    ).toBe("hit");
  });

  test("only a rising enemyContact edge maps to hit", () => {
    expect(audioCueFor(cueState(), cueState({ contact: true }))).toBe("hit");
    expect(
      audioCueFor(cueState({ contact: true }), cueState({ contact: true }))
    ).toBeNull();
    expect(
      audioCueFor(cueState({ contact: true }), cueState({ contact: false }))
    ).toBeNull();
  });

  test("jump and interact emit only on their rising edges", () => {
    expect(audioCueFor(cueState(), cueState({ jump: true }))).toBe("jump");
    expect(
      audioCueFor(cueState({ jump: true }), cueState({ jump: true }))
    ).toBeNull();
    expect(
      audioCueFor(cueState({ jump: true }), cueState({ jump: false }))
    ).toBeNull();

    expect(audioCueFor(cueState(), cueState({ interact: true }))).toBe("interact");
  });

  test("hit outranks collect, collect outranks jump", () => {
    expect(
      audioCueFor(
        cueState({ health: 2 }),
        cueState({ health: 1, entityIds: ["player"] })
      )
    ).toBe("hit");
    expect(
      audioCueFor(
        cueState(),
        cueState({ entityIds: ["player"], jump: true })
      )
    ).toBe("collect");
  });

  test("mapping is pure: inputs are not mutated", () => {
    const prev = cueState({ health: 2 });
    const next = cueState({ health: 1, jump: true });
    const prevCopy = structuredClone(prev);
    const nextCopy = structuredClone(next);
    audioCueFor(prev, next);
    expect(prev).toEqual(prevCopy);
    expect(next).toEqual(nextCopy);
  });
});

function tinyDoc(): GameDoc {
  const result = validateGame({
    version: "1.0.0",
    meta: { title: "Tiny Room", archetype: "collect-a-thon" },
    world: { bounds: [20, 10, 20] },
    entities: [{ id: "player", kind: "player", position: [0, 1, 0] }],
    objectives: [],
    rules: [],
    scratch: { health: 3, "damage.goblin": 1, score: 0 },
  });
  if (!result.ok || !result.data) {
    throw new Error("tiny doc failed schema validation");
  }
  return result.data;
}

describe("toAudioCueState", () => {
  test("derives status, entity ids, input edges and damage facts", () => {
    const state = createState(tinyDoc());
    const next = {
      ...state,
      status: "running" as const,
      input: { ...state.input, jump: true },
      scratch: { ...state.scratch, health: 2, "damage.goblin": 4 },
      events: [
        { type: "enemyContact", entityId: "goblin", targetId: "player" },
      ] as GameEvent[],
    };

    const snapshot = toAudioCueState(next);
    expect(snapshot.status).toBe("running");
    expect(snapshot.entityIds).toEqual(["player"]);
    expect(snapshot.jump).toBe(true);
    expect(snapshot.interact).toBe(false);
    expect(snapshot.health).toBe(2);
    expect(snapshot.damage).toBe(4);
    expect(snapshot.contact).toBe(true);
  });

  test("health stays null when the scratch variable is absent or non-numeric", () => {
    const state = createState(tinyDoc());
    expect(
      toAudioCueState({ ...state, scratch: { ...state.scratch, health: "full" } })
        .health
    ).toBeNull();
    expect(toAudioCueState({ ...state, scratch: {} }).health).toBeNull();
  });

  test("feeding engine snapshots into audioCueFor produces gameplay cues", () => {
    const base = createState(tinyDoc());
    const prev = toAudioCueState(base);
    const hurt = {
      ...base,
      scratch: { ...base.scratch, health: 2 },
    };
    expect(audioCueFor(prev, toAudioCueState(hurt))).toBe("hit");

    const won = { ...base, status: "won" as const };
    expect(audioCueFor(prev, toAudioCueState(won))).toBe("win");
  });
});

interface ParamCall {
  method: "set" | "linear" | "exponential";
  value: number;
  time: number;
}

class FakeParam {
  readonly calls: ParamCall[] = [];
  setValueAtTime(value: number, time: number): FakeParam {
    this.calls.push({ method: "set", value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): FakeParam {
    this.calls.push({ method: "linear", value, time });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): FakeParam {
    this.calls.push({ method: "exponential", value, time });
    return this;
  }
}

class FakeOscillator {
  type: OscillatorType = "sine";
  readonly frequency = new FakeParam();
  started = false;
  stopped = false;
  disconnected = false;
  onended: (() => void) | null = null;
  connect(_node: unknown): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  start(_when?: number): void {
    this.started = true;
  }
  stop(_when?: number): void {
    this.stopped = true;
  }
}

class FakeGain {
  readonly gain = new FakeParam();
  disconnected = false;
  connect(_node: unknown): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeAudioContext {
  state: AudioContextState = "suspended";
  currentTime = 0;
  readonly destination = {};
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  resumeCalls = 0;
  closeCalls = 0;
  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = "running";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCalls++;
    this.state = "closed";
    return Promise.resolve();
  }
}

function asContext(fake: FakeAudioContext): AudioContext {
  return fake as unknown as AudioContext;
}

describe("AudioPlayer", () => {
  test("creates the context lazily on resume and only once", () => {
    const fake = new FakeAudioContext();
    const createContext = vi.fn(() => asContext(fake));
    const player = new AudioPlayer({ createContext });

    expect(player.enabled).toBe(false);
    expect(createContext).not.toHaveBeenCalled();

    player.play("collect");
    expect(createContext).not.toHaveBeenCalled();

    player.resume();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(fake.resumeCalls).toBe(1);
    expect(player.enabled).toBe(true);

    player.resume();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(fake.resumeCalls).toBe(1);
  });

  test("synthesizes every cue with scheduled oscillator/gain nodes", () => {
    const fake = new FakeAudioContext();
    const player = new AudioPlayer({ createContext: () => asContext(fake) });
    player.resume();

    const cues: AudioCue[] = ["collect", "hit", "jump", "interact", "win", "lose"];
    for (const cue of cues) {
      const before = fake.oscillators.length;
      player.play(cue);
      expect(fake.oscillators.length).toBeGreaterThan(before);
    }

    expect(fake.gains.length).toBe(fake.oscillators.length);
    for (const oscillator of fake.oscillators) {
      expect(oscillator.started).toBe(true);
      expect(oscillator.stopped).toBe(true);
      expect(oscillator.frequency.calls.length).toBeGreaterThan(0);
    }
    for (const gain of fake.gains) {
      expect(gain.gain.calls.length).toBeGreaterThan(0);
    }
  });

  test("no-ops safely when WebAudio is unavailable", () => {
    const player = new AudioPlayer({ createContext: () => null });
    const cues: AudioCue[] = ["collect", "hit", "jump", "interact", "win", "lose"];

    expect(() => {
      player.resume();
      for (const cue of cues) player.play(cue);
    }).not.toThrow();
    expect(player.enabled).toBe(false);
  });

  test("a throwing context factory disables audio instead of breaking the frame", () => {
    const player = new AudioPlayer({
      createContext: () => {
        throw new Error("blocked by autoplay policy");
      },
    });
    expect(() => player.resume()).not.toThrow();
    expect(() => player.play("win")).not.toThrow();
    expect(player.enabled).toBe(false);
  });

  test("a rejected resume promise is swallowed", async () => {
    const fake = new FakeAudioContext();
    fake.resume = () => Promise.reject(new Error("not allowed"));
    const player = new AudioPlayer({ createContext: () => asContext(fake) });
    player.resume();
    await Promise.resolve();
    expect(() => player.play("collect")).not.toThrow();
  });

  test("dispose closes the context and prevents recreation", () => {
    const fake = new FakeAudioContext();
    const createContext = vi.fn(() => asContext(fake));
    const player = new AudioPlayer({ createContext });
    player.resume();
    player.dispose();

    expect(fake.closeCalls).toBe(1);
    expect(player.enabled).toBe(false);
    expect(() => player.dispose()).not.toThrow();

    player.resume();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(player.enabled).toBe(false);
  });
});
