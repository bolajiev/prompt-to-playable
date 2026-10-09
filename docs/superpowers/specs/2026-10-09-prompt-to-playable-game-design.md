# Prompt-to-Playable Game Design Spec

**Status:** Draft / Approved  
**Date:** 2026-10-09  
**Path:** docs/superpowers/specs/2026-10-09-prompt-to-playable-game-design.md

## 1. Overview

We are building a **Prompt-to-Playable Game** that turns plain language into an interactive 3D scene with working logic. The user types a description of a game, the system generates a playable browser-based game that follows those rules, and the user can continue shaping it through natural-language follow-up prompts. The architecture is **schema-first and data-driven**: the LLM emits a validated JSON game spec, and a fixed pure-TS engine executes it.

**Key goal:** demonstrate "plain language → 3D scenes and working logic." Reliability (working every time during judging) takes priority over novelty.

## 2. Requirements & Success Criteria

**Functional requirements:**
- Prompt input → generates a playable 3D game in the browser.
- Generated game has **working logic** (rules, objectives, win/lose conditions, interactions) — not just a static scene.
- After generation, user can issue natural-language edits (e.g., "add a second guard", "raise the platforms", "add a timer") and the game updates live in place.
- Runs entirely in the browser for the client; LLM calls run through a thin backend so API keys are not exposed.

**Success criteria (judge-facing):**
- From a short natural-language prompt, a playable game appears within ~30 seconds.
- Edits by conversation update the live scene without full page reload.
- At least two of the curated archetypes are fully functional and validated.
- Demo video < 3 minutes clearly shows: prompt → playable → play/interact → conversational edit → win/lose states.

**Quality targets:**
- **% valid + solvable games from prompts ≥ 95%** (measured against a test corpus). 
- Engine is deterministic (same initial state + fixed timestep → same simulation).
- JSON schema is the single source of truth; all LLM output is untrusted until validated.
- Reliability during judging: no unplayable/broken submissions from common prompts.

## 3. Architecture

```
Browser (client)                    Thin backend (Node)
┌─────────────────────────┐        ┌────────────────────────────┐
│ Chat/command input       │        │  POST /generate            │
│ Game runtime (engine)    │◄─────►│  POST /edit                │
│ Scene renderer (Three)  │  JSON  │  Archetype classifier      │
│ HUD / objectives UI      │        │  Generator (structured)    │
└─────────────────────────┘        │  Zod validator + repair    │
                                    │  Sanity checks             │
                                    │  API keys server-side      │
                                    └────────────────────────────┘
```

**Boundaries (critical):**
1. **Engine ⇄ Renderer.** Engine is pure state + `tick(dt)`. Renderer subscribes to state diffs and reconciles Three.js objects by entity `id`. Renderer never mutates engine state; engine never imports Three.js/DOM.
2. **Client ⇄ LLM.** Client only receives **validated JSON** that conforms to the schema. Backend strips or rejects any non-conforming output.
3. **Data-driven runtime.** Game logic is expressed entirely as data (entities + objectives + rules) interpreted by the fixed engine. No arbitrary code execution from generated output.

## 4. Stack

- **Language:** TypeScript (client + backend).
- **Renderer:** Three.js (direct). R3F is an optional alternative if team prefers React, but direct Three is lighter for engine/renderer boundary. Engine stays framework-agnostic.
- **Engine:** Pure TS module (`packages/engine`). No external rendering/DOM deps.
- **Validation:** Zod (runtime schema + inferred types).
- **RNG/Determinism:** Seeded RNG with fixed timestep.
- **Backend:** Node + Express (or equivalent). Minimal surface area; only proxies LLM, validates, repairs.
- **Testing:** Vitest (unit + integration). 
- **Hosting (target):** Static client (Vercel/Netlify), backend (Railway/Fly/Vercel serverless) — both accessible during judging.

## 5. Game Schema

The entire game is a single JSON document. Versioned and validated by Zod.

**Structure (high-level):**
```jsonc
{
  "version": "1.0.0",
  "meta":   { "title": "Crystal Hall", "archetype": "puzzle-switch",
              "genre": "puzzle", "difficulty": 0.0-1.0 },
  "world":  { "bounds": [x,y,z], "lighting": "dawn|day|dusk|night|indoor",
              "skybox": "cave|outdoor|lab", "gravity": 9.8,
              "terrain": { "type": "flat|mesh", "obstacles": [...] } },
  "entities": [ Entity ],
  "objectives": [ Objective ],
  "rules": [ Rule ],
  "scratch": Record<string, number|string|boolean>
}
```

**Entity kinds:** `player`, `enemy`, `collectible`, `trigger/zone`, `interactable`, `prop`, `exitDoor`, `platform`, `beam`, `spawn`.

**Objectives:** `collect` (count targets), `reach` (zone/pos), `survive` (time/enemies), `avoid` (failOn), `activate` (interact), `timeLimit` (failOn). Statuses: `active|done|failed`.

**Rules DSL (tiny, safe):**
- **Events:** `playerEnter(zone)`, `objectiveProgress`, `objectiveComplete`, `objectiveFailed`, `timer`, `enemyContact`, `interact`, `itemPickup`, `stateChange`, `playerDeath`, `tick` (rare).
- **Conditions:** comparisons over `scratch`/stats (`var < n`, `==`, `>`, `<=`, `>=`, `!=`), `and/or`, `has(entity|tag)`. No arbitrary JS.
- **Actions:** `spawn`, `despawn`, `enable/disable`, `objectiveProgress(by)`, `setObjective(status)`, `addObjective`, `setVar(k,v)`, `incVar(k,by)`, `teleport`, `playSound`, `showMessage`, `setEnemyState`, `win`, `lose`, `damage`, `openDoor`, `toggle`.

Variables live in `scratch` (mutable state bag) so rules can compose state without expanding the schema endlessly.

## 6. Archetypes (Curated Set)

Start with **collect-a-thon** and **puzzle-switch**. Keep at 4 max; if an archetype isn't solid by Week 8, cut it.

| Archetype | Core loop | Objectives | Typical entities |
|---|---|---|---|
| `collect-a-thon` | Collect items while avoiding hazards | collect N, avoid/fail, reach exit | player, collectibles, enemies with patrol, exitDoor |
| `puzzle-switch` | Activate switches/beams in sequence to unlock exit | activate sequence, reach exit, time optional | player, switches, beams, gates/doors, zones |
| `platformer-lite` | Navigate platforms to goal | reach goal, avoid hazards, optional collect | platforms, moving platforms, zones, exit |
| `stealth-chase` | Avoid detection / reach exit | reach exit, avoid contact with patrols | patrol paths, sight zones, cover props |

Archetype classifier (LLM, constrained to allowed set) picks the best fit for the prompt, then generator fills layout + entities + objectives + rules.

## 7. Generation & Edit Pipelines

### 7.1 Generate
1. **Input:** natural language prompt (user).
2. **Classify:** `archetype classifier` → constrained to {collect-a-thon, puzzle-switch, platformer-lite, stealth-chase}.
3. **Generate:** structured output call to LLM with full schema + few-shot examples → JSON matching Zod schema.
4. **Validate:** `Zod` parse. On failure → **repair prompt** (explain errors, request corrected JSON), max **2 retries**.
5. **Sanity checks:** 
- All objective target entity IDs exist
- Player spawn inside bounds and not intersecting obstacles
- Entities referenced by rules/objectives are present
- Reachability heuristic (path existence to key targets, ignoring some dynamic elements conservatively) — reject clearly unsolvable layouts
- No orphaned references; bounds respected
6. **Return:** validated game JSON to client.

### 7.2 Edit (conversational re-edits)
1. **Input:** follow-up message + current game JSON + short change history.
2. **Request JSON Patch only:** LLM must return an **RFC 6902 JSON Patch** (array of operations) describing changes to the current JSON. No full document unless necessary, but patch preferred.
3. **Apply patch:** apply to current validated JSON (in-memory).
4. **Re-validate:** Zod parse the patched document. If fails → reject patch and request repair (max 2 retries).
5. **Sanity checks:** same invariants as generation (references valid, bounds, solvability hints). If fails → reject and surface a short error in UI ("couldn't apply edit safely — try rephrasing").
6. **Commit:** swap to new validated state; engine resets or hot-swaps cleanly.
7. **UX:** show "validated ✔" badge when the active game state passed validation.

**Rationale:** patches are minimal, cheap, and preserve structure; they make small conversational edits reliable and testable.

## 8. Runtime (Engine + Renderer)

### 8.1 Engine (pure TS, deterministic)
- **Fixed timestep:** e.g., 60 Hz (16.666ms). Accumulate dt and tick fixed steps.
- **State:** canonical game state (entities with transforms/flags, objectives, scratch, time, win/lose, rng state).
- **Systems order per tick:** input → integrate (movement/AI) → broadphase collision (AABB/sphere) → fire events → rules evaluator → objectives update → cleanup/despawn/spawn → emit state snapshot.
- **Collision:** simple shapes only (AABB/sphere). No full physics engine. Sufficient for grid/platform/puzzle layouts.
- **AI:** minimal behaviors (`idle`, `patrol` along path, `chase` when in sight, `return`). Sight range as data. Deterministic given fixed timestep.
- **Rules evaluator:** event-driven. When events fire (playerEnter zone), evaluate matching rules' conditions against current state; execute actions atomically for that event batch (or in defined order).
- **Determinism:** seeded RNG (`seed` in meta or generated). Same seed + same inputs → identical simulation.

### 8.2 Renderer (Three.js)
- **Reconciliation:** subscribes to engine state diffs; maps entity `id` → Three.js object. Creates meshes on spawn, updates transforms/materials, removes on despawn. No engine mutation.
- **Camera:** third-person follow (player) with sensible defaults; configurable per archetype.
- **Lighting:** simple directional + ambient per world.lighting; avoids heavy GI.
- **Performance target:** smooth 60fps in desktop browser for small scenes (tens of entities). Keep simple.

## 9. UI/UX

- **Chat/command input:** single input box ("Describe a game..." / follow-ups). Clear, prominent.
- **HUD:** objectives list (with progress/status), timer if present, win/lose banner.
- **Validation badge:** "validated ✔" when current game JSON passed Zod + sanity checks (signals AI constrained).
- **Feedback:** loading state during generation (~few seconds acceptable). Surface short, non-technical errors on validation failure.
- **Demo-first:** UI should be minimal and readable in a <3min video (big text, clear states).

## 10. Scope, Milestones, Team Split

**Scope boundary (YAGNI):** 4 archetypes max; single-player; no auth/persistence/multiplayer. Desktop browser target. Cut breadth before reliability.

**Milestones:**
| Week | Deliverable |
|---|---|
| W1–2 | Schema frozen (Zod types). Engine skeleton renders a **hardcoded** JSON game end-to-end (no LLM). |
| W3–4 | Rules DSL + archetype 1 (collect-a-thon or puzzle-switch) fully playable with hand-authored JSON + unit tests for rules. |
| W5–6 | LLM generation pipeline: classifier + generator + Zod validation + repair loop + sanity checks. Target valid+solvable on sample prompts. |
| W7 | Edit-by-patch pipeline (RFC 6902), validation badge, conversational re-edits working in-place. |
| W8 | Archetype 2 complete + visual polish (lighting/camera/feel). Freeze features. |
| W9 | Hardening: hosted demo stable, prompt corpus eval (≥95% target), record <3min video, write README/description. |
| W10 | Buffer (fixes only). Final submission prep. |

**Team split (interfaces = schema):**
- **Engine (1–2):** schema, rules evaluator, collision, objectives, AI behaviors, Vitest.
- **Render/UX (1):** Three.js scene/HUD/chat UI, camera/lighting, feel/polish.
- **Backend/AI (1):** prompts (classifier/generator/repair/edit), orchestration, validation flow, deploy, prompt eval harness.

Schema changes require team consensus and are versioned (`version` field).

## 11. Testing Strategy

- **Unit tests (Vitest):** rules evaluator (events→actions), objectives, patch applier (RFC 6902), Zod schema edge cases, validator helpers.
- **Integration:** generate from 5–10 fixed prompts → assert valid + playable + solvable.
- **Prompt corpus eval:** ~20 natural-language prompts covering both archetypes. Track `% valid`, `% solvable`, and average generation time. **Target ≥ 95% valid+solvable**. Include this metric in README.
- **Golden tests:** sample game JSON snapshots to catch unintended schema/engine drift.
- **Determinism tests:** same seed + tick sequence → identical state.

## 12. Deployment & Submission Artifacts

**Hosting:** client static (Vercel/Netlify), backend (Railway/Fly or serverless). Both must remain accessible throughout judging.

**Submission requirements (from hackathon):**
- **Public code repository** showing implementation.
- **Hosted browser demo** judges can open/test directly.
- **Demo video < 3 minutes** (idea + key functionality).
- **Short written description** (what built, problem/opportunity, how AI is used).
- **Chosen focus category** (suggest: "Prompt-to-playable game / AI-assisted interactive 3D creation").

**Credits/attribution:** document any third-party assets/models/libraries used; comply with licenses.

## 13. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LLM generates unsolvable/broken games | Zod + sanity checks + repair (≤2 retries) + reachability heuristic; reject and don't ship invalid state. |
| Conversational edits drift or bloat | Require **JSON Patch** only for edits; validate patched doc; cap retries; small change history. |
| Judging instability (edge cases) | Curated archetypes, hard gate on validation, corpus eval ≥95%, prefer reliability over escape hatches. |
| Scope creep | 4 archetypes max, YAGNI, Week 8 feature freeze, cut breadth before polish if behind. |
| API cost/latency | Use structured output, low temp for edits, small retry budget, cache nothing sensitive; backend keeps keys server-side. |

## 14. Open Questions

None blocking initial implementation. Schema frozen in Week 2; any subsequent changes are versioned migrations.