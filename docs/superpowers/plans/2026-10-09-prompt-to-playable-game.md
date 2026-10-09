# Prompt-to-Playable Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn plain language into an interactive 3D browser game with working logic, using schema-first data-driven architecture.

**Architecture:** LLM emits validated Zod-conforming JSON → pure TS engine executes rules/objectives → Three.js renderer draws scene. Backend validates/repairs and never exposes API keys. All game logic is data (no arbitrary codegen). Engine ⇄ renderer boundary is strict (no Three imports in engine). Client only sees validated JSON.

**Tech Stack:** TypeScript, Three.js, Zod, Vitest, Node/Express (thin backend), seeded RNG, RFC 6902 JSON patches, fixed timestep.

**Spec:** docs/superpowers/specs/2026-10-09-prompt-to-playable-game-design.md

## Global Constraints
- Desktop browser target.
- Single-player, no auth/persistence/multiplayer.
- Reliability > novelty; reliability is first-class (validation + sanity checks + repair ≤ 2 retries).
- Engine is pure TS with **no DOM/Three.js imports**.
- Renderer never mutates engine state; engine never imports Three.js/DOM.
- Client only receives **validated JSON**.
- Deterministic simulation (fixed timestep + seeded RNG).
- Data-driven: logic is rules/objectives/entities/scratch only (no arbitrary code execution).
- JSON Patch (RFC 6902) for conversational edits.
- Validation badge indicates Zod + sanity checks passed.
- Target: ≥95% valid+solvable on prompt corpus (track in README).
- YAGNI: max 4 archetypes; cut breadth if behind; Week 8 feature freeze.
- Schema is single source of truth; versioned (`version: "1.0.0"`).

## Packages layout
- `packages/schema` — Zod schema, TS types, validators, version
- `packages/engine` — pure TS runtime (state, tick, rules evaluator, objectives, collision, AI)
- `packages/render` — Three.js renderer + reconciliation
- `packages/shared` — small shared utils (ids, math, events, types)
- `server` — thin Node/Express for `/generate`, `/edit`, validation/repair, archetype classifier, sanity checks
- `apps/web` — client UI (chat, HUD, canvas, validation badge)

---

## Task 0: Repo bootstrap & tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `README.md`
- Create: `.gitignore`
- Create: `packages/schema/package.json`, `packages/engine/package.json`, `packages/render/package.json`, `packages/shared/package.json`, `server/package.json`, `apps/web/package.json`

**Interfaces:**
- Consumes: none
- Produces: workspace tooling, test runner, TypeScript project refs

- [ ] **Step 0.1: Write root package.json (workspaces + scripts)**
```json
{
  "name": "prompt-to-playable",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "workspaces": [
    "packages/*",
    "server",
    "apps/web"
  ],
  "scripts": {
    "build": "tsc -b",
    "dev": "echo 'run server + web separately'",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.7.4",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1",
    "zod": "^3.23.8"
  }
}
```

- [ ] **Step 0.2: Write tsconfig.base.json**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": ".",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "composite": true
  }
}
```

- [ ] **Step 0.3: Write root tsconfig.json with project refs**
```json
{
  "files": [],
  "references": [
    { "path": "packages/shared" },
    { "path": "packages/schema" },
    { "path": "packages/engine" },
    { "path": "packages/render" },
    { "path": "server" },
    { "path": "apps/web" }
  ]
}
```

- [ ] **Step 0.4: Write vitest.config.ts**
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { globals: true, environment: "node" },
  resolve: { alias: {} }
});
```

- [ ] **Step 0.5: Write .gitignore**
```text
node_modules
dist
*.log
.env
.DS_Store
coverage
.vite
```

- [ ] **Step 0.6: Create package.json files for each workspace**
Create minimal package.json for each: schema/engine/render/shared/server/apps/web with appropriate names and deps (Three.js only in render/apps/web; zod/vitest available).

- [ ] **Step 0.7: Write README.md skeleton**
```markdown
# Prompt-to-Playable Game

Prompt → playable 3D scene with working logic. Schema-first, data-driven.

## Dev
npm install
npm test

## Target
≥95% valid+solvable on prompt corpus. See docs/superpowers/specs/...
```

- [ ] **Step 0.8: Commit**
```bash
git add package.json tsconfig*.json vitest.config.ts .gitignore README.md packages/*/package.json server/package.json apps/web/package.json
git commit -m "chore: repo bootstrap with workspaces and tooling"
```

---

## Task 1: Schema — types, IDs, RNG seed, base types

**Files:**
- Create: `packages/shared/src/id.ts`
- Create: `packages/shared/src/math.ts`
- Create: `packages/shared/src/rng.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/tests/rng.test.ts`
- Modify: `packages/shared/tsconfig.json` (or create)

**Interfaces:**
- Consumes: none
- Produces: `newId()`, `SeededRng`, `Vec3`, `AABB`, `EntityId`, `ObjectiveId`, `RuleId`, `GameId`

- [ ] **Step 1.1: Write shared tsconfig.json**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src"]
}
```

- [ ] **Step 1.2: Write id.ts (EntityId/ObjectiveId/RuleId branded or string)**
```ts
export type EntityId = string & { __brand: "EntityId" };
export type ObjectiveId = string & { __brand: "ObjectiveId" };
export type RuleId = string & { __brand: "RuleId" };
export type GameId = string & { __brand: "GameId" };
export function newId(prefix = "id"): EntityId {
  return (prefix + "_" + Math.random().toString(36).slice(2, 9)) as EntityId;
}
```

- [ ] **Step 1.3: Write math.ts (Vec3, AABB)**
```ts
export type Vec3 = [number, number, number];
export interface AABB {
  min: Vec3;
  max: Vec3;
}
export function dist(a: Vec3, b: Vec3): number {
  const dx=a[0]-b[0], dy=a[1]-b[1], dz=a[2]-b[2];
  return Math.sqrt(dx*dx+dy*dy+dz*dz);
}
```

- [ ] **Step 1.4: Write rng.ts (SeededRng, deterministic)**
```ts
export class SeededRng {
  private s: number;
  constructor(seed: number = 123456789) { this.s = seed >>> 0; }
  next(): number {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 2**32;
  }
  int(max: number): number { return Math.floor(this.next() * max); }
}
```

- [ ] **Step 1.5: Write types.ts**
```ts
export type Status = "active"|"done"|"failed";
export type Archetype = "collect-a-thon"|"puzzle-switch"|"platformer-lite"|"stealth-chase";
```

- [ ] **Step 1.6: Write index.ts re-exports**
```ts
export * from "./id.js";
export * from "./math.js";
export * from "./rng.js";
export * from "./types.js";
```

- [ ] **Step 1.7: Write failing test for RNG determinism**
```ts
import { SeededRng } from "../src/rng.js";
test("rng deterministic", () => {
  const a = new SeededRng(42), b = new SeededRng(42);
  const va=[a.next(),a.next(),a.next()], vb=[b.next(),b.next(),b.next()];
  expect(va).toEqual(vb);
});
```

- [ ] **Step 1.8: Run test to verify it fails (optional if not run yet) — expected behavior: passes once written correctly**
```bash
npx vitest run packages/shared/tests/rng.test.ts
```
(If it fails due to import style, fix imports to .js as above.)

- [ ] **Step 1.9: Commit**
```bash
git add packages/shared/src packages/shared/tests packages/shared/tsconfig.json
git commit -m "feat(shared): add ids, math, seeded rng, base types"
```

---

## Task 2: Schema — Zod game schema + types

**Files:**
- Create: `packages/schema/src/schema.ts`
- Create: `packages/schema/src/validators.ts`
- Create: `packages/schema/src/index.ts`
- Create: `packages/schema/tests/schema.test.ts`
- Create: `packages/schema/tsconfig.json`

**Interfaces:**
- Consumes: `EntityId/ObjectiveId/RuleId` types (shared) conceptually; uses strings in Zod with branded types via type inference
- Produces: `GameSchema`, `GameDoc`, `Entity`, `Objective`, `Rule`, `World`, `Meta`, `validateGame`, `isGame`

- [ ] **Step 2.1: schema tsconfig.json**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src"]
}
```

- [ ] **Step 2.2: Write schema.ts (minimal valid shape per spec)**
Define Zod objects: Vec3 tuple [number,number,number], Entity, Objective, Rule (on/if/then), World, Meta, GameDoc with `version: "1.0.0"`, `archetype` enum, `objectives`/`entities`/`rules` arrays, `scratch` record.

Keep rule actions/events constrained to the allowed set from spec.

- [ ] **Step 2.3: Write validators.ts**
```ts
import { GameSchema } from "./schema.js";
export function validateGame(doc: unknown) {
  const r = GameSchema.safeParse(doc);
  return { ok: r.success, data: r.success ? r.data : undefined, error: r.success ? undefined : r.error };
}
export function isGame(doc: unknown): doc is GameDoc { return GameSchema.safeParse(doc).success; }
```
(Type `GameDoc` exported from schema.ts.)

- [ ] **Step 2.4: Write index.ts**
```ts
export * from "./schema.js";
export * from "./validators.js";
```

- [ ] **Step 2.5: Write failing test — minimal valid doc passes**
Create a tiny valid game JSON (player + one objective + no rules minimal) and assert `isGame` true.

- [ ] **Step 2.6: Run test to verify it fails (implement schema until passes)**
```bash
npx vitest run packages/schema/tests/schema.test.ts
```

- [ ] **Step 2.7: Write another test — missing player or bad archetype fails**
Assert `isGame` false for cases.

- [ ] **Step 2.8: Run tests — both pass**
```bash
npx vitest run packages/schema/tests
```

- [ ] **Step 2.9: Commit**
```bash
git add packages/schema/src packages/schema/tests packages/schema/tsconfig.json
git commit -m "feat(schema): add Zod game schema, validators, types"
```

---

## Task 3: Engine — state, events, fixed timestep, tick skeleton

**Files:**
- Create: `packages/engine/src/state.ts`
- Create: `packages/engine/src/events.ts`
- Create: `packages/engine/src/tick.ts`
- Create: `packages/engine/src/engine.ts`
- Create: `packages/engine/src/index.ts`
- Create: `packages/engine/tsconfig.json`
- Create: `packages/engine/tests/state.test.ts`

**Interfaces:**
- Consumes: `GameDoc`, `EntityId`, `Vec3`, `SeededRng` (shared/schema types)
- Produces: `GameState`, `Engine`, `tick`, `emitEvents`, `step` API

Constraints: **no Three.js/DOM imports**.

- [ ] **Step 3.1: engine tsconfig.json**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src"]
}
```

- [ ] **Step 3.2: events.ts (event types)**
```ts
export type GameEvent =
  | { type: "playerEnter"; zoneId: string; entityId: string }
  | { type: "objectiveComplete"; objectiveId: string }
  | { type: "objectiveProgress"; objectiveId: string; by: number }
  | { type: "playerDeath" }
  | { type: "interact"; targetId: string; entityId: string }
  | { type: "tick" };
```

- [ ] **Step 3.3: state.ts (GameState shape)**
State holds copy of game doc + runtime fields (time, win/lose, rng, entity runtime state). Keep immutable-friendly where possible; tick produces new state.

- [ ] **Step 3.4: tick.ts (fixed timestep scaffold)**
`tick(state, dt)` returns new state; systems order per spec (integrate → broadphase → events → rules → objectives → cleanup). Start with skeleton that advances time and emits tick events.

- [ ] **Step 3.5: engine.ts (Engine class or createEngine)**
Holds current state, runs fixed-step loop logic (accumulate dt), exposes `step(dt)`, `getState()`, `load(doc, seed?)`.

- [ ] **Step 3.6: index.ts exports**
```ts
export * from "./state.js";
export * from "./events.js";
export * from "./tick.js";
export * from "./engine.js";
```

- [ ] **Step 3.7: Write failing test — engine loads doc and ticks**
Create minimal valid GameDoc, load into engine, step(16.666), assert state.time increases.

- [ ] **Step 3.8: Implement minimal code to make test pass**
```bash
npx vitest run packages/engine/tests/state.test.ts
```

- [ ] **Step 3.9: Commit**
```bash
git add packages/engine/src packages/engine/tests packages/engine/tsconfig.json
git commit -m "feat(engine): state, events, tick skeleton, engine API"
```

---

## Task 4: Engine — collision (AABB/sphere) + objectives

**Files:**
- Create: `packages/engine/src/collision.ts`
- Create: `packages/engine/src/objectives.ts`
- Create: `packages/engine/tests/collision.test.ts`
- Create: `packages/engine/tests/objectives.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `AABB`, `Entity`, `Objective`, `GameState`
- Produces: `pointInAABB`, `aabbOverlap`, `sphereOverlap`, `updateObjectives(state, events)`

- [ ] **Step 4.1: collision.ts**
Implement AABB tests (overlap, point-in). Sphere minimal if needed later.

- [ ] **Step 4.2: objectives.ts**
Update objective statuses based on events (collect/progress/complete). Set done/failed according to type.

- [ ] **Step 4.3: Write failing collision test**
Point inside AABB returns true; overlap true/false cases.

- [ ] **Step 4.4: Implement to pass**
```bash
npx vitest run packages/engine/tests/collision.test.ts
```

- [ ] **Step 4.5: Write failing objectives test**
Collect progress updates objective count; complete when count reached.

- [ ] **Step 4.6: Implement to pass**
```bash
npx vitest run packages/engine/tests/objectives.test.ts
```

- [ ] **Step 4.7: Commit**
```bash
git add packages/engine/src/collision.ts packages/engine/src/objectives.ts packages/engine/tests/collision.test.ts packages/engine/tests/objectives.test.ts
git commit -m "feat(engine): collision utils and objectives updater"
```

---

## Task 5: Engine — rules DSL evaluator

**Files:**
- Create: `packages/engine/src/rules.ts`
- Create: `packages/engine/tests/rules.test.ts`
- Modify: `packages/engine/src/index.ts` to export rules

**Interfaces:**
- Consumes: `Rule`, `GameState`, `GameEvent`
- Produces: `evaluateRules(state, events)` returns `{ state: GameState, actions: Action[] }` (or mutates via new state)

Data-driven only. No eval/Function.

- [ ] **Step 5.1: rules.ts**
Parse conditions (and/or, comparisons over scratch/stats). Map events to matching rules. Execute actions by name from allowed set: spawn/despawn, setVar/incVar, objectiveProgress/setObjective, win/lose, showMessage, setEnemyState, teleport, damage, enable/disable, addObjective, openDoor, toggle.

Create new state for scratch/flags (immutable updates).

- [ ] **Step 5.2: Write failing test — playerEnter triggers despawn + progress**
Set up minimal state with crystal + rule r1; fire playerEnter event; assert crystal despawned and objective progressed.

- [ ] **Step 5.3: Implement minimal evaluator to pass**
```bash
npx vitest run packages/engine/tests/rules.test.ts
```

- [ ] **Step 5.4: Write failing test — conditions (if scratch.crystals_lit < 3)**
Only execute if true.

- [ ] **Step 5.5: Implement condition eval; test passes**
```bash
npx vitest run packages/engine/tests/rules.test.ts
```

- [ ] **Step 5.6: Export from index.ts**
Add export for rules.

- [ ] **Step 5.7: Commit**
```bash
git add packages/engine/src/rules.ts packages/engine/tests/rules.test.ts packages/engine/src/index.ts
git commit -m "feat(engine): data-driven rules DSL evaluator with conditions/actions"
```

---

## Task 6: Engine — wire tick with rules+objectives+collision events

**Files:**
- Modify: `packages/engine/src/tick.ts`
- Modify: `packages/engine/src/engine.ts`
- Create: `packages/engine/tests/integration.test.ts`

**Interfaces:**
- Consumes: `collision`, `objectives`, `rules`, `events`
- Produces: fully integrated tick producing events and updating state deterministically

- [ ] **Step 6.1: Write failing integration test**
Hardcoded tiny puzzle-like JSON: player enters zone near collectible → rule fires → objective completes → exitDoor spawns conceptually (or win condition). Assert state changes.

- [ ] **Step 6.2: Wire tick systems in order**
integrate (movement stub) → broadphase (AABB zone checks) → emit playerEnter events → evaluateRules → updateObjectives → emit completion events → re-eval rules if needed (small loop) → cleanup.

Keep pure.

- [ ] **Step 6.3: Make test pass**
```bash
npx vitest run packages/engine/tests/integration.test.ts
```

- [ ] **Step 6.4: Determinism test — same seed + steps give same state**
```bash
npx vitest run packages/engine/tests/integration.test.ts
```

- [ ] **Step 6.5: Commit**
```bash
git add packages/engine/src/tick.ts packages/engine/src/engine.ts packages/engine/tests/integration.test.ts
git commit -m "feat(engine): integrate collision events, rules, objectives in tick; determinism"
```

---

## Task 7: Render — Three.js reconciliation (engine→renderer)

**Files:**
- Create: `packages/render/src/renderer.ts`
- Create: `packages/render/src/scene.ts`
- Create: `packages/render/src/index.ts`
- Create: `packages/render/tsconfig.json`
- Create: `packages/render/tests/reconcile.test.ts` (node env; can mock Three minimally or test mapping logic)

**Interfaces:**
- Consumes: `GameState` (engine), entity ids
- Produces: `Renderer` that reconciles entities by id (create/update/remove). **No engine mutation**.

Note: Three.js types available; actual Three objects created in browser context later (apps/web), but reconciliation logic (diff by id) is testable in node by extracting pure functions.

- [ ] **Step 7.1: render tsconfig.json**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src"]
}
```

- [ ] **Step 7.2: scene.ts (pure diff logic)**
`diffEntities(prevIds:Set<string>, next:Entity[])` returns {create, update, remove} by id. This is testable without Three.

- [ ] **Step 7.3: renderer.ts (adapter)**
Takes Three.js scene + camera; exposes `reconcile(state)`. Uses scene diff to add/remove meshes; updates transforms. Never calls engine APIs that mutate.

- [ ] **Step 7.4: index.ts**
```ts
export * from "./scene.js";
export * from "./renderer.js";
```

- [ ] **Step 7.5: Write failing test — diff creates/removes/keeps**
prev {a,b}, next {b,c} → create c, remove a, update b.

- [ ] **Step 7.6: Implement to pass**
```bash
npx vitest run packages/render/tests/reconcile.test.ts
```

- [ ] **Step 7.7: Commit**
```bash
git add packages/render/src packages/render/tests packages/render/tsconfig.json
git commit -m "feat(render): entity reconciliation diff + Three renderer adapter (no engine mutation)"
```

---

## Task 8: Server — validation, sanity checks, repair scaffolding

**Files:**
- Create: `server/src/validate.ts`
- Create: `server/src/sanity.ts`
- Create: `server/src/repair.ts`
- Create: `server/src/routes.ts`
- Create: `server/src/index.ts`
- Create: `server/tsconfig.json`
- Create: `server/tests/validate.test.ts`
- Create: `server/tests/sanity.test.ts`

**Interfaces:**
- Consumes: `validateGame`, `GameDoc` (schema), `Vec3`
- Produces: `validateAndSanity(doc)`, `SanityResult { ok, errors[] }`, `repairPrompt(errors, doc)` (scaffold)

- [ ] **Step 8.1: server tsconfig.json**
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src"]
}
```

- [ ] **Step 8.2: validate.ts (wrap schema + structured errors)**
Return structured result with human-readable messages on failure.

- [ ] **Step 8.3: sanity.ts (invariants)**
Checks:
- All objective target entity IDs exist in entities list
- Player exists (id "player" or kind player)
- Entities referenced by rules (by id) exist
- Bounds respected for positions (all entity positions inside world.bounds ± small epsilon)
- No orphan references
- Reachability heuristic: at minimum, path exists from player to each `reach`/`collect` target? Implement conservative A* on 2D grid over obstacles (stubbed obstacles allowed) or simple straight-line if no obstacles. Must be deterministic.

- [ ] **Step 8.4: repair.ts (scaffold)**
`buildRepairPrompt(doc, errors)` returns prompt text instructing LLM to return corrected JSON matching schema (and explaining errors). Max 2 retries enforced at call site.

- [ ] **Step 8.5: Write validate test — rejects bad doc with structured errors**
```bash
npx vitest run server/tests/validate.test.ts
```

- [ ] **Step 8.6: Write sanity test — rejects unsolvable-like obvious bad case (orphan target)**
```bash
npx vitest run server/tests/sanity.test.ts
```

- [ ] **Step 8.7: routes.ts (Express) — POST /generate, POST /edit**
Contracts:
- `/generate` body: { prompt: string } → returns validated GameDoc (after classifier+generator+validate+repair+sanity). On failure after 2 repairs, return 400 with { error, details }.
- `/edit` body: { prompt: string, game: GameDoc, history?: any[] } → must return **RFC 6902 JSON Patch** (or alternatively apply+return patched doc). Spec states: LLM returns JSON Patch only; server applies+validates+sanity checks. Return patched validated doc or patch+doc.

Return only validated JSON to client.

- [ ] **Step 8.8: index.ts (server bootstrap) — reads API key from env, no logging of secrets**
```bash
npx vitest run server/tests
```

- [ ] **Step 8.9: Commit**
```bash
git add server/src server/tests server/tsconfig.json
git commit -m "feat(server): validation, sanity checks, repair scaffold, routes contracts"
```

---

## Task 9: Server — generation pipeline (classifier + generator + repair loop)

**Files:**
- Create: `server/src/classifier.ts`
- Create: `server/src/generator.ts`
- Create: `server/src/pipeline.ts`
- Create: `server/tests/pipeline.test.ts` (mock LLM)

**Interfaces:**
- Consumes: `validateGame`, `sanity`, `repair`, schema
- Produces: `classify(prompt)` constrained to allowed archetypes; `generate(prompt, archetype)` returns structured JSON; `generateGame(prompt)` orchestrates with ≤2 repairs

- [ ] **Step 9.1: classifier.ts**
Prompt LLM: return one of the 4 archetypes. Constrain output to enum. Fallback to `collect-a-thon` if unclear but valid.

- [ ] **Step 9.2: generator.ts**
Few-shot examples for each archetype (minimal valid docs). Instruct structured JSON output matching schema. Include version, bounds, player spawn, entities, objectives, rules, scratch.

- [ ] **Step 9.3: pipeline.ts**
Flow: classify → generate → validate → if fail: repair+retry (count++) → sanity → if fail: repair+retry (count++) → return validated doc. Enforce max 2 retries total or per stage; on exhaustion throw with structured errors.

- [ ] **Step 9.4: Write failing pipeline test with mocked LLM**
Mock classifier to return puzzle-switch, generator to return valid doc first try → returns doc.

- [ ] **Step 9.5: Implement to pass**
```bash
npx vitest run server/tests/pipeline.test.ts
```

- [ ] **Step 9.6: Write test — invalid doc triggers repair (mock repair returns fixed doc)**
```bash
npx vitest run server/tests/pipeline.test.ts
```

- [ ] **Step 9.7: Commit**
```bash
git add server/src/classifier.ts server/src/generator.ts server/src/pipeline.ts server/tests/pipeline.test.ts
git commit -m "feat(server): archetype classifier, generator, generation pipeline with ≤2 repairs"
```

---

## Task 10: Server — edit pipeline with JSON Patch (RFC 6902)

**Files:**
- Create: `server/src/patch.ts`
- Create: `server/src/edit.ts`
- Create: `server/tests/patch.test.ts`
- Create: `server/tests/edit.test.ts`

**Interfaces:**
- Consumes: `GameDoc`, `validateGame`, `sanity`
- Produces: `applyPatch(doc, patch)`, `generatePatch(prompt, doc, history)` scaffold, `editGame(prompt, doc, history)` returns {doc, patch}

- [ ] **Step 10.1: patch.ts (RFC 6902 apply)**
Minimal apply: supports add/remove/replace/move? Keep minimal (add/remove/replace/path-based). Validate patch shape. Return new doc or throw on invalid path/op.

- [ ] **Step 10.2: Write failing patch test — replace meta.title**
```bash
npx vitest run server/tests/patch.test.ts
```

- [ ] **Step 10.3: Implement applyPatch to pass**
```bash
npx vitest run server/tests/patch.test.ts
```

- [ ] **Step 10.4: edit.ts**
LLM instructed to return **JSON Patch only** (array of ops). Apply → re-validate → sanity → if fail, request repair (explain why patch invalid/broke invariants) with ≤2 retries. On success return patched validated doc.

- [ ] **Step 10.5: Write failing edit test with mocks**
Valid patch applied cleanly → returns patched doc.

- [ ] **Step 10.6: Implement to pass**
```bash
npx vitest run server/tests/edit.test.ts
```

- [ ] **Step 10.7: Wire routes.ts to use editGame**
POST /edit returns { doc: validatedGameDoc, patch } (or just doc; include patch for debugging).

- [ ] **Step 10.8: Commit**
```bash
git add server/src/patch.ts server/src/edit.ts server/tests/patch.test.ts server/tests/edit.test.ts server/src/routes.ts
git commit -m "feat(server): RFC 6902 JSON Patch apply + edit pipeline with validation/sanity"
```

---

## Task 11: Apps/web — UI (chat, HUD, canvas, validation badge)

**Files:**
- Create: `apps/web/src/main.ts`
- Create: `apps/web/src/ui/chat.ts`
- Create: `apps/web/src/ui/hud.ts`
- Create: `apps/web/src/ui/badge.ts`
- Create: `apps/web/src/app.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/vite.config.ts` (or build config)
- Create: `apps/web/tsconfig.json`

**Interfaces:**
- Consumes: `Engine`, `Renderer` (packages), `GameDoc`
- Produces: minimal working UI: input → call /generate → load engine+renderer → show HUD + validation badge

- [ ] **Step 11.1: apps/web tsconfig.json**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src"]
}
```

- [ ] **Step 11.2: index.html**
Canvas for Three.js + chat form + HUD div + badge span.

- [ ] **Step 11.3: ui/badge.ts**
Shows "validated ✔" when current game passed validation (client can track last validated doc).

- [ ] **Step 11.4: ui/hud.ts**
Renders objectives list with status (active/done/failed), timer, win/lose banner.

- [ ] **Step 11.5: ui/chat.ts**
Form submit → calls backend, shows loading, handles errors.

- [ ] **Step 11.6: app.ts**
Wires engine (fixed timestep loop) + renderer + UI. Subscribes to engine state; updates HUD each frame (or on change). On generate success, load doc, set badge true.

- [ ] **Step 11.7: main.ts**
Bootstrap app.

- [ ] **Step 11.8: vite.config.ts (minimal)**
```ts
import { defineConfig } from "vite";
export default defineConfig({});
```

- [ ] **Step 11.9: Commit**
```bash
git add apps/web/src apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json
git commit -m "feat(web): chat, HUD, canvas, validation badge wired to engine+renderer"
```

---

## Task 12: End-to-end smoke test + prompt corpus harness

**Files:**
- Create: `scripts/eval-corpus.ts`
- Create: `scripts/corpus.json`
- Create: `tests/e2e.smoke.test.ts`
- Modify: `package.json` to add `eval:corpus` script

**Interfaces:**
- Consumes: `pipeline` (server) or full stack; uses mocks for LLM in unit, but harness can be run against mocks
- Produces: corpus eval that reports % valid+solvable

- [ ] **Step 12.1: corpus.json (≥20 prompts)**
Cover both archetypes: collect-a-thon (e.g. "collect 3 crystals avoiding guards"), puzzle-switch (e.g. "puzzle room where I rotate beams to light 3 crystals"), platformer-lite, stealth-chase variants.

- [ ] **Step 12.2: eval-corpus.ts**
Runs pipeline against each prompt with mocked LLM that returns schema-valid docs for known prompts (deterministic). Computes `% valid`, `% solvable`, counts. Fails if < 95%.

- [ ] **Step 12.3: package.json script**
```json
"eval:corpus": "tsx scripts/eval-corpus.ts"
```
(Add tsx as dev dep if needed.)

- [ ] **Step 12.4: Write smoke test — generate minimal playable game end-to-end**
Mock LLM end-to-end; assert engine can load and tick without errors; objectives/rules behave.

- [ ] **Step 12.5: Run smoke + all unit tests**
```bash
npx vitest run
```
All pass.

- [ ] **Step 12.6: Commit**
```bash
git add scripts/eval-corpus.ts scripts/corpus.json tests/e2e.smoke.test.ts package.json
git commit -m "test: e2e smoke + prompt corpus harness (target ≥95%)"
```

---

## Task 13: Polish, README, submission prep

**Files:**
- Modify: `README.md`
- Create: `docs/submission/description.md`
- Create: `docs/submission/demo-script.md`

**Interfaces:**
- Consumes: all packages
- Produces: judge-ready artifacts

- [ ] **Step 13.1: Update README.md**
Include: what it is, architecture (schema-first), how to run (dev), how to test, reliability metric (≥95%), tech stack, spec link, submission notes. Document that client sees only validated JSON; engine pure TS; JSON Patch for edits.

- [ ] **Step 13.2: Write description.md (short written description for submission)**
Explain: built prompt-to-playable game; problem/opportunity (make interactive 3D creation conversational with working logic); how AI used (archetype classifier + structured generator + constrained schema + repair + conversational edits via JSON Patch).

- [ ] **Step 13.3: Write demo-script.md (<3 min)**
Script: 0:00 prompt → 0:30 playable → play/fail → "add second guard and timer" → re-edit live → win. Emphasize plain language → working logic.

- [ ] **Step 13.4: Verify corpus target logic (optional run)**
```bash
npm run eval:corpus
```

- [ ] **Step 13.5: Commit**
```bash
git add README.md docs/submission/description.md docs/submission/demo-script.md
git commit -m "docs: submission artifacts (README, description, demo script)"
```

---

## Task 14: Final verification

**Files:**
- (no new files)

**Interfaces:**
- Consumes: full test suite
- Produces: green build

- [ ] **Step 14.1: Type check**
```bash
npx tsc --noEmit
```
(or `npm run build`)

- [ ] **Step 14.2: Run all tests**
```bash
npx vitest run
```
All tests pass.

- [ ] **Step 14.3: Engine has no Three/DOM imports (sanity)**
```bash
grep -rn "three\|document\|window" packages/engine/src
```
Expected: no matches.

- [ ] **Step 14.4: Schema validation covers version and archetypes**
Quick check: invalid archetype fails; missing version or bad version? If desired, add test. (Not blocking if present.)

- [ ] **Step 14.5: Commit (final)**
```bash
git add -A
git commit -m "chore: final verification — types+tests green; engine pure"
```

---

## Acceptance Criteria
- Engine is pure TS (no Three/DOM). Renderer never mutates engine state.
- Schema-first: all LLM output validated via Zod; client only sees validated JSON.
- Generation pipeline: classifier + structured generator + ≤2 repairs + sanity checks; rejects unsolvable/invalid docs.
- Edit pipeline: JSON Patch (RFC 6902) only; patched doc re-validated + sanity checked; badge shows "validated ✔".
- Deterministic: fixed timestep + seeded RNG; determinism tests pass.
- Rules DSL is data-driven (no arbitrary code execution).
- Corpus eval target ≥95% valid+solvable (harness present).
- UI shows chat, HUD, canvas, validation badge.
- End-to-end smoke test passes.
- Submission artifacts present (README, description, demo script).

---

## Notes
- Keep files focused (one responsibility). Renderer reconciliation tested via pure diff.
- Schema is frozen in practice once Task 2 done; versioned `1.0.0`.
- Cut archetypes if any fail to meet quality by Week 8 (not required to implement all 4; start with 2).
- Hosting: static client + thin backend; both accessible during judging.