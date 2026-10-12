export interface InputState {
  moveX: number;
  moveZ: number;
  jump: boolean;
  interact: boolean;
}

export const NEUTRAL_INPUT: InputState = {
  moveX: 0,
  moveZ: 0,
  jump: false,
  interact: false,
};

function clamp1(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(-1, Math.min(1, n));
}

export function sanitizeInput(input?: Partial<InputState>): InputState {
  return {
    moveX: clamp1(input?.moveX),
    moveZ: clamp1(input?.moveZ),
    jump: input?.jump === true,
    interact: input?.interact === true,
  };
}
