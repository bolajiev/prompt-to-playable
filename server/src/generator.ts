import { SCHEMA_VERSION, validateGame } from "@prompt-to-playable/schema";
import type { Archetype, GameDoc } from "@prompt-to-playable/schema";
import { KIT_ARCHETYPES } from "./classifier.js";
import type { KitArchetype } from "./classifier.js";
import type { LlmCall } from "./llm.js";

export type { KitArchetype };
export { KIT_ARCHETYPES };

/**
 * Schema archetype stored in `meta.archetype` for each classification label.
 * The three kits are not schema archetypes: they are carried in `meta.mode`,
 * with inspect/walkthrough shaped as free-roam "explore" scenes and drive as a
 * goal-shaped "collect-a-thon".
 */
export const KIT_SCHEMA_ARCHETYPE: Record<KitArchetype, Archetype> = {
  "collect-a-thon": "collect-a-thon",
  "puzzle-switch": "puzzle-switch",
  "platformer-lite": "platformer-lite",
  "stealth-chase": "stealth-chase",
  explore: "explore",
  inspect: "explore",
  walkthrough: "explore",
  drive: "collect-a-thon",
};

function example(raw: Record<string, unknown>): GameDoc {
  const result = validateGame(raw);
  if (!result.ok || !result.data) {
    const detail = result.error
      ? result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")
      : "unknown error";
    throw new Error(`archetype example fails schema validation: ${detail}`);
  }
  return result.data;
}

export const ARCHETYPE_EXAMPLES: Record<KitArchetype, GameDoc> = {
  "collect-a-thon": example({
    version: "1.0.0",
    meta: { title: "Crystal Dash", archetype: "collect-a-thon", difficulty: 0.4 },
    world: { bounds: [20, 10, 20], terrain: { type: "flat", obstacles: [] } },
    entities: [
      { id: "player", kind: "player", position: [-12, 1, 0] },
      { id: "gem-1", kind: "collectible", name: "Cyan crystal", position: [-4, 1, 6], color: "cyan" },
      { id: "gem-1-zone", kind: "zone", name: "Cyan pickup zone", position: [-4, 1, 6], size: [3, 2, 3] },
      { id: "gem-2", kind: "collectible", name: "Magenta crystal", position: [4, 1, -6], color: "magenta" },
      { id: "gem-2-zone", kind: "zone", name: "Magenta pickup zone", position: [4, 1, -6], size: [3, 2, 3] },
      { id: "gem-3", kind: "collectible", name: "Yellow crystal", position: [10, 1, 8], color: "yellow" },
      { id: "gem-3-zone", kind: "zone", name: "Yellow pickup zone", position: [10, 1, 8], size: [3, 2, 3] },
    ],
    objectives: [
      {
        id: "collect-gems",
        type: "collect",
        description: "Collect all three crystals",
        targets: ["gem-1", "gem-2", "gem-3"],
        count: 3,
      },
    ],
    rules: [
      {
        id: "pick-up-gem-1",
        on: { event: "playerEnter", zone: "gem-1-zone" },
        then: [
          { type: "despawn", entity: "gem-1" },
          { type: "objectiveProgress", objective: "collect-gems", by: 1 },
        ],
      },
      {
        id: "pick-up-gem-2",
        on: { event: "playerEnter", zone: "gem-2-zone" },
        then: [
          { type: "despawn", entity: "gem-2" },
          { type: "objectiveProgress", objective: "collect-gems", by: 1 },
        ],
      },
      {
        id: "pick-up-gem-3",
        on: { event: "playerEnter", zone: "gem-3-zone" },
        then: [
          { type: "despawn", entity: "gem-3" },
          { type: "objectiveProgress", objective: "collect-gems", by: 1 },
        ],
      },
      {
        id: "win-on-collected",
        on: { event: "objectiveComplete", objective: "collect-gems" },
        then: [{ type: "win", message: "All crystals collected!" }],
      },
    ],
    scratch: { crystalsCollected: 0 },
  }),
  "puzzle-switch": example({
    version: "1.0.0",
    meta: { title: "Switch Chamber", archetype: "puzzle-switch", difficulty: 0.5 },
    world: {
      bounds: [20, 10, 20],
      lighting: "indoor",
      skybox: "lab",
      terrain: { type: "flat", obstacles: [] },
    },
    entities: [
      { id: "player", kind: "player", position: [0, 1, -10] },
      { id: "switch-a", kind: "interactable", name: "West switch", position: [-8, 1, 6] },
      { id: "switch-b", kind: "interactable", name: "Center switch", position: [0, 1, 8] },
      { id: "switch-c", kind: "interactable", name: "East switch", position: [8, 1, 6] },
      { id: "exit-door", kind: "exitDoor", name: "Vault door", position: [0, 1, 14], solid: true },
    ],
    objectives: [
      {
        id: "activate-switches",
        type: "activate",
        description: "Activate all three switches",
        targets: ["switch-a", "switch-b", "switch-c"],
        count: 3,
      },
    ],
    rules: [
      {
        id: "use-switch-a",
        on: { event: "interact", entity: "switch-a" },
        then: [
          { type: "objectiveProgress", objective: "activate-switches", by: 1 },
          { type: "showMessage", text: "The west switch clicks." },
        ],
      },
      {
        id: "use-switch-b",
        on: { event: "interact", entity: "switch-b" },
        then: [
          { type: "objectiveProgress", objective: "activate-switches", by: 1 },
          { type: "showMessage", text: "The center switch clicks." },
        ],
      },
      {
        id: "use-switch-c",
        on: { event: "interact", entity: "switch-c" },
        then: [
          { type: "objectiveProgress", objective: "activate-switches", by: 1 },
          { type: "showMessage", text: "The east switch clicks." },
        ],
      },
      {
        id: "open-exit",
        on: { event: "objectiveComplete", objective: "activate-switches" },
        then: [
          { type: "openDoor", entity: "exit-door" },
          { type: "win", message: "The vault door opens!" },
        ],
      },
    ],
    scratch: { switchesActive: 0 },
  }),
  "platformer-lite": example({
    version: "1.0.0",
    meta: { title: "Sky Steps", archetype: "platformer-lite", difficulty: 0.5 },
    world: { bounds: [16, 12, 16], gravity: 14, terrain: { type: "flat", obstacles: [] } },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      {
        id: "platform-1",
        kind: "platform",
        name: "Stone step",
        position: [3, 2, 0],
        size: [2, 0.5, 2],
        solid: true,
      },
      {
        id: "platform-2",
        kind: "platform",
        name: "Stone step",
        position: [6, 3.5, 0],
        size: [2, 0.5, 2],
        solid: true,
      },
      {
        id: "goal-platform",
        kind: "platform",
        name: "Summit",
        position: [9, 5, 0],
        size: [2, 0.5, 2],
        solid: true,
      },
      { id: "goal-zone", kind: "zone", name: "Summit goal", position: [9, 6, 0], size: [2, 2, 2] },
    ],
    objectives: [
      {
        id: "reach-goal",
        type: "reach",
        description: "Reach the summit platform",
        target: "goal-zone",
        count: 1,
      },
    ],
    rules: [
      {
        id: "step-on-summit",
        on: { event: "playerEnter", zone: "goal-zone" },
        then: [{ type: "objectiveProgress", objective: "reach-goal", by: 1 }],
      },
      {
        id: "win-at-summit",
        on: { event: "objectiveComplete", objective: "reach-goal" },
        then: [{ type: "win", message: "To the summit!" }],
      },
    ],
    scratch: {},
  }),
  "stealth-chase": example({
    version: "1.0.0",
    meta: { title: "Shadow Patrol", archetype: "stealth-chase", difficulty: 0.6 },
    world: { bounds: [20, 8, 20], lighting: "night", skybox: "cave", terrain: { type: "flat", obstacles: [] } },
    entities: [
      { id: "player", kind: "player", position: [0, 1, 0] },
      {
        id: "guard",
        kind: "enemy",
        name: "Patrolling guard",
        position: [8, 1, 0],
        speed: 2.5,
        sight: 6,
        state: "patrol",
        patrol: [
          [8, 1, 0],
          [-8, 1, 0],
        ],
      },
      { id: "exit-zone", kind: "zone", name: "Shadowed exit", position: [-10, 1, 8], size: [3, 2, 3] },
    ],
    objectives: [
      {
        id: "sneak-out",
        type: "reach",
        description: "Reach the exit unseen",
        target: "exit-zone",
        count: 1,
      },
      {
        id: "survive-patrol",
        type: "survive",
        description: "Stay hidden while the guard patrols",
        time: 20,
      },
    ],
    rules: [
      {
        id: "spotted",
        on: { event: "enemyContact", entity: "guard" },
        then: [{ type: "lose", message: "Spotted by the guard!" }],
      },
      {
        id: "reach-exit",
        on: { event: "playerEnter", zone: "exit-zone" },
        then: [{ type: "objectiveProgress", objective: "sneak-out", by: 1 }],
      },
      {
        id: "escaped",
        on: { event: "objectiveComplete", objective: "sneak-out" },
        then: [{ type: "win", message: "Vanished into the dark." }],
      },
    ],
    scratch: {},
  }),
  explore: example({
    version: "1.0.0",
    meta: { title: "Campfire Clearing", archetype: "explore", genre: "ambient", difficulty: 0 },
    world: {
      bounds: [24, 10, 24],
      lighting: "dusk",
      skybox: "outdoor",
      terrain: { type: "flat", obstacles: [] },
    },
    entities: [
      { id: "player", kind: "player", name: "Wanderer", position: [0, 1, 0] },
      {
        id: "campfire",
        kind: "prop",
        name: "Crackling campfire",
        position: [4, 0.5, 3],
        size: [1.5, 1, 1.5],
        color: "orange",
        props: { shape: "campfire" },
      },
      {
        id: "log-bench",
        kind: "prop",
        name: "Fallen log bench",
        position: [6, 0.5, 5],
        size: [3, 1, 1],
        color: "saddlebrown",
        props: { shape: "table" },
      },
      {
        id: "pine-tree",
        kind: "prop",
        name: "Towering pine",
        position: [-5, 3, -4],
        size: [3, 6, 3],
        color: "forestgreen",
        props: { shape: "tree" },
      },
      {
        id: "boulder",
        kind: "prop",
        name: "Mossy boulder",
        position: [7, 0.6, -4],
        size: [1.2, 1.2, 1.2],
        color: "slategray",
        props: { shape: "rock" },
      },
      {
        id: "signpost",
        kind: "interactable",
        name: "Weathered signpost",
        position: [-6, 1, 5],
      },
      {
        id: "firefly",
        kind: "enemy",
        name: "Drifting firefly",
        position: [8, 2, -6],
        speed: 1,
        state: "idle",
        color: "yellow",
      },
    ],
    objectives: [],
    rules: [
      {
        id: "read-signpost",
        on: { event: "interact", entity: "signpost" },
        then: [
          { type: "showMessage", text: "The sign reads: rest here as long as you like." },
        ],
      },
    ],
    scratch: {},
  }),
  inspect: example({
    version: "1.0.0",
    meta: {
      title: "Circuit Board Inspector",
      archetype: "explore",
      mode: "inspect",
      genre: "showcase",
      difficulty: 0,
    },
    world: {
      bounds: [16, 10, 16],
      lighting: "indoor",
      skybox: "lab",
      terrain: { type: "flat", obstacles: [] },
    },
    entities: [
      { id: "player", kind: "player", name: "Observer", position: [0, 4, 11] },
      {
        id: "mainboard",
        kind: "prop",
        name: "Green PCB mainboard",
        position: [0, 1.6, 0],
        size: [7, 0.4, 5],
        color: "#1b7a4f",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [7, 0.35, 5],
            color: "#1b7a4f",
            material: { roughness: 0.75, texture: "circuit" },
          },
        ],
        label: { text: "PCB-01 mainboard", offset: [0, 1.1, 0], size: 0.55 },
      },
      {
        id: "cpu-chip",
        kind: "prop",
        name: "CPU chip",
        position: [-1.8, 1.8, 0.4],
        size: [1.5, 0.6, 1.5],
        color: "#2f3640",
        parts: [
          {
            shape: "box",
            offset: [0, 0.2, 0],
            size: [1.5, 0.4, 1.5],
            color: "#2f3640",
            material: { metalness: 0.7, roughness: 0.35 },
          },
          {
            shape: "box",
            offset: [0, 0.5, 0],
            size: [0.7, 0.2, 0.7],
            color: "#8d99ae",
            material: { metalness: 0.8, roughness: 0.25 },
          },
          {
            shape: "cylinder",
            offset: [0, 0.72, 0],
            size: [0.5, 0.08, 0.5],
            color: "#d4af37",
            material: { metalness: 0.9, roughness: 0.3 },
          },
        ],
        label: { text: "CPU-8 core", offset: [0, 1.2, 0], size: 0.5 },
      },
      {
        id: "ram-bank",
        kind: "prop",
        name: "RAM bank",
        position: [1.6, 1.8, -0.6],
        size: [2.4, 0.5, 0.7],
        color: "#2b2d42",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [2.4, 0.4, 0.6],
            color: "#2b2d42",
            material: { metalness: 0.5, roughness: 0.5 },
          },
          {
            shape: "box",
            offset: [0, 0.28, 0],
            size: [2.2, 0.15, 0.35],
            color: "#5c677d",
            material: { metalness: 0.6, roughness: 0.4 },
          },
        ],
      },
      {
        id: "power-connector",
        kind: "prop",
        name: "Power connector",
        position: [-2.4, 2, -1.4],
        size: [1.6, 1, 1],
        color: "#e9c46a",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [1.6, 0.9, 1],
            color: "#e9c46a",
            material: { metalness: 0.3, roughness: 0.6 },
          },
          {
            shape: "cylinder",
            offset: [-0.5, 0.7, 0],
            size: [0.14, 0.9, 0.14],
            rotation: [Math.PI / 2, 0, 0],
            color: "#d4af37",
            material: { metalness: 0.95, roughness: 0.2 },
          },
          {
            shape: "cylinder",
            offset: [0.5, 0.7, 0],
            size: [0.14, 0.9, 0.14],
            rotation: [Math.PI / 2, 0, 0],
            color: "#d4af37",
            material: { metalness: 0.95, roughness: 0.2 },
          },
        ],
        label: { text: "J1 power", offset: [0, 1.3, 0], size: 0.45 },
      },
      {
        id: "status-leds",
        kind: "prop",
        name: "Status LEDs",
        position: [2.5, 1.9, 1.6],
        size: [1.4, 0.4, 0.5],
        color: "#35c98f",
        parts: [
          {
            shape: "cylinder",
            offset: [-0.35, 0, 0],
            size: [0.3, 0.25, 0.3],
            color: "#35c98f",
            material: { emissive: "#35c98f" },
          },
          {
            shape: "cylinder",
            offset: [0.35, 0, 0],
            size: [0.3, 0.25, 0.3],
            color: "#e63946",
            material: { emissive: "#e63946" },
          },
        ],
      },
    ],
    objectives: [],
    rules: [
      {
        id: "focus-mainboard",
        on: { event: "click", entity: "mainboard" },
        if: { op: "==", left: { var: "focused" }, right: 0 },
        then: [
          { type: "setVar", key: "focused", value: 1 },
          { type: "cameraFocus", entity: "mainboard" },
        ],
      },
      {
        id: "inspect-mainboard",
        on: { event: "click", entity: "mainboard" },
        then: [
          { type: "setColor", entity: "mainboard", color: "#35c98f" },
          {
            type: "showPanel",
            title: "PCB-01 mainboard",
            body: "A four-layer board with a copper pour and silkscreen labels. Click the CPU, RAM or connector to learn more.",
            entity: "mainboard",
          },
        ],
      },
      {
        id: "inspect-cpu",
        on: { event: "click", entity: "cpu-chip" },
        then: [
          { type: "setColor", entity: "cpu-chip", color: "#4cc9f0" },
          {
            type: "showPanel",
            title: "CPU-8 core",
            body: "The processor: eight cores under a gold lid, seated in the socket next to the RAM bank.",
            entity: "cpu-chip",
          },
        ],
      },
      {
        id: "inspect-connector",
        on: { event: "click", entity: "power-connector" },
        then: [
          { type: "setColor", entity: "power-connector", color: "#f4a261" },
          {
            type: "showPanel",
            title: "J1 power",
            body: "The main power header. Two pins carry 12 volts to the board.",
            entity: "power-connector",
          },
        ],
      },
    ],
    scratch: { focused: 0 },
  }),
  walkthrough: example({
    version: "1.0.0",
    meta: {
      title: "Cottage Walkthrough",
      archetype: "explore",
      mode: "walkthrough",
      genre: "interior",
      difficulty: 0,
    },
    world: {
      bounds: [18, 8, 18],
      lighting: "indoor",
      skybox: "outdoor",
      terrain: { type: "flat", obstacles: [] },
    },
    entities: [
      { id: "player", kind: "player", name: "Visitor", position: [0, 1, 3] },
      {
        id: "wall-back",
        kind: "prop",
        name: "Back wall",
        position: [0, 2, -5],
        size: [12, 4, 0.3],
        solid: true,
        color: "#d9c7a7",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [12, 4, 0.3],
            color: "#d9c7a7",
            material: { roughness: 0.95, texture: "wood" },
          },
        ],
      },
      {
        id: "wall-left",
        kind: "prop",
        name: "Left wall",
        position: [-6, 2, 0],
        size: [0.3, 4, 10],
        solid: true,
        color: "#d9c7a7",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [0.3, 4, 10],
            color: "#d9c7a7",
            material: { roughness: 0.95, texture: "wood" },
          },
        ],
      },
      {
        id: "wall-right",
        kind: "prop",
        name: "Right wall",
        position: [6, 2, 0],
        size: [0.3, 4, 10],
        solid: true,
        color: "#d9c7a7",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [0.3, 4, 10],
            color: "#d9c7a7",
            material: { roughness: 0.95, texture: "wood" },
          },
        ],
      },
      {
        id: "wall-front-left",
        kind: "prop",
        name: "Front wall (left)",
        position: [-3.5, 2, 5],
        size: [5, 4, 0.3],
        solid: true,
        color: "#d9c7a7",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [5, 4, 0.3],
            color: "#d9c7a7",
            material: { roughness: 0.95, texture: "wood" },
          },
        ],
      },
      {
        id: "wall-front-right",
        kind: "prop",
        name: "Front wall (right)",
        position: [3.5, 2, 5],
        size: [5, 4, 0.3],
        solid: true,
        color: "#d9c7a7",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [5, 4, 0.3],
            color: "#d9c7a7",
            material: { roughness: 0.95, texture: "wood" },
          },
        ],
      },
      {
        id: "roof",
        kind: "prop",
        name: "Gable roof",
        position: [0, 4.2, 0],
        size: [12.6, 0.3, 10.6],
        color: "#7d4f3a",
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [12.6, 0.3, 10.6],
            color: "#7d4f3a",
            material: { roughness: 0.85, texture: "wood" },
          },
          {
            shape: "wedge",
            offset: [0, 0.95, 0],
            size: [12.6, 1.6, 10.6],
            color: "#5f3d2c",
            material: { roughness: 0.85, texture: "wood" },
          },
        ],
      },
      {
        id: "front-door",
        kind: "interactable",
        name: "Front door",
        position: [0, 1.5, 5],
        size: [2, 3, 0.3],
        solid: true,
        color: "#7b4b2a",
        props: { door: true, interactRange: 3.5 },
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [2, 3, 0.2],
            color: "#7b4b2a",
            material: { roughness: 0.8, texture: "wood" },
          },
          {
            shape: "sphere",
            offset: [-0.7, 0, 0.2],
            size: [0.18, 0.18, 0.18],
            color: "#d4af37",
            material: { metalness: 0.9, roughness: 0.25 },
          },
        ],
        label: { text: "Front door", offset: [0, 2, 0], size: 0.45 },
      },
      {
        id: "floor-lamp",
        kind: "interactable",
        name: "Floor lamp",
        position: [-3, 1.5, 3],
        size: [1, 3, 1],
        props: { interactRange: 3.5 },
        parts: [
          {
            shape: "cylinder",
            offset: [0, 0, 0],
            size: [0.18, 3, 0.18],
            color: "#4a4a4a",
            material: { metalness: 0.6, roughness: 0.5 },
          },
          {
            shape: "cylinder",
            offset: [0, -1.4, 0],
            size: [0.7, 0.15, 0.7],
            color: "#3d3d3d",
            material: { metalness: 0.6, roughness: 0.5 },
          },
          {
            shape: "cone",
            offset: [0, 1.7, 0],
            size: [1.2, 0.9, 1.2],
            color: "#f4d58d",
            material: { emissive: "#f4d58d", opacity: 0.9 },
          },
        ],
        label: { text: "Floor lamp", offset: [0, 2.6, 0], size: 0.4 },
      },
      {
        id: "lamp-glow",
        kind: "prop",
        name: "Lamp glow",
        position: [-3, 3.5, 3],
        size: [0.7, 0.7, 0.7],
        color: "#ffe9a8",
        parts: [
          {
            shape: "sphere",
            offset: [0, 0, 0],
            size: [0.7, 0.7, 0.7],
            color: "#ffe9a8",
            material: { emissive: "#ffdf7e" },
          },
        ],
      },
      {
        id: "dining-table",
        kind: "prop",
        name: "Dining table",
        position: [2.5, 0.8, 0],
        size: [3, 1.6, 1.6],
        parts: [
          {
            shape: "box",
            offset: [0, 0.7, 0],
            size: [3, 0.15, 1.6],
            color: "#9c6b45",
            material: { roughness: 0.8, texture: "wood" },
          },
          {
            shape: "cylinder",
            offset: [-1.2, -0.1, -0.5],
            size: [0.15, 1.4, 0.15],
            color: "#7b4b2a",
          },
          {
            shape: "cylinder",
            offset: [1.2, -0.1, -0.5],
            size: [0.15, 1.4, 0.15],
            color: "#7b4b2a",
          },
          {
            shape: "cylinder",
            offset: [-1.2, -0.1, 0.5],
            size: [0.15, 1.4, 0.15],
            color: "#7b4b2a",
          },
          {
            shape: "cylinder",
            offset: [1.2, -0.1, 0.5],
            size: [0.15, 1.4, 0.15],
            color: "#7b4b2a",
          },
        ],
      },
      {
        id: "bookshelf",
        kind: "prop",
        name: "Bookshelf",
        position: [4.8, 1.5, -2.6],
        size: [0.8, 3, 2.4],
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [0.7, 3, 2.4],
            color: "#8b5a42",
            material: { roughness: 0.85, texture: "wood" },
          },
          {
            shape: "box",
            offset: [0.4, -1.2, -0.6],
            size: [0.5, 0.5, 0.3],
            color: "#3b6ea5",
          },
          {
            shape: "box",
            offset: [0.4, 0.3, 0.4],
            size: [0.5, 0.5, 0.3],
            color: "#a53b3b",
          },
        ],
      },
    ],
    objectives: [],
    rules: [
      {
        id: "open-front-door",
        on: { event: "interact", entity: "front-door" },
        if: { op: "==", left: { var: "doorOpen" }, right: 0 },
        then: [
          {
            type: "animate",
            entity: "front-door",
            kind: "slide",
            to: [2.6, 1.5, 5.45],
            duration: 900,
          },
          { type: "openDoor", entity: "front-door" },
          { type: "setVar", key: "doorOpen", value: 1 },
          { type: "playSound", sound: "door-open" },
          { type: "showMessage", text: "The front door slides open." },
        ],
      },
      {
        id: "close-front-door",
        on: { event: "interact", entity: "front-door" },
        if: { op: "==", left: { var: "doorOpen" }, right: 1 },
        then: [
          {
            type: "animate",
            entity: "front-door",
            kind: "slide",
            to: [0, 1.5, 5],
            duration: 900,
          },
          { type: "setVar", key: "doorOpen", value: 0 },
          { type: "playSound", sound: "door-close" },
          { type: "showMessage", text: "The front door slides shut." },
        ],
      },
      {
        id: "lamp-off",
        on: { event: "interact", entity: "floor-lamp" },
        if: { op: "==", left: { var: "lampOn" }, right: 1 },
        then: [
          { type: "setVisible", entity: "lamp-glow", visible: false },
          { type: "setColor", entity: "floor-lamp", color: "#8d8d8d" },
          { type: "setVar", key: "lampOn", value: 0 },
          { type: "playSound", sound: "lamp-click" },
        ],
      },
      {
        id: "lamp-on",
        on: { event: "interact", entity: "floor-lamp" },
        if: { op: "==", left: { var: "lampOn" }, right: 0 },
        then: [
          { type: "setVisible", entity: "lamp-glow", visible: true },
          { type: "setColor", entity: "floor-lamp", color: "#ffd166" },
          { type: "setVar", key: "lampOn", value: 1 },
          { type: "playSound", sound: "lamp-click" },
        ],
      },
    ],
    scratch: { doorOpen: 0, lampOn: 1 },
  }),
  drive: example({
    version: "1.0.0",
    meta: {
      title: "Coastline Sprint",
      archetype: "collect-a-thon",
      mode: "drive",
      genre: "racing",
      difficulty: 0.5,
    },
    world: {
      bounds: [40, 10, 40],
      lighting: "day",
      skybox: "outdoor",
      terrain: { type: "flat", obstacles: [] },
    },
    entities: [
      {
        id: "player",
        kind: "player",
        name: "Racer",
        position: [0, 1, -18],
        props: { vehicle: true, maxSpeed: 16, accel: 9 },
      },
      {
        id: "road",
        kind: "prop",
        name: "Asphalt road",
        position: [0, 0, 0],
        size: [11, 0.3, 40],
        parts: [
          {
            shape: "box",
            offset: [0, 0, 0],
            size: [10, 0.2, 40],
            color: "#3c3f45",
            material: { roughness: 0.95, texture: "grid" },
          },
          {
            shape: "box",
            offset: [-5.3, 0.15, 0],
            size: [0.6, 0.3, 40],
            color: "#e8e2d0",
            material: { roughness: 0.8 },
          },
          {
            shape: "box",
            offset: [5.3, 0.15, 0],
            size: [0.6, 0.3, 40],
            color: "#e8e2d0",
            material: { roughness: 0.8 },
          },
          {
            shape: "box",
            offset: [0, 0.16, -16],
            size: [10, 0.32, 0.8],
            color: "#f2f2f2",
            material: { roughness: 0.8 },
          },
        ],
      },
      {
        id: "finish-arch",
        kind: "prop",
        name: "Finish arch",
        position: [0, 0, 17],
        size: [12, 6, 1],
        parts: [
          {
            shape: "box",
            offset: [-5.5, 3, 0],
            size: [0.8, 6, 0.8],
            color: "#c0392b",
            material: { metalness: 0.4, roughness: 0.5 },
          },
          {
            shape: "box",
            offset: [5.5, 3, 0],
            size: [0.8, 6, 0.8],
            color: "#c0392b",
            material: { metalness: 0.4, roughness: 0.5 },
          },
          {
            shape: "box",
            offset: [0, 5.6, 0],
            size: [12, 0.9, 0.9],
            color: "#c0392b",
            material: { metalness: 0.4, roughness: 0.5 },
          },
        ],
        label: { text: "Finish", offset: [0, 6.6, 0], size: 0.6 },
      },
      {
        id: "checkpoint-1",
        kind: "zone",
        name: "Checkpoint 1",
        position: [0, 1, -12],
        size: [7, 3, 7],
        props: { checkpointIndex: 0 },
      },
      {
        id: "checkpoint-2",
        kind: "zone",
        name: "Checkpoint 2",
        position: [0, 1, -4],
        size: [7, 3, 7],
        props: { checkpointIndex: 1 },
      },
      {
        id: "checkpoint-3",
        kind: "zone",
        name: "Checkpoint 3",
        position: [0, 1, 4],
        size: [7, 3, 7],
        props: { checkpointIndex: 2 },
      },
      {
        id: "checkpoint-4",
        kind: "zone",
        name: "Checkpoint 4",
        position: [0, 1, 12],
        size: [7, 3, 7],
        props: { checkpointIndex: 3 },
      },
    ],
    objectives: [
      {
        id: "pass-checkpoints",
        type: "collect",
        description: "Pass all four checkpoints in order",
        targets: ["checkpoint-1", "checkpoint-2", "checkpoint-3", "checkpoint-4"],
        count: 4,
      },
      {
        id: "beat-the-clock",
        type: "timeLimit",
        description: "Finish the race before the clock runs out",
        time: 90,
      },
    ],
    rules: [
      {
        id: "checkpoint-1",
        on: { event: "playerEnter", zone: "checkpoint-1" },
        then: [
          { type: "incVar", key: "cp" },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
          { type: "showMessage", text: "Checkpoint 1/4" },
        ],
      },
      {
        id: "checkpoint-2",
        on: { event: "playerEnter", zone: "checkpoint-2" },
        if: { op: "==", left: { var: "cp" }, right: 1 },
        then: [
          { type: "incVar", key: "cp" },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
          { type: "showMessage", text: "Checkpoint 2/4" },
        ],
      },
      {
        id: "checkpoint-3",
        on: { event: "playerEnter", zone: "checkpoint-3" },
        if: { op: "==", left: { var: "cp" }, right: 2 },
        then: [
          { type: "incVar", key: "cp" },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
          { type: "showMessage", text: "Checkpoint 3/4" },
        ],
      },
      {
        id: "checkpoint-4",
        on: { event: "playerEnter", zone: "checkpoint-4" },
        if: { op: "==", left: { var: "cp" }, right: 3 },
        then: [
          { type: "incVar", key: "cp" },
          { type: "setVar", key: "lap", value: 1 },
          { type: "objectiveProgress", objective: "pass-checkpoints", by: 1 },
          { type: "showMessage", text: "Lap complete!" },
        ],
      },
      {
        id: "race-won",
        on: { event: "objectiveComplete", objective: "pass-checkpoints" },
        then: [{ type: "win", message: "Checkered flag!" }],
      },
    ],
    scratch: { cp: 0, lap: 0 },
  }),
};

const GAME_WINNABILITY_BLOCK: readonly string[] = [
  "Winnability - required, because objectives never advance on their own:",
  "- Walking over a collectible picks nothing up. For every collect target, add a",
  '  trigger zone (kind "zone") at the same position and one rule that fires on',
  '  {"event":"playerEnter","zone":"<zone-id>"}, despawns the collectible, and',
  "  calls objectiveProgress for that objective.",
  "- For every activate target, add one rule that fires on",
  '  {"event":"interact","entity":"<target-id>"} and calls objectiveProgress.',
  "- For every reach target, add one rule on playerEnter for the destination zone",
  "  that calls objectiveProgress.",
  "- Progress each step exactly once; never reuse one rule to advance two targets.",
  '- Finish every objective with a rule on {"event":"objectiveComplete",',
  '  "objective":"<objective-id>"} whose actions include {"type":"win",...}.',
  "- The game must be winnable through its rules alone.",
];

const EXPLORE_KIT_BLOCK: readonly string[] = [
  "Free-roam scene requirements (explore archetype):",
  '- "objectives" MUST be an empty array: []. There is no win or lose condition;',
  "  never emit win/lose actions and never reference objectives in rules.",
  '- Explore documents MUST NOT include "zone" entities: no trigger volumes,',
  "  no playerEnter rules, no objectives. Props, interactables and decorative",
  "  objects only.",
  '- Populate the scene with a player spawn, a few decorative props (kind "prop"',
  '  with "color", "size" and a "props": { "shape": ... } entry from the',
  "  vocabulary above - prefer tree, rock, campfire, flower, lamp, statue,",
  '  pillar, table or building), and a couple of interactables (kind',
  '  "interactable"). An NPC-like enemy is allowed, but only with "state":',
  '  "idle" and no "sight" so it never chases or harms the player.',
  "- Ambient rules are optional and may only use showMessage, playSound, setVar",
  "  or incVar; every id they reference must exist in the document.",
  "- Keep the ground walkable: flat terrain with no obstacles unless the prompt",
  "  explicitly asks for them.",
];

const INSPECT_KIT_BLOCK: readonly string[] = [
  "Inspect showcase requirements (inspect kit):",
  '- "meta" MUST carry "mode": "inspect" with schema archetype "explore";',
  '  "objectives" MUST be an empty array: []. No win/lose actions, no trigger',
  "  zones and no playerEnter rules - the scene is a clickable showcase.",
  '- Build at least one compound assembly: an entity with several "parts" (a',
  "  board plate plus chips, pins and a connector) laid out around its position,",
  '  and give at least two entities a "label" so they are easy to find.',
  '- Add at least one rule on {"event":"click","entity":"<id>"} whose actions',
  '  call {"type":"showPanel"} with a title and body explaining the part, plus',
  '  {"type":"setColor"} to emphasize the clicked entity.',
  '- Optionally call {"type":"cameraFocus","entity":"<id>"} the first time a part',
  '  is clicked (guard it with a scratch flag such as { "op": "==", "left":',
  '  { "var": "focused" }, "right": 0 }) so the camera eases onto it.',
  "- Keep the scene static and inspectable: no vehicle props, no objectives.",
  "- Budget: at most 12 entities and 8 rules; keep the showcase compact so it",
  "  generates quickly and stays readable.",
];

const WALKTHROUGH_KIT_BLOCK: readonly string[] = [
  "Walkthrough requirements (walkthrough kit):",
  '- "meta" MUST carry "mode": "walkthrough" with schema archetype "explore";',
  '  "objectives" MUST be an empty array: []. No win/lose actions, no trigger',
  "  zones and no playerEnter rules - the place is explored by walking.",
  "- Collision is per entity AABB, never per part: a wall only stops the player",
  '  when it is its own entity with "solid": true and a "size" AABB covering the',
  "  wall. NEVER build the shell as one prop with decorative wall parts - the",
  "  player would walk straight through them.",
  "- Build the walls as separate solid prop entities: back, left, right, and a",
  "  front wall split into two segments that leave a door-width gap. Center the",
  '  wall part on its entity (offset [0,0,0]) so the "size" AABB and the mesh',
  "  line up, and keep the doorway gap clear of every solid AABB. The floor can",
  "  stay the supplied ground plane or be a thin non-solid prop; a roof is",
  "  optional and MUST be non-solid.",
  '- Include a door interactable with "props": { "door": true }, "solid": true',
  '  and a "size" that exactly fills the doorway gap. Give it a var-gated rule',
  '  pair on {"event":"interact","entity":"<door-id>"}: with "if"',
  '  { "op": "==", "left": { "var": "doorOpen" }, "right": 0 } slide it clear',
  '  of the gap with {"type":"animate","kind":"slide","to":[x,y,z],"duration":',
  '  <ms>} and call {"type":"openDoor"}; with "right": 1 slide it back into the',
  "  doorway. Set var doorOpen to 1 and 0 in the two branches - two-phase rule",
  "  evaluation fires exactly one branch per press, so one press opens the door",
  "  and the next closes it.",
  "- Include a non-solid lamp interactable that toggles a glow prop with",
  '  {"type":"setVisible"} and recolors the fixture with {"type":"setColor"},',
  '  gated on a scratch var such as { "op": "==", "left": { "var": "lampOn" },',
  '  "right": 0|1 } so the lamp pair also fires one branch per press.',
  "- Put labels on the door and the lamp so the player knows what is interactive.",
  "- Budget: at most 14 entities and 10 rules. Fewer, richer entities keep",
  "  generation fast and the rooms easy to walk.",
  "- Vary every generation instead of copying the example: change the wall colors",
  "  and materials, the room proportions, the furniture (table, chair, shelf,",
  "  rug, plant) and the layout. Use different colors, counts and positions and",
  "  a fresh title - do not copy the few-shot document verbatim.",
];

const DRIVE_KIT_BLOCK: readonly string[] = [
  "Drive requirements (drive kit):",
  '- "meta" MUST carry "mode": "drive" with schema archetype "collect-a-thon".',
  '- The player entity MUST include "props": { "vehicle": true, "maxSpeed": <n>,',
  '  "accel": <n> }; the engine drives it with throttle and steering (heading 0',
  "  faces +Z, so start the player at the -Z end of the road facing the course).",
  "- Build the track from parts: a road slab, kerbs, a start line and a finish",
  "  arch. Keep the route clear so every checkpoint can be reached by driving.",
  "- Add at least 3 zone entities along the road, each with",
  '  "props": { "checkpointIndex": 0..n-1 } - distinct integers starting at 0 in',
  "  race order.",
  "- Make the race winnable: a collect objective lists every checkpoint zone and",
  '  rules on {"event":"playerEnter","zone":"<checkpoint-id>"} advance a scratch',
  "  counter before calling objectiveProgress, gating later checkpoints with an",
  '  "if" such as { "op": "==", "left": { "var": "cp" }, "right": 1 }. A rule on',
  '  {"event":"objectiveComplete","objective":"<objective-id>"} wins the race.',
  "- Include a timeLimit objective with a generous time and bump scratch.lap when",
  "  the final checkpoint falls. The race must be winnable through its rules.",
  "- Budget: at most 12 entities and 10 rules (checkpoint zones included) so the",
  "  race generates quickly and the route stays clear.",
];

function kitRequirementsBlock(archetype: KitArchetype): readonly string[] {
  if (archetype === "explore") return EXPLORE_KIT_BLOCK;
  if (archetype === "inspect") return INSPECT_KIT_BLOCK;
  if (archetype === "walkthrough") return WALKTHROUGH_KIT_BLOCK;
  if (archetype === "drive") return DRIVE_KIT_BLOCK;
  return GAME_WINNABILITY_BLOCK;
}

export function buildGenerationPrompt(prompt: string, archetype: KitArchetype): string {
  const isExplore = archetype === "explore";
  const isInspect = archetype === "inspect";
  const isWalkthrough = archetype === "walkthrough";
  const isDrive = archetype === "drive";
  const isFreeRoamKit = isExplore || isInspect || isWalkthrough;
  const schemaArchetype = KIT_SCHEMA_ARCHETYPE[archetype];

  return [
    isInspect
      ? `Design a complete, clickable 3D showcase scene that fits the "${archetype}" kit.`
      : isWalkthrough
        ? `Design a complete, walkable 3D interior that fits the "${archetype}" kit.`
        : isDrive
          ? `Design a complete, drivable racing game that fits the "${archetype}" kit.`
          : isExplore
            ? `Design a complete, explorable 3D scene that fits the "${archetype}" archetype.`
            : `Design a complete, playable game that fits the "${archetype}" archetype.`,
    isFreeRoamKit
      ? "It uses the same JSON document shape but has NO objectives, NO trigger zones"
      : "",
    isFreeRoamKit
      ? isInspect
        ? "and no win or lose condition: the player clicks and studies the parts."
        : isWalkthrough
          ? "and no win or lose condition: the player walks the interior in first person."
          : "and no win or lose condition: the player simply roams a small, atmospheric place."
      : "",
    ...(isInspect
      ? [
          "It is an interactive showcase of a real object: parts assemblies with",
          "labels, and click rules that open info panels and highlight what is clicked.",
        ]
      : isWalkthrough
        ? [
            "It is a first-person interior walk: a room of separate solid wall",
            "props with a door and a lamp the player can open and toggle.",
          ]
        : []),
    "",
    "Respond with ONLY one JSON object - no markdown fences, no commentary -",
    "with exactly this shape:",
    `- "version": "${SCHEMA_VERSION}" (exact string)`,
    ...(isInspect || isWalkthrough || isDrive
      ? [
          `- "meta": { "title": non-empty string, "archetype": "${schemaArchetype}"`,
          `  (exact string), "mode": "${archetype}" (exact string), optional`,
          '  "genre" string, optional "difficulty" 0..1, optional "seed" integer }',
        ]
      : [
          '- "meta": { "title": non-empty string, "archetype": the archetype above',
          '  (exact string), optional "genre" string, optional "difficulty" 0..1,',
          '  optional "seed" integer }',
        ]),
    '- "world": { "bounds": [x, y, z] positive numbers; optional "lighting"',
    '  (dawn|day|dusk|night|indoor); optional "skybox" (cave|outdoor|lab);',
    '  optional "gravity" number; optional "terrain": { "type": flat|mesh,',
    '  "obstacles": [ { "position": [x,y,z], "size": [x,y,z] } ] } }',
    '- "entities": non-empty array. Each entity needs a unique non-empty "id",',
    '  a "kind" (player|enemy|collectible|zone|interactable|prop|exitDoor|platform|beam|spawn),',
    '  and a "position" [x,y,z]. Optional: "name", "rotation", "scale", "size",',
    '  "color", "solid", "speed", "patrol", "sight", "state", "props", "tags".',
    '  For kind "prop", set "props": { "shape": "<one of: tree, rock, campfire,',
    '  pillar, statue, lamp, table, flower, building>" } so decorative props',
    '  render as real objects instead of plain boxes. Unknown or missing shapes',
    '  fall back to a box.',
    '  Optional "parts": [ { "shape": "box|sphere|cylinder|cone|torus|capsule|',
    '  wedge|plane", "offset": [x,y,z], "size": [x,y,z], optional "rotation" or',
    '  "color", optional "material": { "metalness"?, "roughness"?, "emissive"?,',
    '  "opacity"?, "texture": "circuit"|"wood"|"brick"|"metal"|"grid"|"glass" } } ]',
    "  builds a compound assembly on the entity. Optional",
    '  "label": { "text": "...", optional "offset": [x,y,z], optional "size":',
    "  number } floats a caption above it.",
    '  "state" may only be "idle" | "patrol" | "chase" | "return"; never invent',
    '  other state names. Exactly one entity must have kind "player".',
    '- "objectives": array of { "id", "type" (collect|reach|survive|avoid|activate|timeLimit),',
    '  optional "description"; for reach/collect/activate include "target" or',
    '  "targets" AND "count" (the number of progress steps needed to finish it:',
    "  1 for a single reach zone, one per collectible or switch otherwise).",
    '  "progress" defaults to 0 and "status" defaults to "active" }',
    isFreeRoamKit
      ? `  For the "${archetype}" kit this array MUST be an empty array: []`
      : "",
    '- "rules": array of { "id", "on": { "event": ... }, optional "if", "then": [...] }',
    '- "scratch": object of string|number|boolean values (may be empty)',
    "",
    "Rule triggers - use only these (the engine emits them):",
    '  {"event":"playerEnter","zone":"<zone-id>"}   fired when the player enters a zone',
    '  {"event":"interact","entity":"<id>"}         fired when the player presses interact near the entity',
    '  {"event":"click","entity":"<id>"}            fired when the player clicks the entity',
    '  {"event":"hoverEnter","entity":"<id>"} / {"event":"hoverLeave","entity":"<id>"}',
    '  {"event":"enemyContact","entity":"<enemy-id>"}',
    '  {"event":"objectiveProgress"|"objectiveComplete"|"objectiveFailed","objective":"<objective-id>"}',
    '  {"event":"playerDeath"} / {"event":"tick"}',
    '  "on.zone", "on.entity", "on.objective", "on.tag" are optional extra filters;',
    "  every id they name must exist in the document.",
    "",
    'Conditions - the optional "if" field must be exactly one of these shapes:',
    '  { "op": "and", "conditions": [ condition, ... ] }',
    '  { "op": "or", "conditions": [ condition, ... ] }',
    '  { "op": "not", "condition": condition }',
    '  { "op": "has", "entity": "<entity-id>" }',
    '  { "op": "hasTag", "tag": "<tag>" }',
    '  { "op": "<"|"<="|">"|">="|"=="|"!=", "left": value, "right": value }',
    '  where value is a number, string, boolean, { "var": "<scratch-key>" }, or',
    '  { "stat": "time"|"ticks"|"entityCount"|"objectiveCount"|"objective.<objective-id>.progress" }.',
    '  Never write a bare object like { "entity": "beam-1" } as a condition;',
    '  test an entity with { "op": "has", "entity": "beam-1" } or omit "if".',
    "",
    'Actions - every entry of "then" must be exactly one of these:',
    '  { "type": "win", "message": "..." } / { "type": "lose", "message": "..." }',
    '  { "type": "showMessage", "text": "..." }  (the field is "text", never "message")',
    '  { "type": "objectiveProgress", "objective": "<objective-id>", "by": 1 }',
    '  { "type": "setObjective", "objective": "<objective-id>", "status": "active"|"done"|"failed" }',
    '  { "type": "setVar", "key": "<name>", "value": number|string|boolean }',
    '  { "type": "incVar", "key": "<name>", "by": 1 }',
    '  { "type": "despawn"|"enable"|"disable"|"openDoor", "entity": "<entity-id>" }',
    '  { "type": "toggle", "target": "<entity-id>" }',
    '  { "type": "teleport", "entity": "<entity-id>", "position": [x,y,z] }',
    '  { "type": "setEnemyState", "entity": "<entity-id>", "state": "idle"|"patrol"|"chase"|"return" }',
    '  { "type": "playSound", "sound": "<name>" }',
    '  { "type": "damage", "entity": "<entity-id>", "amount": 1 }',
    '  { "type": "spawn", "entity": { ...full entity object... } }',
    '  { "type": "setVisible", "entity": "<entity-id>", "visible": true|false }',
    '  { "type": "setColor", "entity": "<entity-id>", "color": "<css-or-hex>" }',
    '  { "type": "animate", "entity": "<entity-id>", "kind": "spin"|"bob"|"pulse"|',
    '    "slide"|"orbit", optional "axis": [x,y,z], "amplitude", "speed",',
    '    "to": [x,y,z], "duration": <ms> } - never animate the player or an enemy:',
    "    they own their movement.",
    '  { "type": "cameraFocus", "entity": "<entity-id>" } (omit entity to clear)',
    '  { "type": "showPanel", "title": "...", "body": "...", optional "entity": "<id>" }',
    '  { "type": "hidePanel", optional "entity": "<id>" }',
    '  Never invent action types (no "stateChange") and never use an event name as an action.',
    "",
    ...kitRequirementsBlock(archetype),
    "",
    isInspect
      ? "Layout - showcase:"
      : isWalkthrough
        ? "Layout - interior:"
        : isDrive
          ? "Layout - track:"
          : "Layout - open ground:",
    "- Every position and patrol point must lie inside world.bounds.",
    '- Unless the user explicitly asks for obstacles or cover, use "terrain": { "type": "flat", "obstacles": [] }.',
    ...(isExplore
      ? [
          "- If obstacles are requested, keep the spawn area and the paths between points",
          "  of interest clear so the whole scene stays walkable.",
        ]
      : isInspect
        ? [
            "- Keep the assembly centered near the origin and place the player spawn in",
            "  front of it so the camera can orbit the whole model.",
          ]
        : isWalkthrough
          ? [
              "- Keep the solid wall AABBs near the bounds and leave the doorway gap",
              "  free; furniture must not overlap a wall or block the doorway.",
              "  Spawn the player clear of every solid AABB, inside the room or just",
              "  outside the door.",
            ]
          : isDrive
            ? [
                "- Keep the road and every checkpoint clear of obstacles so the whole",
                "  circuit is drivable; the player spawn belongs before the first gate.",
              ]
            : [
                "- If obstacles are requested, keep them well clear of the straight line between",
                "  the player spawn and every objective target; targets must be reachable on foot.",
              ]),
    "",
    `Few-shot example for the "${archetype}" archetype`,
    "(structure and quality target - do not copy verbatim):",
    JSON.stringify(ARCHETYPE_EXAMPLES[archetype], null, 2),
    "",
    `Player prompt: ${prompt}`,
    "",
    "Return JSON:",
  ].join("\n");
}

export function parseGameDoc(raw: string): GameDoc {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("generator response contained no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`generator response was not valid JSON: ${message}`);
  }
  return parsed as GameDoc;
}

export async function generate(
  prompt: string,
  archetype: KitArchetype,
  llm: LlmCall
): Promise<GameDoc> {
  const raw = await llm(buildGenerationPrompt(prompt, archetype));
  return parseGameDoc(raw);
}
