# Win-Readiness Polish Plan (Phase 4) — visuals, UX, prompt coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Raise the submission from "works" to "wins" against the article's factors: visual quality, usability, effectiveness, scalability — while keeping the article's hard requirement (plain language → 3D scenes + working logic) intact.

**Architecture:** `packages/render` gains procedural visuals/animation/particles (no external assets — licensing-safe). `apps/web` gains audio (WebAudio synth), mouse-orbit camera, onboarding UI and progress states. `server` gains an `explore` (free-roam scene) archetype so any prompt yields something meaningful; sanity/UI handle objective-less scenes. All existing invariants stay: engine pure TS, renderer never mutates engine state, mesh extents == physics AABB, client sees validated JSON only, tests green.

**Tech Stack:** existing monorepo; no new runtime deps. Textures drawn at runtime via canvas; SFX synthesized via WebAudio.

**Spec:** docs/superpowers/specs/2026-10-09-prompt-to-playable-game-design.md

## Global Constraints
- No external art/audio assets (procedural only). No new runtime dependencies.
- Engine purity: no DOM/Three in `packages/engine`.
- Renderer meshes for physics entities keep `Box3` extents equal to engine AABBs (existing extents tests must pass).
- Deterministic engine untouched except the `explore` archetype additions (classifier/generator/sanity/UI only; engine already supports zero objectives — verify).
- Secrets: never print/commit keys; `server/.env` stays gitignored.
- Keep `npx vitest run` and `npx tsc -b` green after every task.
- Generation latency can be 20–30s: UI must show progress and never look frozen; serverless cap 60s — keep prompts tight enough to avoid repair loops in the common case.

## Tasks

### Task 1: Render — lighting, sky, ground, material language
Files: `packages/render/src/lighting.ts` (new), `packages/render/src/scene.ts`, `packages/render/src/renderer.ts`, `apps/web/src/app.ts`, tests `packages/render/tests/lighting.test.ts`
- Lighting presets per `world.lighting` (dawn/day/dusk/night/indoor) with a brightness floor: ambient + hemisphere + directional; nights are moonlit, never black.
- Background per `world.skybox`: gradient via CanvasTexture (cave/outdoor/lab), plus subtle fog matched to background.
- Ground: procedural checker/grid CanvasTexture tinted by terrain type; obstacles rendered as matching material.
- Emissive pop: collectibles emissive; interactables emissive ring; exit doors glow.
- Tests: preset brightness floor (ambient+hemisphere intensity >= threshold for every lighting value); background color function deterministic; NO THREE import outside render/app.
- Run render+web suites; commit.

### Task 2: Render — animation, facing, particles
Files: `packages/render/src/animation.ts` (new), `packages/render/src/particles.ts` (new), `packages/render/src/renderer.ts`, tests
- Player: walk bob amplitude/frequency driven by horizontal speed; idle sway; yaw faces movement direction (lerp).
- Enemies: bob; yaw faces patrol/chase direction.
- Collectibles: spin + emissive pulse.
- Interactables: pulse/ring highlight when player within 2.5 units (read state positions; no mutation).
- Particles (THREE.Points, pooled): collect burst when an entity disappears from state between reconciles; win confetti when status flips to `won`; lose shake flash when `lost`.
- CRITICAL: physics extents tests keep passing — decorations must not change the root mesh Box3 (use child meshes excluded via `userData.visualOnly` or keep root geometry extents exact; particle systems live outside entity meshes).
- Tests: animation phase functions pure + deterministic; particle spawn/expire logic pure; extents regression stays green.
- Commit.

### Task 3: Web — audio + mouse orbit camera
Files: `apps/web/src/ui/audio.ts` (new), `apps/web/src/app.ts`, `apps/web/src/ui/camera-rig.ts` (new), tests `apps/web/tests/audio.test.ts`, `apps/web/tests/camera-rig.test.ts`
- WebAudio synth SFX (no files): collect (rising blip), enemy hit (low buzz), jump (short chirp), interact (click), win (arpeggio), lose (descend). Triggered by state diffs in app loop (entity removed → collect; status won/lost; input jump edge).
- AudioContext created lazily on first user gesture (autoplay policy).
- Camera rig: third-person follow (existing lerp) + mouse drag to orbit yaw/pitch around player + wheel zoom; clamp pitch/zoom; when not dragging, yaw eases back to default behind-player.
- Input transformation already camera-relative: keep working with orbit yaw (pass current yaw to `toWorldInput`).
- Tests: pure orbit math (yaw/pitch clamp, wheel zoom clamp, yaw-to-basis mapping matches engine axes); audio event-mapping function pure.
- Commit.

### Task 4: Web — onboarding, examples, progress UX
Files: `apps/web/index.html`, `apps/web/src/ui/chat.ts`, `apps/web/src/ui/hud.ts`, `apps/web/src/app.ts`, `apps/web/tests/` as needed
- Header/title: "Prompt-to-Playable — describe a game, play it, reshape it by talking".
- Example prompt chips (click fills input): one per archetype + one explore prompt.
- Generation progress: elapsed seconds counter, staged messages ("understanding… building world… validating…"), cancel button; never a frozen screen.
- Errors: friendly message + Retry button; validation badge semantics unchanged.
- Explore HUD: when the loaded game has no objectives, HUD shows "Explore freely — WASD / Space / drag to orbit" instead of an empty list.
- Empty state with 3-step hint before first prompt.
- Commit.

### Task 5: Server — explore archetype (any-prompt coverage)
Files: `packages/schema/src/schema.ts` (ArchetypeSchema + explore), `server/src/classifier.ts`, `server/src/generator.ts`, `server/src/sanity.ts`, `server/src/pipeline.ts`, tests
- Add `explore` to archetype enum (schema is load-bearing: update types + any exhaustiveness).
- Classifier: choose `explore` for scene/display/non-goal prompts (forest, museum, city, room, "show me…"); keep game archetypes for goal-like prompts. Fallback rule stays deterministic.
- Generator: explore few-shot — world + entities (props, interactables, NPCs optional) + **zero objectives**, zero or minimal rules; must still be schema/sanity-valid.
- Sanity: skip win-path requirement when archetype is `explore`; keep bounds/refs/player checks. Verify route-level sanity too.
- HUD/client already handles zero objectives (Task 4).
- Tests: classifier mapping for ~8 prompts incl. non-game; explore doc validates + sanity passes with no objectives; game archetypes unaffected.
- Commit.

### Task 6: Live judge-prompt eval
Files: `scripts/llm-smoke.ts` (add judge-style prompt set), `docs/llm-eval-2026-10-14.md`
- 10 prompts: 4 game (one per archetype), 4 explore/scene (forest campfire, museum, neon city street, quiet room), 2 edits (add prop; add guard).
- Run live (deepseek-v4.1-flash via go gateway); record valid/solvable(or explorable)/latency; tune generator/classifier if any fail; ≤ 3 iterations.
- Commit eval doc + any prompt fixes.

### Task 7: Deploy + browser QA + wrap-up
- `npm run build && npm run build:web`, deploy Vercel prod.
- Extend `scripts/qa-browser.ts` with an explore-prompt beat (no objectives → HUD shows explore hint).
- Run QA on deployed URL (1 game + 1 explore, no edit to save budget), screenshots.
- Update `docs/submission/description.md` (category wording from the article: "AI-generated gameplay systems / prompt-to-world creation"; add explore mode + polish), README if needed.
- Final: tsc, full suite, engine purity grep; push to origin.

## Acceptance
- Any of: game prompt → playable goal game; scene prompt → explorable scene; edit prompt → live change. All validated server-side.
- Visuals: lit scenes (no black), animated character/enemies/collectibles, particles, SFX, orbit camera.
- Onboarding + progress + friendly errors visible.
- All tests green; extents/purity invariants intact; deployed and QA-passed; repo pushed.
- No external assets; credits unchanged (procedural + libs only).
