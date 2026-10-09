export type GameEvent =
  | { type: "playerEnter"; zoneId: string; entityId: string }
  | { type: "objectiveComplete"; objectiveId: string }
  | { type: "objectiveProgress"; objectiveId: string; by: number }
  | { type: "playerDeath" }
  | { type: "interact"; targetId: string; entityId: string }
  | { type: "tick" };
