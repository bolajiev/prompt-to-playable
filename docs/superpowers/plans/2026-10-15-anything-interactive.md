# Phase 5 — Anything Interactive: parts, interactions, modes/kits

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Turn the system from "4 game archetypes + explore" into a universal interactive-3D generator: assemblies (parts/labels/materials/textures), universal interactions (click/hover/animate/panels/camera focus), and 5 kits (inspect, walkthrough, drive, explore, game) — so prompts like "a 3D PCB", "a house I can walk through", "a car racing game" produce real, interactive scenes with working logic.

**Architecture:** All additions are optional/backward-compatible. Engine stays pure and deterministic; external events (click/hover) are injected as data via `Engine.pushEvent`. Engine owns animation and vehicle motion in `entityRuntime` so collision/triggers see real positions. Renderer draws parts/labels/textures and exposes hover highlight; web does raycast picking, panels UI and mode cameras; server classifies kits and composes kit-specific few-shots.

**Spec:** docs/superpowers/specs/2026-10-09-prompt-to-playable-game-design.md

## Global Constraints
- Backward compatibility: all new schema fields optional; existing fixtures/tests stay green untouched unless explicitly stated.
- Engine purity: no DOM/Three imports; determinism (no Math.random/Date in engine).
- Renderer never mutates engine state; physics extents tests keep passing for existing kinds.
- No new runtime dependencies; no external assets (procedural canvas textures only).
- Secrets: never print/commit keys; `server/.env` gitignored and untouched.
- `npx vitest run` and `npx tsc -b` green after every task.
- Live budget: ≤ 20 generate + ≤ 6 edit calls total for T6/T7 combined; ≤ 2 tuning rounds.

## Interfaces (canonical)

```ts
// packages/schema/src/schema.ts — additions
export const PartShapeSchema = z.enum(["box","sphere","cylinder","cone","torus","capsule","wedge","plane"]);
export const PartMaterialSchema = z.object({ metalness, roughness, emissive, opacity, texture: "circuit"|"wood"|"brick"|"metal"|"grid"|"glass" }).partial().optional();
export const PartSchema = z.object({ shape: PartShapeSchema, offset: Vec3 (default [0,0,0]), size: Vec3 (default [1,1,1]), rotation?: Vec3, color?: string, material? });
// Entity additions: parts?: Part[]; label?: { text, offset?, size? }
// Meta addition: mode?: "inspect"|"walkthrough"|"drive"|"explore"|"game"
// Events: { type:"click", targetId } | { type:"hoverEnter", targetId } | { type:"hoverLeave", targetId }
// Actions additions: setVisible{entity,visible}; setColor{entity,color}; animate{entity,kind:"spin"|"bob"|"pulse"|"slide"|"orbit",axis?,amplitude?,speed?,to?,duration?}; cameraFocus{entity}; showPanel{title,body,entity?}; hidePanel{entity?}
// GameState addition: ui: { panels: {id,title,body,entity?}[], focus?: string }
// EntityRuntime additions: visible: boolean; color?: string; speed?: number (vehicle, scalar); heading?: number (vehicle, radians); animations: AnimationRuntime[]
// AnimationRuntime = { kind, axis?, amplitude?, speed?, to?, duration?, elapsed, basePos: Vec3, baseRot: Vec3 }
```

```ts
// packages/engine/src/engine.ts — API
pushEvent(event: { type:"click"|"hoverEnter"|"hoverLeave", targetId: string }): void; // queued; consumed at next tick start
resolveMode(doc): "inspect"|"walkthrough"|"drive"|"explore"|"game"; // meta.mode ?? (archetype==="explore" ? "explore" : "game")
```

Vehicle (mode drive OR player.props.vehicle === true): throttle=moveZ, steer=moveX; speed += throttle*accel*dt − drag*speed*dt; clamp [−0.4*maxSpeed, maxSpeed]; heading += steer*steerRate*dt*speedFactor; pos += headingVec*speed*dt; AABB collision stops velocity on that axis; no jump. Defaults: maxSpeed 14, accel 10, grip 1 (props override).

Kit sanity (server/src/sanity.ts):
- inspect: ≥1 entity with parts OR label; ≥1 rule with on.click.
- walkthrough: player + ≥1 interactable entity.
- drive: player with props.vehicle true; ≥3 zone entities with props.checkpointIndex (0..n-1); win path required.
- game: win path required (existing). explore: no win path; no zones (soft). inspect/walkthrough: no win path.

---

### Task 1: Schema v1.1 — parts, labels, mode, events, actions
Files: `packages/schema/src/schema.ts`, `packages/schema/tests/schema.test.ts`, `packages/shared/src/types.ts` (mode type if needed)
- Add everything in Interfaces block above (zod schemas + inferred types exported).
- Tests: valid doc with parts/label/mode/new actions/events parses; invalid shapes (bad part shape, bad texture, bad animate kind) fail; old minimal doc still parses (backward compat); defaults applied (offset/size).
- Run `npx vitest run` + `npx tsc -b`. Commit: `feat(schema): parts, labels, modes, interaction events and actions`.

### Task 2: Engine — external events, actions, animations, vehicle
Files: `packages/engine/src/{engine,state,events,tick,rules}.ts`, `packages/engine/src/vehicle.ts` (new), tests `packages/engine/tests/{events-external,actions-v5,animations,vehicle}.test.ts`
- `pushEvent` queue (Engine) → merged into tick's event list (rules see them); click/hoverEnter/hoverLeave trigger matching via `trigger.entity`; hoverLeave has no entity filter semantics — targetId matches.
- Engine API addition: `closePanel(id: string): void` — removes `state.ui.panels` entry deterministically (used by the panels UI close button).
- Runtime additions init in createState + spawn action init.
- Actions: setVisible (runtime.visible), setColor (runtime.color override), animate (creates/replaces AnimationRuntime; slide duration ms; spin/bob/pulse/orbit speed rad/s or Hz), cameraFocus (state.ui.focus = entity), showPanel (state.ui.panels push {id: newId, title, body, entity}), hidePanel (drop by entity or all).
- Animation integration in integrate(): advance elapsed; compute offsets from basePos/baseRot deterministically: spin(y) rot += speed*dt; bob pos.y = base + amplitude*sin(2π*speed*elapsed); pulse → expose factor via runtime (renderer reads; store `pulse` value in runtime.animations entry); slide: lerp basePos→to over duration then stop; orbit: circular XZ path radius amplitude. Zone/trigger checks use updated runtime positions (door slides are real).
- Vehicle controller per Interfaces (vehicle.ts pure functions + integrate branch). Deterministic; collisions via existing resolveXZ with solids.
- `resolveMode` helper exported.
- Tests: external click fires rule (showPanel/setColor/setVisible); hoverEnter/Leave; animations deterministic (two engines same seed/steps → same positions; slide reaches target exactly; bob bounded); vehicle accelerates/steers/bounds/collides and can reach a checkpoint zone within N ticks; panel hide; back-compat: docs without new fields behave identically.
- Commit: `feat(engine): external events, interaction actions, animations, vehicle mode`.

### Task 3: Renderer — parts, labels, textures, hover, vehicle visuals
Files: `packages/render/src/{parts.ts,textures.ts,labels.ts}` (new), `packages/render/src/{renderer,scene}.ts`, tests `packages/render/tests/{parts,textures,labels}.test.ts`
- parts.ts: `buildPartsObject(entity): THREE.Group` — per-part mesh (shape geometry scaled by part.size, offset/rotation local, color/material incl. texture+emissive+opacity); wedge via custom geometry (box sheared) or ExtrudeGeometry triangle; root group placed by entity transform; entity.size scales root when parts present (parts are authored in unit-entity space).
- textures.ts: procedural CanvasTexture cache: circuit/wood/brick/metal/grid/glass (deterministic patterns; node-safe guard `typeof document`).
- labels.ts: canvas sprite (text, size scale, always faces camera); offset from entity; follows runtime position; hidden when entity runtime.visible false.
- renderer: entity with parts uses parts path (no geometryForKind); runtime.visible toggles object.visible; runtime.color override re-tints root materials; animations apply: rotation/position offsets (bob/spin/orbit/slide from runtime positions — engine already moves position; renderer only applies ROTATION from spin/orbit and pulse scale for pulse); highlight API `setHighlight(id|null)` (emissive boost or scale 1.06); vehicle: if player has parts, wheels = parts with `props.wheel`? — skip: wheels spin via part name "wheel-*"? Keep simple: no wheel spin (arcade). 
- Tests: parts group child count/extents within unit box; texture names resolve + node fallback; label sprite creation (node guard); highlight toggling idempotent; visible=false hides; existing extents/materials tests unchanged.
- Commit: `feat(render): assemblies, labels, procedural textures, hover and mode visuals`.

### Task 4: Web — picking, panels, mode cameras and HUD
Files: `apps/web/src/ui/{picking.ts,panels.ts,mode-hud.ts}` (new), `apps/web/src/{app.ts,input.ts?}`, `apps/web/src/ui/camera-rig.ts`, `apps/web/index.html`, tests `apps/web/tests/{picking,panels,mode-hud}.test.ts`
- picking.ts: pure `pickEntityId(raycaster, camera, objects)` wrapper + click-vs-drag discrimination (movement < 6px, duration < 350ms).
- app.ts: pointermove → hover id → renderer.setHighlight + canvas cursor; pointerup(click) → engine.pushEvent({type:"click",targetId}); panels overlay renders state.ui.panels (title, body, close button → injects `hidePanel`? No — panels are engine state; closing should dispatch an internal action: simplest: close button calls a new engine API `closePanel(id)`... avoid engine API sprawl: use hidePanel rule via click? Decision: `engine.pushEvent({type:"click", targetId: panel-close-<id>})` is hacky. RULING: add `Engine.closePanel(id: string)` that mutates state.ui deterministically (engine-owned UI state). Document in Task 2 (add to Engine API).
- Mode cameras: resolveMode(doc): inspect/explore/game → orbit (existing rig, default offset for game/explore; inspect: closer default distance 10, pitch 0.35); walkthrough → first-person (position at player eye 1.6, yaw/pitch from drag, movement already camera-relative); drive → chase (camera at player − heading*dist + up, lerp; no orbit, no drag swing).
- mode-hud.ts: pure `hudForMode(mode, state)` → lines (inspect: object name hint; walkthrough: "WASD move · drag to look · E interact" + crosshair flag; drive: speed km/h from runtime.speed, lap from scratch.lap, time; game/explore existing). index.html: crosshair element + panels container + speed/lap display; hide per mode.
- Chips: add "a 3D PCB I can click and inspect", "a house I can walk through", "a car racing game", "a robot with animated arms" (8 chips total, wrapping row).
- Tests: picking discrimination pure cases; panels render list + close dispatch; hudForMode outputs per mode; camera mode selection function.
- Commit: `feat(web): click picking, panels UI, mode cameras and HUD, new chips`.

### Task 5: Server — kits classifier, generator few-shots, sanity
Files: `server/src/{classifier,generator,sanity,pipeline,edit}.ts`, tests `server/tests/{classifier,generator,sanity}.test.ts`, `scripts/eval-corpus.ts` (kit fallback mock)
- classifier: output set = 4 game archetypes + explore + inspect + walkthrough + drive; examples: PCB/product/machine → inspect; house/museum/room-to-walk → walkthrough; racing/track/car → drive; goals → games; ambient scenes → explore. Deterministic keyword fallback extended (pcb|circuit|board|product|viewer|machine|engine → inspect; house|building|museum|interior|room walk → walkthrough; race|racing|track|car|kart|lap → drive).
- generator: prompt catalogs updated (parts/labels/materials/new actions); kit few-shots: inspect (PCB: parts board+chips+pins, labels, click→showPanel+setColor, cameraFocus), walkthrough (house: walls/roof/door/table/lamp parts, door interact→animate slide+openDoor, lamp interact→setVisible/setColor, labels), drive (race: road parts, player props.vehicle, 4 checkpoint zones with props.checkpointIndex in sequence rules, lap var, timeLimit objective, win rule). Few-shots self-validated at load.
- sanity: kit branches per Interfaces; keep existing game checks; repair prompt notes kit constraints.
- edit prompt: mention new actions/parts vocabulary.
- eval-corpus mock: extend to cover new kits for the 21-prompt corpus (only fallback path; keep green).
- Tests: classifier mapping for 12+ prompts incl. PCB/house/race; kit sanity accept/reject cases; few-shots valid; game/explore unchanged.
- Commit: `feat(server): inspect, walkthrough and drive kits with kit sanity`.

### Task 6: Live eval v5 + offline playtests
Files: `scripts/prompts-judge-v5.json`, `scripts/llm-smoke.ts` (kit usability labels), `tests/playtest-v5.test.ts`, `tests/fixtures/kit-*.json`, `docs/llm-eval-2026-10-15.md`
- prompts: 6 new-kit (PCB ×2 variants, house, museum-lite, race ×2) + 4 games + 3 explore + 2 edits ≈ 15; --no-write for smoke, then capture good docs as `tests/fixtures/kit-*.json` (commit only 3-4 needed by playtests).
- smoke usability per mode: inspect: valid + ≥1 parts/label + ≥1 click rule; walkthrough: valid + player + ≥1 interactable; drive: valid + vehicle + ≥3 checkpoints + win path; game: win path; explore: 0 zones.
- playtest-v5 (offline, no network): inspect fixture → pushEvent click on labeled entity → assert panel appears + setColor effect; walkthrough fixture → steer to door, press interact (rising edge), assert door position moves (slide) and/or open tag; drive fixture → throttle/steer pursuit to checkpoints in order → status won within 6000 ticks.
- Tune (≤2 rounds) only via prompts/few-shots; never weaken schema/sanity.
- Doc: table + usability per kit + budget + honest caveats.
- Commit: `test(llm): kit eval v5 and offline interactive playtests`.

### Task 7: Deploy + QA beats + docs + final verification
- QA script: add `--kits` beat: PCB inspect (click a labeled entity → panel visible), house walkthrough (E on door → position change via __gameDebug), race (drive 5s, speed>0, lap counter visible). Budget ≤ 6 live calls.
- Deploy Vercel prod; run QA (games + explore + kits) with screenshots; view.
- README/description: five kits, new chips, eval v5 link, test counts; category unchanged.
- Final: tsc, full suite, purity grep, push origin. Ledger completion.
- Commit: `docs: kits, eval v5, QA beats; deploy verified`.

## Acceptance
- "a 3D PCB…" → inspect scene: assemblies, labels, click → panel/highlight (live).
- "a house I can walk through" → first-person, door opens, lamps toggle (live).
- "a car racing game" → drive with throttle/steer, checkpoints, lap/time HUD, win (live).
- Games + explore unchanged (regression suites + playtests green).
- All tests green; engine pure; no external assets/deps; fixtures committed for offline playtests; docs updated; deployed and QA-passed.
