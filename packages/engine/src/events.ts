/**
 * External (non-simulated) events injected by hosts via `Engine.pushEvent`.
 * `targetId` identifies the picked entity; rules match it through the regular
 * `trigger.entity` field. `hoverLeave` carries the entity that was left.
 */
export type ExternalEvent =
  | { type: "click"; targetId: string }
  | { type: "hoverEnter"; targetId: string }
  | { type: "hoverLeave"; targetId: string };

export type GameEvent =
  | { type: "playerEnter"; zoneId: string; entityId: string }
  | { type: "objectiveComplete"; objectiveId: string }
  | { type: "objectiveProgress"; objectiveId: string; by: number }
  | { type: "objectiveFailed"; objectiveId: string }
  | { type: "playerDeath" }
  | { type: "enemyContact"; entityId: string; targetId: string }
  | { type: "interact"; targetId: string; entityId: string }
  | { type: "tick" }
  | ExternalEvent;
