import { describe, expect, test } from "vitest";
import { NEUTRAL_INPUT } from "@prompt-to-playable/engine";
import { createKeyboardState, toWorldInput } from "../src/ui/input.js";

function held(...codes: string[]) {
  const keyboard = createKeyboardState();
  for (const code of codes) keyboard.setKey(code, true);
  return keyboard;
}

describe("keyboard mapping", () => {
  test("W and ArrowUp move forward (moveZ +1)", () => {
    for (const code of ["KeyW", "ArrowUp"]) {
      const input = held(code).toInput();
      expect(input.moveZ).toBe(1);
      expect(input.moveX).toBe(0);
    }
  });

  test("S and ArrowDown move backward (moveZ -1)", () => {
    for (const code of ["KeyS", "ArrowDown"]) {
      const input = held(code).toInput();
      expect(input.moveZ).toBe(-1);
      expect(input.moveX).toBe(0);
    }
  });

  test("A and ArrowLeft move left (moveX -1)", () => {
    for (const code of ["KeyA", "ArrowLeft"]) {
      const input = held(code).toInput();
      expect(input.moveX).toBe(-1);
      expect(input.moveZ).toBe(0);
    }
  });

  test("D and ArrowRight move right (moveX +1)", () => {
    for (const code of ["KeyD", "ArrowRight"]) {
      const input = held(code).toInput();
      expect(input.moveX).toBe(1);
      expect(input.moveZ).toBe(0);
    }
  });

  test("Space jumps without moving", () => {
    const input = held("Space").toInput();
    expect(input.jump).toBe(true);
    expect(input.interact).toBe(false);
    expect(input.moveX).toBe(0);
    expect(input.moveZ).toBe(0);
  });

  test("KeyE interacts without moving", () => {
    const input = held("KeyE").toInput();
    expect(input.interact).toBe(true);
    expect(input.jump).toBe(false);
    expect(input.moveX).toBe(0);
    expect(input.moveZ).toBe(0);
  });

  test("diagonal W+D sets both axes to 1", () => {
    expect(held("KeyW", "KeyD").toInput()).toEqual({
      moveX: 1,
      moveZ: 1,
      jump: false,
      interact: false,
    });
  });

  test("conflicting axes cancel only while both keys are held", () => {
    expect(held("KeyW", "KeyS").toInput().moveZ).toBe(0);
    expect(held("KeyA", "KeyD").toInput().moveX).toBe(0);

    const keyboard = held("KeyW");
    keyboard.setKey("KeyS", true);
    expect(keyboard.toInput().moveZ).toBe(0);
    keyboard.setKey("KeyS", false);
    expect(keyboard.toInput().moveZ).toBe(1);
  });

  test("keyup releases a held key", () => {
    const keyboard = held("KeyD");
    keyboard.setKey("KeyD", false);
    expect(keyboard.toInput()).toEqual(NEUTRAL_INPUT);
  });

  test("unmapped codes are ignored", () => {
    expect(held("KeyQ", "ShiftLeft", "Enter").toInput()).toEqual(NEUTRAL_INPUT);
  });

  test("clear() returns to neutral from any combination", () => {
    const keyboard = held("KeyW", "KeyA", "Space", "KeyE");
    expect(keyboard.toInput()).not.toEqual(NEUTRAL_INPUT);
    keyboard.clear();
    expect(keyboard.toInput()).toEqual(NEUTRAL_INPUT);
  });

  test("repeated keydown is idempotent and missing keyup is not needed twice", () => {
    const keyboard = createKeyboardState();
    keyboard.setKey("KeyW", true);
    keyboard.setKey("KeyW", true);
    expect(keyboard.toInput().moveZ).toBe(1);
    keyboard.setKey("KeyW", false);
    expect(keyboard.toInput()).toEqual(NEUTRAL_INPUT);
  });

  test("toInput returns a valid sanitized InputState each call", () => {
    const keyboard = held("KeyW");
    const first = keyboard.toInput();
    const second = keyboard.toInput();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    for (const value of [first.moveX, first.moveZ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThanOrEqual(1);
    }
  });
});

describe("toWorldInput (camera-relative movement)", () => {
  const forward = (x: number, z: number) => [x, z] as const;

  test("camera behind at +Z (forward (0,-1)): W walks away, S toward, D right", () => {
    const behind = forward(0, -1);
    const w = toWorldInput({ ...NEUTRAL_INPUT, moveZ: 1 }, behind);
    expect(w.moveX).toBe(0);
    expect(w.moveZ).toBe(-1);

    const s = toWorldInput({ ...NEUTRAL_INPUT, moveZ: -1 }, behind);
    expect(s.moveX).toBe(0);
    expect(s.moveZ).toBe(1);

    const d = toWorldInput({ ...NEUTRAL_INPUT, moveX: 1 }, behind);
    expect(d.moveX).toBe(1);
    expect(d.moveZ).toBe(0);
  });

  test("diagonal forward: W+D yields a normalized world vector", () => {
    const world = toWorldInput(
      { ...NEUTRAL_INPUT, moveX: 1, moveZ: 1 },
      forward(-0.447, -0.894)
    );
    expect(world.moveX).toBeCloseTo(0.3162, 3);
    expect(world.moveZ).toBeCloseTo(-0.9487, 3);
    expect(Math.hypot(world.moveX, world.moveZ)).toBeCloseTo(1, 3);
  });

  test("degenerate forward (0,0) falls back to (0,-1)", () => {
    const w = toWorldInput({ ...NEUTRAL_INPUT, moveZ: 1 }, forward(0, 0));
    expect(w.moveX).toBe(0);
    expect(w.moveZ).toBe(-1);
  });

  test("jump and interact pass through unchanged", () => {
    const input = toWorldInput(
      { moveX: 0, moveZ: 1, jump: true, interact: true },
      forward(0, -1)
    );
    expect(input.jump).toBe(true);
    expect(input.interact).toBe(true);
  });
});
