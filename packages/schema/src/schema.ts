import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const EntityIdSchema = z.string().min(1).brand<"EntityId">();
export const ObjectiveIdSchema = z.string().min(1).brand<"ObjectiveId">();
export const RuleIdSchema = z.string().min(1).brand<"RuleId">();

export const ScratchValueSchema = z.union([z.number(), z.string(), z.boolean()]);

export const EntityKindSchema = z.enum([
  "player",
  "enemy",
  "collectible",
  "zone",
  "interactable",
  "prop",
  "exitDoor",
  "platform",
  "beam",
  "spawn",
]);

export const EnemyStateSchema = z.enum(["idle", "patrol", "chase", "return"]);

export const EntitySchema = z.object({
  id: EntityIdSchema,
  kind: EntityKindSchema,
  name: z.string().optional(),
  position: Vec3Schema,
  rotation: Vec3Schema.optional(),
  scale: Vec3Schema.optional(),
  size: Vec3Schema.optional(),
  color: z.string().optional(),
  tags: z.array(z.string()).default([]),
  active: z.boolean().default(true),
  solid: z.boolean().optional(),
  speed: z.number().nonnegative().optional(),
  patrol: z.array(Vec3Schema).optional(),
  sight: z.number().nonnegative().optional(),
  state: EnemyStateSchema.optional(),
  props: z.record(ScratchValueSchema).optional(),
});

export const ObjectiveTypeSchema = z.enum([
  "collect",
  "reach",
  "survive",
  "avoid",
  "activate",
  "timeLimit",
]);

export const ObjectiveStatusSchema = z.enum(["active", "done", "failed"]);

export const ObjectiveSchema = z.object({
  id: ObjectiveIdSchema,
  type: ObjectiveTypeSchema,
  description: z.string().optional(),
  target: z.string().optional(),
  targets: z.array(z.string()).optional(),
  count: z.number().int().nonnegative().optional(),
  progress: z.number().nonnegative().default(0),
  time: z.number().nonnegative().optional(),
  status: ObjectiveStatusSchema.default("active"),
});

export const EventTypeSchema = z.enum([
  "playerEnter",
  "objectiveProgress",
  "objectiveComplete",
  "objectiveFailed",
  "timer",
  "enemyContact",
  "interact",
  "itemPickup",
  "stateChange",
  "playerDeath",
  "tick",
]);

export const RuleTriggerSchema = z.object({
  event: EventTypeSchema,
  zone: z.string().optional(),
  entity: z.string().optional(),
  objective: z.string().optional(),
  tag: z.string().optional(),
});

export type ValueRef =
  | number
  | string
  | boolean
  | { var: string }
  | { stat: string };

export const ValueRefSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.object({ var: z.string().min(1) }),
  z.object({ stat: z.string().min(1) }),
]);

export type Condition =
  | { op: "and"; conditions: Condition[] }
  | { op: "or"; conditions: Condition[] }
  | { op: "not"; condition: Condition }
  | { op: "has"; entity: string }
  | { op: "hasTag"; tag: string }
  | {
      op: "<" | "<=" | ">" | ">=" | "==" | "!=";
      left: ValueRef;
      right: ValueRef;
    };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({
      op: z.literal("and"),
      conditions: z.array(ConditionSchema),
    }),
    z.object({
      op: z.literal("or"),
      conditions: z.array(ConditionSchema),
    }),
    z.object({
      op: z.literal("not"),
      condition: ConditionSchema,
    }),
    z.object({ op: z.literal("has"), entity: z.string().min(1) }),
    z.object({ op: z.literal("hasTag"), tag: z.string().min(1) }),
    z.object({
      op: z.enum(["<", "<=", ">", ">=", "==", "!="]),
      left: ValueRefSchema,
      right: ValueRefSchema,
    }),
  ])
);

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("spawn"), entity: EntitySchema }),
  z.object({ type: z.literal("despawn"), entity: z.string().min(1) }),
  z.object({ type: z.literal("enable"), entity: z.string().min(1) }),
  z.object({ type: z.literal("disable"), entity: z.string().min(1) }),
  z.object({
    type: z.literal("objectiveProgress"),
    objective: z.string().min(1),
    by: z.number().default(1),
    to: z.number().optional(),
  }),
  z.object({
    type: z.literal("setObjective"),
    objective: z.string().min(1),
    status: ObjectiveStatusSchema,
  }),
  z.object({ type: z.literal("addObjective"), objective: ObjectiveSchema }),
  z.object({
    type: z.literal("setVar"),
    key: z.string().min(1),
    value: ScratchValueSchema,
  }),
  z.object({
    type: z.literal("incVar"),
    key: z.string().min(1),
    by: z.number().default(1),
  }),
  z.object({
    type: z.literal("teleport"),
    entity: z.string().min(1),
    position: Vec3Schema,
  }),
  z.object({ type: z.literal("playSound"), sound: z.string().min(1) }),
  z.object({ type: z.literal("showMessage"), text: z.string() }),
  z.object({
    type: z.literal("setEnemyState"),
    entity: z.string().min(1),
    state: EnemyStateSchema,
  }),
  z.object({ type: z.literal("win"), message: z.string().optional() }),
  z.object({ type: z.literal("lose"), message: z.string().optional() }),
  z.object({
    type: z.literal("damage"),
    entity: z.string().min(1).optional(),
    amount: z.number().default(1),
  }),
  z.object({ type: z.literal("openDoor"), entity: z.string().min(1) }),
  z.object({ type: z.literal("toggle"), target: z.string().min(1) }),
]);

export const RuleSchema = z.object({
  id: RuleIdSchema,
  on: RuleTriggerSchema,
  if: ConditionSchema.optional(),
  then: z.array(ActionSchema).min(1),
});

export const LightingSchema = z.enum(["dawn", "day", "dusk", "night", "indoor"]);
export const SkyboxSchema = z.enum(["cave", "outdoor", "lab"]);
export const TerrainTypeSchema = z.enum(["flat", "mesh"]);

export const ObstacleSchema = z.object({
  position: Vec3Schema,
  size: Vec3Schema,
});

export const TerrainSchema = z.object({
  type: TerrainTypeSchema.default("flat"),
  obstacles: z.array(ObstacleSchema).default([]),
});

export const WorldSchema = z.object({
  bounds: Vec3Schema,
  lighting: LightingSchema.default("day"),
  skybox: SkyboxSchema.default("outdoor"),
  gravity: z.number().default(9.8),
  terrain: TerrainSchema.default({ type: "flat", obstacles: [] }),
});

export const ArchetypeSchema = z.enum([
  "collect-a-thon",
  "puzzle-switch",
  "platformer-lite",
  "stealth-chase",
]);

export const MetaSchema = z.object({
  title: z.string().min(1),
  archetype: ArchetypeSchema,
  genre: z.string().optional(),
  difficulty: z.number().min(0).max(1).default(0.5),
  seed: z.number().int().optional(),
});

export const GameSchema = z
  .object({
    version: z.literal(SCHEMA_VERSION),
    meta: MetaSchema,
    world: WorldSchema,
    entities: z.array(EntitySchema).min(1),
    objectives: z.array(ObjectiveSchema).default([]),
    rules: z.array(RuleSchema).default([]),
    scratch: z.record(ScratchValueSchema).default({}),
  })
  .superRefine((doc, ctx) => {
    if (!doc.entities.some((e) => e.kind === "player")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Game must include a player entity (kind: 'player')",
        path: ["entities"],
      });
    }
  });

export type Vec3 = z.infer<typeof Vec3Schema>;
export type EntityId = z.infer<typeof EntityIdSchema>;
export type ObjectiveId = z.infer<typeof ObjectiveIdSchema>;
export type RuleId = z.infer<typeof RuleIdSchema>;
export type ScratchValue = z.infer<typeof ScratchValueSchema>;
export type EntityKind = z.infer<typeof EntityKindSchema>;
export type EnemyState = z.infer<typeof EnemyStateSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type ObjectiveType = z.infer<typeof ObjectiveTypeSchema>;
export type ObjectiveStatus = z.infer<typeof ObjectiveStatusSchema>;
export type Objective = z.infer<typeof ObjectiveSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type RuleTrigger = z.infer<typeof RuleTriggerSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type Lighting = z.infer<typeof LightingSchema>;
export type Skybox = z.infer<typeof SkyboxSchema>;
export type Terrain = z.infer<typeof TerrainSchema>;
export type World = z.infer<typeof WorldSchema>;
export type Archetype = z.infer<typeof ArchetypeSchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type GameDoc = z.infer<typeof GameSchema>;
