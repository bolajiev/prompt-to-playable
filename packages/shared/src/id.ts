export type EntityId = string & { __brand: "EntityId" };
export type ObjectiveId = string & { __brand: "ObjectiveId" };
export type RuleId = string & { __brand: "RuleId" };
export type GameId = string & { __brand: "GameId" };

export function newId(prefix = "id"): EntityId {
  return (prefix + "_" + Math.random().toString(36).slice(2, 9)) as EntityId;
}
