# Playability & Live-LLM Integration Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated games actually playable with keyboard input (movement, collision, enemies, interaction) and prove the real LLM pipeline works end-to-end against a live (cheap) API.

**Architecture:** Engine stays pure TS and gains a data-driven `InputState`; `integrate` implements movement, gravity, AABB collision on XZ/Y, and enemy state machines. The web client maps keyboard events to `InputState` and passes it to `engine.step`. The server gains `OPENAI_BASE_URL` support and a live smoke script that uses the gitignored `server/.env`. Live-model outputs are captured as committed fixtures and replayed in a deterministic playtest test (pure input steering to a win).

**Tech Stack:** existing monorepo (TS, Vitest, Three.js, Express, Zod) + OpenAI-compatible endpoint (`gemini-3.1-flash-lite` via `server/.env`).

**Spec:** docs/superpowers/specs/2026-10-09-prompt-to-playable-game-design.md

## Global Constraints
- Engine is pure TS: **no DOM/Three imports**, no timers, deterministic (fixed timestep + seeded RNG).
- Renderer never mutates engine state; position authority is `state.entityRuntime[id].position` (entities array is the static doc copy).
- Client only receives validated JSON; all LLM output passes Zod + sanity checks.
- Edit pipeline uses RFC 6902 JSON Patch only.
- **Secrets:** the live API key exists only in `server/.env` (gitignored, mode 600). Never print the key, never commit it, never write it to any other file, never include it in prompts/reports/logs. Use `server/.env.example` for documentation.
- **Live testing uses the cheap model** configured in `server/.env` (`OPENAI_MODEL=gemini-3.1-flash-lite`, `OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`). Budget: ≤ 8 generate + ≤ 4 edit calls per tuning iteration, ≤ 3 iterations.
- Keep test style consistent: plain `test(...)` with `expect`, importing built `dist` or source paths as existing tests do.
- Existing tests must keep passing; when behavior intentionally changes (e.g., gravity settles the player), update the affected tests in the same task.
- YAGNI: no jump animations, no pointer lock, no moving platforms, no pathfinding for enemies (patrol paths + straight-line chase only).

## Interfaces (used across tasks)

```ts
// packages/engine/src/input.ts (new)
export interface InputState {
  moveX: number; // strafe, -1..1
  moveZ: number; // forward, -1..1 (positive Z)
  jump: boolean;
  interact: boolean;
}
export const NEUTRAL_INPUT: InputState;
export function sanitizeInput(input?: Partial<InputState>): InputState;
```

```ts
// packages/engine/src/state.ts (extended)
export interface EntityRuntime {
  position: Vec3;
  rotation?: Vec3;
  active: boolean;
  state?: EnemyState;
  tags: string[];
  velocity: Vec3;      // NEW
  grounded: boolean;   // NEW
  contactArmed?: boolean; // NEW (enemy contact edge)
  waypointIndex?: number; // NEW (patrol)
}
// GameState gains: input: InputState; prevInput: InputState;
```

Engine entry points (existing files, signatures extended):
- `tick(state: GameState, dt: number, input?: InputState): GameState`
- `Engine.step(dtMs: number, input?: InputState): GameState`

Live tests must be skippable offline: guard with `describe.skipIf(!process.env.OPENAI_API_KEY)` only for tests that call the network; the fixtures replay test (P2.8) never calls the network.

---

## Task P2.0: Input model + player movement (walk + gravity + floor)

**Files:**
- Create: `packages/engine/src/input.ts`
- Modify: `packages/engine/src/state.ts` (EntityRuntime fields, GameState.input/prevInput, createState init)
- Modify: `packages/engine/src/tick.ts` (integrate: player XZ movement + gravity + floor rest)
- Modify: `packages/engine/src/engine.ts` (step passes input; store last input for substeps)
- Modify: `packages/engine/src/index.ts` (export input module)
- Test: `packages/engine/tests/movement.test.ts`

**Interfaces:**
- Consumes: `Entity.speed` (schema, optional), `world.gravity` (default 9.8), `entityRuntime` (position authority).
- Produces: `InputState`, `NEUTRAL_INPUT`, `sanitizeInput`, `tick(state, dt, input)`, `Engine.step(dtMs, input)`, runtime `velocity`/`grounded`.

- [ ] **Step P2.0.1: Write `input.ts`**
```ts
export interface InputState {
  moveX: number;
  moveZ: number;
  jump: boolean;
  interact: boolean;
}
export const NEUTRAL_INPUT: InputState = { moveX: 0, moveZ: 0, jump: false, interact: false };
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
```

- [ ] **Step P2.0.2: Extend `state.ts`** — add `velocity: [0,0,0]`, `grounded: false` to every EntityRuntime in `createState`; add `input: { ...NEUTRAL_INPUT }`, `prevInput: { ...NEUTRAL_INPUT }` to GameState + initialization.

- [ ] **Step P2.0.3: Write failing tests** (`movement.test.ts`): minimal valid doc with player at `[0, 5, 0]`, flat world:
  1. `tick` with neutral input for 2s → player y settles at floor (center y = halfHeight, default size `[0.6,1.8,0.6]` → 0.9) and `grounded === true`.
  2. hold `moveZ: 1` for 1s → z increased by ~`speed` (use `speed: 6`, assert 5.5..6.5).
  3. `sanitizeInput` clamps `moveX: 5` → 1 and coerces `jump: "yes"` → false.
  4. input is stored: after `tick(..., input)`, `state.input.moveZ === 1`, `state.prevInput` equals previous input.
  5. determinism: two engines, same seed + identical input sequence → identical positions.

- [ ] **Step P2.0.4: Implement `integrate` player branch**
```ts
const FLOOR_Y = 0;
const DEFAULT_PLAYER_SIZE: Vec3 = [0.6, 1.8, 0.6];
// inside integrate(state, dt, input):
//  player = active player entity; rt = entityRuntime[player.id]
//  speed = player.speed ?? 6
//  rt.velocity[0] = input.moveX * speed
//  rt.velocity[2] = input.moveZ * speed
//  rt.velocity[1] += -state.doc.world.gravity * dt
//  if (input.jump && rt.grounded) rt.velocity[1] = player.props?.jumpSpeed ?? 8 (number)
//  rt.position[0] += rt.velocity[0]*dt; rt.position[2] += rt.velocity[2]*dt
//  rt.position[1] += rt.velocity[1]*dt
//  halfHeight = (player.size?.[1] ?? DEFAULT_PLAYER_SIZE[1]) / 2
//  if (rt.position[1] <= FLOOR_Y + halfHeight) { rt.position[1] = FLOOR_Y + halfHeight; rt.velocity[1] = 0; rt.grounded = true } else rt.grounded = false
//  clamp XZ to world.bounds/2 minus half-size
```
Return a new state (copy-on-write like existing code).

- [ ] **Step P2.0.5: Pass input through** — `tick(state, dt, input = NEUTRAL_INPUT)`: sanitize, set `prevInput = state.input`, `input = sanitized` on the new state before systems run; `Engine.step(dtMs, input)` forwards the same input to each fixed substep and updates `this.state` accordingly (store `lastInput` for calls without arg? No — default arg is `NEUTRAL_INPUT`; the web always passes input).

- [ ] **Step P2.0.6: Run tests — new and old**
```bash
npx vitest run packages/engine/tests
```
Fix any old tests broken by gravity settling (update expectations deliberately; note in report).

- [ ] **Step P2.0.7: Commit**
```bash
git add packages/engine/src packages/engine/tests
git commit -m "feat(engine): input model, player movement, gravity, floor rest"
```

---

## Task P2.1: Obstacle/platform AABB collision + jump landing

**Files:**
- Modify: `packages/engine/src/collision.ts` (add `resolveAxis`, `aabbFromBox`)
- Modify: `packages/engine/src/tick.ts` (integrate: solids + axis-separated resolution)
- Test: `packages/engine/tests/collision-resolve.test.ts`

**Interfaces:**
- Consumes: `world.terrain.obstacles: {position, size}[]`, entities with `solid === true` or `kind === "platform"`, player runtime velocity/grounded.
- Produces: `collectSolids(state): AABB[]`, `resolveXZ(position, velocity, size, solids): {position, velocity}`, `resolveY(position, velocity, size, solids): {position, velocity, grounded}`.

- [ ] **Step P2.1.1: Extend `collision.ts`**
```ts
export interface Box { position: Vec3; size: Vec3 }
export function aabbFromBox(box: Box): AABB; // center + size → min/max
export function collectSolids(doc: GameDoc, isActive: (id: string) => boolean): AABB[]; // terrain.obstacles + solid/platform entities
export function resolveXZ(pos: Vec3, vel: Vec3, size: Vec3, solids: AABB[]): { pos: Vec3; vel: Vec3 }; // per-axis pushout
export function resolveY(pos: Vec3, vel: Vec3, size: Vec3, solids: AABB[]): { pos: Vec3; vel: Vec3; grounded: boolean }; // land on top when falling
```

- [ ] **Step P2.1.2: Write failing tests**: (1) walking into a wall stops X but slides on Z; (2) falling onto a platform top rests at `top + halfHeight` with `grounded`; (3) jumping onto an obstacle top works; (4) walking off a platform falls to floor; (5) standing under a low ceiling stops upward velocity.

- [ ] **Step P2.1.3: Integrate into `integrate`**: XZ resolution before Y resolution; player only (enemies get solids too in P2.2).

- [ ] **Step P2.1.4: Run tests**
```bash
npx vitest run packages/engine/tests
```

- [ ] **Step P2.1.5: Commit**
```bash
git add packages/engine/src/collision.ts packages/engine/src/tick.ts packages/engine/tests/collision-resolve.test.ts
git commit -m "feat(engine): AABB obstacle/platform collision and jump landing"
```

---

## Task P2.2: Enemy AI (patrol/chase/return) + `enemyContact` events

**Files:**
- Modify: `packages/engine/src/events.ts` (add `enemyContact`)
- Modify: `packages/engine/src/tick.ts` (integrate: enemy branches; broadphase: contact events)
- Modify: `packages/engine/src/rules.ts` (map `enemyContact` in `eventEntityIds`)
- Test: `packages/engine/tests/enemy-ai.test.ts`

**Interfaces:**
- Consumes: `Entity.patrol: Vec3[]`, `Entity.sight`, `Entity.state`, `Entity.speed`.
- Produces: event `{ type: "enemyContact"; entityId: string; targetId: string }`; runtime fields `state`, `waypointIndex`, `contactArmed`.

- [ ] **Step P2.2.1: Add event type** to `events.ts` union: `| { type: "enemyContact"; entityId: string; targetId: string }`.

- [ ] **Step P2.2.2: Write failing tests**:
  1. enemy with `patrol: [[0,0,0],[5,0,0]]`, no sight → moves back and forth between waypoints (y settles on floor), `state === "patrol"`.
  2. player within `sight` → `state === "chase"`, enemy position approaches player.
  3. player moves beyond `sight * 1.25` → `state === "return"`, enemy heads back to `patrol[0]`.
  4. enemy overlapping player emits exactly one `enemyContact` (rising edge), re-arms after separation.
  5. determinism: same seed + steps → identical enemy positions.

- [ ] **Step P2.2.3: Implement enemy branches in `integrate`**: per active enemy: resolve state (`entity.state ?? (patrol.length ? "patrol" : "idle")`), move at `speed ?? 2.5`, gravity + floor + solids (reuse resolve helpers), patrol wrap at dist < 0.15, chase/return thresholds per above. Only XZ motion for enemies; `grounded` applies.

- [ ] **Step P2.2.4: Emit `enemyContact` in `broadphase`**: AABB overlap between enemy and player; rising edge via `contactArmed` (set false on emit, true on separation). Add rule trigger mapping: for `enemyContact`, `eventEntityIds` returns `[entityId]` (the enemy).

- [ ] **Step P2.2.5: Run tests + full suite**
```bash
npx vitest run
```

- [ ] **Step P2.2.6: Commit**
```bash
git add packages/engine/src packages/engine/tests/enemy-ai.test.ts
git commit -m "feat(engine): enemy patrol/chase AI and enemyContact events"
```

---

## Task P2.3: `interact`, `objectiveProgress`/`objectiveFailed` events, terminal step guard

**Files:**
- Modify: `packages/engine/src/events.ts` (add `objectiveFailed`)
- Modify: `packages/engine/src/tick.ts` (interact emission; objective transition events incl. progress; terminal guard already in tick loop — verify)
- Modify: `packages/engine/src/engine.ts` (early-return when status !== "running")
- Test: `packages/engine/tests/interact-progress.test.ts`

**Interfaces:**
- Consumes: `input.interact` rising edge (`state.input` vs `state.prevInput`), entity tags/kind, objectives progress deltas.
- Produces: `interact` events for nearest active entity with tag `"interactable"` (or `kind === "interactable"`) within `props.interactRange ?? 2.5`; `objectiveProgress` events on progress increase; `objectiveFailed` on `active → failed` transition.

- [ ] **Step P2.3.1: Write failing tests**:
  1. press `interact` (rising edge) near an interactable → exactly one `interact` event with `targetId`; holding the key emits nothing more.
  2. out of range → no event.
  3. rule on `objectiveProgress` fires when progress increases (chains to `incVar`).
  4. `timeLimit` objective failing emits `objectiveFailed`; a rule `on: {event:"objectiveFailed"}` triggers `lose`.
  5. after `status === "won"`, further `Engine.step` calls do not advance `time`/`ticks`.

- [ ] **Step P2.3.2: Implement** — interact detection after movement (nearest by distance); objective diff emits progress increases + failures; `Engine.step` early-return on non-running status.

- [ ] **Step P2.3.3: Run tests**
```bash
npx vitest run packages/engine/tests
```

- [ ] **Step P2.3.4: Commit**
```bash
git add packages/engine/src packages/engine/tests/interact-progress.test.ts
git commit -m "feat(engine): interact and objective transition events; terminal step guard"
```

---

## Task P2.4: Web — keyboard input wiring + controls hint

**Files:**
- Create: `apps/web/src/ui/input.ts` (keyboard → `InputState`)
- Modify: `apps/web/src/app.ts` (per-frame input; pass to `engine.step`; blur clears keys)
- Modify: `apps/web/index.html` (controls line in HUD)
- Test: `apps/web/tests/input.test.ts` (pure mapping logic; no DOM)

**Interfaces:**
- Consumes: `InputState`, `sanitizeInput` (engine).
- Produces: `createKeyboardState(): { setKey(code: string, down: boolean): void; clear(): void; toInput(): InputState }` with the mapping below.

- [ ] **Step P2.4.1: Write mapping tests** (pure, no DOM): W/ArrowUp → `moveZ +1`; S/ArrowDown → `moveZ -1`; A/ArrowLeft → `moveX -1`; D/ArrowRight → `moveX +1`; Space → jump; KeyE → interact; diagonal W+D → both axes 1; `clear()` → neutral.

- [ ] **Step P2.4.2: Implement `input.ts`** with a `Set<string>` of held codes; `toInput()` derives the `InputState`; both keys of a pair OR'd; conflicting axes cancel only if both held (e.g., W+S → 0).

- [ ] **Step P2.4.3: Wire into `app.ts`**: window `keydown`/`keyup` (preventDefault for Space/arrows to stop page scroll), `blur` → clear; in the RAF loop compute `input.toInput()` and call `engine.step(dtMs, input)` (keep terminal-status gate and reconcile as-is).

- [ ] **Step P2.4.4: Add controls hint** to `index.html` HUD area: `WASD move · Space jump · E interact`.

- [ ] **Step P2.4.5: Run web tests + full suite**
```bash
npx vitest run && npx tsc -b
```

- [ ] **Step P2.4.6: Commit**
```bash
git add apps/web
git commit -m "feat(web): keyboard input wiring and controls hint"
```

---

## Task P2.5: LLM base-URL env + live smoke script + secret hygiene

**Files:**
- Modify: `server/src/llm.ts` (`OPENAI_BASE_URL` env fallback)
- Create: `server/src/env.ts` (tiny dotenv loader, no dependency)
- Create: `scripts/llm-smoke.ts` (live generate + edit against `server/.env`)
- Create: `server/.env.example` (names only, no values)
- Create: `server/tests/secrets.test.ts` (no key leakage in errors; `.env` gitignored)
- Modify: root `package.json` (`"llm:smoke": "tsx scripts/llm-smoke.ts"`)

**Interfaces:**
- Consumes (exact, verified): `createOpenAiLlm()`, `generateGame(prompt, deps)` with `createDefaultPipelineDeps(llm)`; `editGame(prompt, doc, history, deps)` / `createEditPipeline(deps)` with `createDefaultEditDeps(llm)`; `validateGame` from schema; `sanityCheck` from `server/src/sanity.ts`.
- Produces: `loadEnvFile(path): void` (fills `process.env` only when unset); `npm run llm:smoke` exit 0/1 with a printed summary of valid/edited games (no secrets).

- [ ] **Step P2.5.1: `env.ts`**
```ts
export function loadEnvFile(path: string): boolean {
  // read file if exists; for each non-# line with KEY=VALUE (first '='),
  // trim quotes; if process.env[KEY] === undefined → set it. Never log values.
}
```

- [ ] **Step P2.5.2: `llm.ts`** — `const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL?.trim() ?? "https://api.openai.com/v1").replace(/\/+$/, "")`.

- [ ] **Step P2.5.3: `llm-smoke.ts`** — `loadEnvFile("server/.env")`; build real deps; for each of 2 prompts (`collect 3 crystals avoiding one guard`, `puzzle room: rotate three beams...`) run the real generate pipeline; then one real edit (`add a second guard patrolling`); after each: `validateGame` + `sanityCheck`; write successful docs to `tests/fixtures/live-<slug>.json` (pretty-printed); print `prompt → archetype → valid/solvable/latency` lines only; exit 1 if any stage fails. **Never print prompts' raw LLM output or any env value.**

- [ ] **Step P2.5.4: `secrets.test.ts`**
  1. spin a local `http` server returning 500; point `createOpenAiLlm` at it with `apiKey: "test-secret-value"`; assert the thrown error does **not** contain `"test-secret-value"`.
  2. `git check-ignore server/.env` exits 0.
  3. `server/.env.example` contains only names, no `sk-`/`AIza` values (regex assert).

- [ ] **Step P2.5.5: Run smoke (live, cheap model) + tests**
```bash
npm run llm:smoke && npx vitest run
```

- [ ] **Step P2.5.6: Commit** (fixtures included)
```bash
git add server/src server/.env.example server/tests scripts/llm-smoke.ts tests/fixtures package.json
git commit -m "feat(server): OPENAI_BASE_URL support, live smoke script, secret hygiene tests"
```

---

## Task P2.6: Live prompt tuning + capture fixtures

**Files:**
- Modify: `server/src/generator.ts` (prompt/few-shots only if first iteration has failures)
- Create: `docs/llm-eval-2026-10-12.md`
- Create/Refresh: `tests/fixtures/live-*.json`

**Interfaces:**
- Consumes: `npm run llm:smoke`, budget ≤ 8 generate + 4 edit per iteration, ≤ 3 iterations.
- Produces: documented eval table + fixtures for P2.8. Also generate at least 2 **open-layout** fixtures suitable for deterministic auto-play (few obstacles, targets in open ground) by using prompts that say so.

- [ ] **Step P2.6.1: Run iteration 1** (`npm run llm:smoke`), record per-prompt: classified archetype, valid?, solvable (sanity), latency, failure class if any.

- [ ] **Step P2.6.2: If failures:** adjust generator prompt (JSON discipline, coordinate rules, keep targets in open ground, bounds) and rerun. Max 3 iterations; never edit the schema to mask a prompt bug.

- [ ] **Step P2.6.3: Write `docs/llm-eval-2026-10-12.md`** with the table, the model/endpoint name (no key), and the tuning changes attempted.

- [ ] **Step P2.6.4: Commit**
```bash
git add server/src/generator.ts docs/llm-eval-2026-10-12.md tests/fixtures
git commit -m "test(llm): live prompt eval, fixtures, generator prompt tuning"
```

---

## Task P2.7: Server hardening (route sanity, 400s, redacted 500s, patch values)

**Files:**
- Modify: `server/src/routes.ts` (final sanity gate; error mapping; generic 500 message)
- Modify: `server/src/patch.ts` (`deepClone` skips `__proto__`/`constructor`/`prototype` keys)
- Modify: `server/tests/routes.test.ts`, `server/tests/patch.test.ts`

**Interfaces:**
- Produces: `/generate` and `/edit` run `sanityCheck` before responding; malformed JSON body → 400 `{error:"BAD_REQUEST", details}`; oversized payload → 413; 500 body is exactly `{error:"INTERNAL_ERROR"}` (no `err.message`).

- [ ] **Step P2.7.1: Failing tests**: (1) raw invalid JSON body → 400; (2) `sanityCheck` failure injected via a stub handler downstream still 400? (route-level gate test: stub pipeline returns doc with orphan ref → 400); (3) 500 does not echo the thrown message; (4) patch with `value: {"__proto__": {"polluted": 1}}` does not pollute `Object.prototype` and applies cleanly.

- [ ] **Step P2.7.2: Implement mappings**: in `errorHandler`, check `err.status`/`err.type` from body parser (`entity.parse.failed` → 400, `entity.too.large` → 413), keep `RouteError` → its status, else 500 generic.

- [ ] **Step P2.7.3: Run tests; commit**
```bash
npx vitest run server/tests
git add server/src server/tests
git commit -m "fix(server): route-level sanity, 400/413 mapping, redacted 500s, safe patch values"
```

---

## Task P2.8: Deterministic playtest over live fixtures (input-only wins)

**Files:**
- Create: `tests/playtest.test.ts`
- Create: `tests/helpers/steer.ts` (pure steering helper using only `Engine.step` + `InputState`)

**Interfaces:**
- Consumes: fixtures from `tests/fixtures/live-*.json`, `Engine`, `InputState`.
- Produces: `steerTo(engine, target: Vec3, maxTicks: number): boolean` — per tick: compute direction to target, set `moveX/moveZ` (normalized), jump if target above and grounded, interact briefly when within 1.5 units; step; stop when within 0.5.

- [ ] **Step P2.8.1: Write failing test** — for each fixture whose `meta.archetype` is `collect-a-thon` or `puzzle-switch`: `engine.load(fixture)`; for `collect` objectives steer to each target in order; for `activate` objectives steer to each target and press interact; assert `getState().status === "won"` within 3000 ticks. Require ≥ 2 fixtures passing (at least one per archetype); fixtures that cannot be auto-played after 3 steering attempts may be excluded from the test with an explicit list + reason in a comment.

- [ ] **Step P2.8.2: Implement `steer.ts`** (no engine internals beyond `getState()`/`step()`; obstacle avoidance: if XZ movement over the last 10 ticks is < 0.05 while not at target, add a 90° sidestep for 20 ticks).

- [ ] **Step P2.8.3: Run**
```bash
npx vitest run tests/playtest.test.ts
```

- [ ] **Step P2.8.4: Commit**
```bash
git add tests/playtest.test.ts tests/helpers/steer.ts
git commit -m "test: deterministic input-only playtest over live LLM fixtures"
```

---

## Task P2.9: Docs + final verification

**Files:**
- Modify: `README.md` (run instructions incl. `server/.env` setup with env **names**, controls, `llm:smoke`, eval link, note any OpenAI-compatible endpoint works incl. DeepSeek/Gemini)
- Modify: `docs/submission/demo-script.md` (controls + live pipeline beat)
- Create: `docs/submission/description.md` update only if needed for new playability claims

- [ ] **Step P2.9.1: README updates** — setup, run (server + web), controls table, live eval results link, reliability statement (real-model eval numbers from P2.6).
- [ ] **Step P2.9.2: Demo script update** — include movement/jump/interact and one live-generation beat.
- [ ] **Step P2.9.3: Verify**
```bash
npx tsc -b && npx vitest run && grep -rn "three\|document\|window" packages/engine/src
```
Expected: clean build, all tests pass, engine grep no matches.
- [ ] **Step P2.9.4: Commit**
```bash
git add README.md docs/submission
git commit -m "docs: playability controls, live eval, run instructions"
```

---

## Acceptance Criteria
- Keyboard playability: WASD/arrows move, Space jumps, E interacts, gravity + obstacle/platform collision + enemies (patrol/chase) work — proven by engine tests.
- A real model (`gemini-3.1-flash-lite` via `server/.env`) generates validated, solvable games and a working edit; results committed as fixtures + eval doc.
- ≥ 2 live fixtures are auto-won by pure input steering in CI (offline).
- `npm run llm:smoke` works from a clean checkout with `server/.env` present; without it, fails with a clear message (no key needed for the rest of the test suite).
- No secret ever appears in source, tests, fixtures, docs, or logs; `server/.env` is gitignored (test-enforced).
- All existing + new tests green; `tsc -b` clean; engine purity intact.

## Notes / Deviations from Phase 1 plan
- Phase 1 left movement/AI as stubs; this plan makes them real (Phase 1 Task 6 review findings F1/F2 addressed in P2.3).
- Server hardening items come from Phase 1 task reviews (Task 8 F1/F3/F6, Task 10 F1).
- The live key was found in this machine's opencode logs at the operator's request; it is used only via `server/.env` for live smoke/eval. Rotate the key after the hackathon.
