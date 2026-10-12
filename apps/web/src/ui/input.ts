import { sanitizeInput, type InputState } from "@prompt-to-playable/engine";

export interface KeyboardState {
  setKey(code: string, down: boolean): void;
  clear(): void;
  toInput(): InputState;
}

/** Codes whose default browser behavior (scrolling) is suppressed while playing. */
export const PREVENT_DEFAULT_CODES: ReadonlySet<string> = new Set([
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

const FORWARD_CODES = ["KeyW", "ArrowUp"];
const BACKWARD_CODES = ["KeyS", "ArrowDown"];
const LEFT_CODES = ["KeyA", "ArrowLeft"];
const RIGHT_CODES = ["KeyD", "ArrowRight"];

function pressed(held: ReadonlySet<string>, codes: readonly string[]): boolean {
  return codes.some((code) => held.has(code));
}

/** 1 when any positive code is held, -1 for negative, 0 when both or neither. */
function axis(
  held: ReadonlySet<string>,
  positive: readonly string[],
  negative: readonly string[]
): number {
  return (pressed(held, positive) ? 1 : 0) - (pressed(held, negative) ? 1 : 0);
}

/**
 * Pure keyboard-to-input mapping. Tracks held `KeyboardEvent.code` values and
 * derives a sanitized `InputState`; contains no DOM access so it is testable in
 * a plain node environment.
 */
export function createKeyboardState(): KeyboardState {
  const held = new Set<string>();

  return {
    setKey(code: string, down: boolean): void {
      if (down) {
        held.add(code);
      } else {
        held.delete(code);
      }
    },
    clear(): void {
      held.clear();
    },
    toInput(): InputState {
      return sanitizeInput({
        moveX: axis(held, RIGHT_CODES, LEFT_CODES),
        moveZ: axis(held, FORWARD_CODES, BACKWARD_CODES),
        jump: held.has("Space"),
        interact: held.has("KeyE"),
      });
    },
  };
}
