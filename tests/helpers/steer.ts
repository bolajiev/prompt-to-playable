import {
  FIXED_DT_MS,
  type Engine,
  type GameState,
  type InputState,
} from "@prompt-to-playable/engine";
import type { Vec3 } from "@prompt-to-playable/schema";

export const STEER_STOP_DISTANCE = 0.5;
export const STEER_INTERACT_DISTANCE = 1.5;

const INTERACT_TICKS = 3;
const JUMP_RISE = 0.5;
const STALL_WINDOW_TICKS = 10;
const STALL_MIN_PROGRESS = 0.05;
const SIDESTEP_TICKS = 20;

function xzDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function playerRuntime(
  state: GameState
): { position: Vec3; grounded: boolean } | undefined {
  const player = state.entities.find((entity) => entity.kind === "player");
  if (!player) return undefined;
  const runtime = state.entityRuntime[player.id];
  if (!runtime) return undefined;
  return { position: runtime.position, grounded: runtime.grounded };
}

/**
 * Steer the active player toward `target` using only `engine.getState()` and
 * `engine.step()`. Each tick moves along the normalized XZ direction to the
 * target and presses interact for a few ticks once inside
 * `STEER_INTERACT_DISTANCE`; the player jumps when the target sits above it and
 * it is grounded. Obstacle avoidance: if XZ progress over the last
 * `STALL_WINDOW_TICKS` ticks is below `STALL_MIN_PROGRESS` while not at the
 * target, the desired direction is rotated 90 degrees for `SIDESTEP_TICKS`
 * ticks (alternating sides on repeated stalls). Distances are measured on XZ
 * so the player's 0.9 center height above ground targets does not count.
 * Returns true as soon as the player's XZ position is within
 * `STEER_STOP_DISTANCE` of the target or the game is won, false when the game
 * is lost or `maxTicks` elapse first.
 */
export function steerTo(engine: Engine, target: Vec3, maxTicks: number): boolean {
  const recentXZ: Array<[number, number]> = [];
  let sidestepLeft = 0;
  let sidestepSign = 1;
  let interactTicks = 0;

  for (let tick = 0; tick < maxTicks; tick += 1) {
    const state = engine.getState();
    if (state.status === "won") return true;
    if (state.status !== "running") return false;

    const player = playerRuntime(state);
    if (!player) return false;

    const dist = xzDistance(player.position, target);
    if (dist <= STEER_STOP_DISTANCE) {
      if (interactTicks === 0) {
        engine.step(FIXED_DT_MS, { interact: true });
      }
      return true;
    }

    const dx = target[0] - player.position[0];
    const dz = target[2] - player.position[2];
    const planar = Math.hypot(dx, dz);

    let moveX = planar > 1e-9 ? dx / planar : 0;
    let moveZ = planar > 1e-9 ? dz / planar : 0;

    recentXZ.push([player.position[0], player.position[2]]);
    if (recentXZ.length > STALL_WINDOW_TICKS + 1) recentXZ.shift();

    const stalled =
      recentXZ.length === STALL_WINDOW_TICKS + 1 &&
      Math.hypot(
        player.position[0] - recentXZ[0][0],
        player.position[2] - recentXZ[0][1]
      ) < STALL_MIN_PROGRESS;

    if (sidestepLeft === 0 && stalled) {
      sidestepLeft = SIDESTEP_TICKS;
      sidestepSign = -sidestepSign;
    }

    if (sidestepLeft > 0) {
      const rotatedX = -moveZ * sidestepSign;
      const rotatedZ = moveX * sidestepSign;
      moveX = rotatedX;
      moveZ = rotatedZ;
      sidestepLeft -= 1;
    }

    const input: Partial<InputState> = { moveX, moveZ };
    if (target[1] - player.position[1] > JUMP_RISE && player.grounded) {
      input.jump = true;
    }

    if (dist <= STEER_INTERACT_DISTANCE) {
      input.interact = interactTicks < INTERACT_TICKS;
      interactTicks += 1;
    } else {
      interactTicks = 0;
    }

    engine.step(FIXED_DT_MS, input);
  }

  return false;
}
