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

export const PartShapeSchema = z.enum([
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "capsule",
  "wedge",
  "plane",
]);

export const PartTextureSchema = z.enum([
  "circuit",
  "wood",
  "brick",
  "metal",
  "grid",
  "glass",
]);

export const PartMaterialSchema = z
  .object({
    metalness: z.number(),
    roughness: z.number(),
    emissive: z.string(),
    opacity: z.number(),
    texture: PartTextureSchema,
  })
  .partial()
  .optional();

export const PartSchema = z.object({
  shape: PartShapeSchema,
  offset: Vec3Schema.default([0, 0, 0]),
  size: Vec3Schema.default([1, 1, 1]),
  rotation: Vec3Schema.optional(),
  color: z.string().optional(),
  material: PartMaterialSchema,
});

export const EntityLabelSchema = z.object({
  text: z.string(),
  offset: Vec3Schema.optional(),
  size: z.number().positive().optional(),
  /** Flat silkscreen plane on the entity (true) vs camera-facing sprite. */
  flat: z.boolean().optional(),
});

export const EntitySchema = z.object({
  id: EntityIdSchema,
  kind: EntityKindSchema,
  name: z.string().optional(),
  /**
   * Id of another entity this one is attached to. Parented entities are
   * resolved into world space by the engine: their authored `position` /
   * `rotation` are local to the parent, and `attach` offsets the mount point
   * in the parent's local space. Reference existence and cycles are checked at
   * the sanity level, not in zod.
   */
  parent: z.string().min(1).optional(),
  /** Mount offset in the parent's local space (default [0, 0, 0]). */
  attach: Vec3Schema.optional(),
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
  parts: z.array(PartSchema).optional(),
  label: EntityLabelSchema.optional(),
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
  "click",
  "hoverEnter",
  "hoverLeave",
  "controlPressed",
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

export const AnimationKindSchema = z.enum([
  "spin",
  "bob",
  "pulse",
  "slide",
  "orbit",
]);

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
  z.object({
    type: z.literal("setVisible"),
    entity: z.string().min(1),
    visible: z.boolean(),
  }),
  z.object({
    type: z.literal("setColor"),
    entity: z.string().min(1),
    color: z.string(),
  }),
  z.object({
    type: z.literal("animate"),
    entity: z.string().min(1),
    kind: AnimationKindSchema,
    axis: Vec3Schema.optional(),
    amplitude: z.number().optional(),
    speed: z.number().optional(),
    to: Vec3Schema.optional(),
    duration: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("cameraFocus"),
    entity: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("showPanel"),
    title: z.string(),
    body: z.string(),
    entity: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("hidePanel"),
    entity: z.string().min(1).optional(),
  }),
]);

export const RuleSchema = z.object({
  id: RuleIdSchema,
  on: RuleTriggerSchema,
  if: ConditionSchema.optional(),
  then: z.array(ActionSchema).min(1),
});

/** Entity property a control can drive every tick. */
export const ControlBindPropertySchema = z.enum([
  "rotation.x",
  "rotation.y",
  "rotation.z",
  "position.x",
  "position.y",
  "position.z",
  "visible",
  "color",
  "emissive",
]);

/**
 * One interactive control (slider / toggle / button). `bind` connects the live
 * value to an entity property, a scratch var, and/or `onPress` rule actions.
 */
export const ControlSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["slider", "toggle", "button"]),
  label: z.string().min(1),
  /** Slider bounds; the panel renders `min..max` and the engine stores raw values. */
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  /** Initial live value (`state.ui.controls[id] ?? 0` when omitted). */
  value: z.number().optional(),
  bind: z
    .object({
      entity: z.string().optional(),
      property: ControlBindPropertySchema.optional(),
      /** Applied to the value: `property = base + value * scale + offset`. */
      scale: z.number().optional(),
      offset: z.number().optional(),
      /** Write the live value into `state.scratch[var]` instead of a property. */
      var: z.string().min(1).optional(),
      /** Button actions, executed through the rules action vocabulary. */
      onPress: z.array(ActionSchema).optional(),
    })
    .optional(),
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
  "explore",
]);

export const GameModeSchema = z.enum([
  "inspect",
  "walkthrough",
  "drive",
  "explore",
  "game",
  "machine",
  "world",
]);

export const MetaSchema = z.object({
  title: z.string().min(1),
  archetype: ArchetypeSchema,
  genre: z.string().optional(),
  difficulty: z.number().min(0).max(1).default(0.5),
  seed: z.number().int().optional(),
  mode: GameModeSchema.optional(),
});

export const GameSchema = z
  .object({
    version: z.literal(SCHEMA_VERSION),
    meta: MetaSchema,
    world: WorldSchema,
    entities: z.array(EntitySchema).min(1),
    objectives: z.array(ObjectiveSchema).default([]),
    rules: z.array(RuleSchema).default([]),
    controls: z.array(ControlSchema).default([]),
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
export type PartShape = z.infer<typeof PartShapeSchema>;
export type PartTexture = z.infer<typeof PartTextureSchema>;
export type PartMaterial = z.infer<typeof PartMaterialSchema>;
export type Part = z.infer<typeof PartSchema>;
export type EntityLabel = z.infer<typeof EntityLabelSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type ObjectiveType = z.infer<typeof ObjectiveTypeSchema>;
export type ObjectiveStatus = z.infer<typeof ObjectiveStatusSchema>;
export type Objective = z.infer<typeof ObjectiveSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type RuleTrigger = z.infer<typeof RuleTriggerSchema>;
export type AnimationKind = z.infer<typeof AnimationKindSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type ControlBindProperty = z.infer<typeof ControlBindPropertySchema>;
export type Control = z.infer<typeof ControlSchema>;
export type Lighting = z.infer<typeof LightingSchema>;
export type Skybox = z.infer<typeof SkyboxSchema>;
export type Terrain = z.infer<typeof TerrainSchema>;
export type World = z.infer<typeof WorldSchema>;
export type Archetype = z.infer<typeof ArchetypeSchema>;
export type GameMode = z.infer<typeof GameModeSchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type GameDoc = z.infer<typeof GameSchema>;
