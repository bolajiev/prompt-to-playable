# Prompt-to-Playable Game

Turn a plain-language prompt into a playable 3D browser game with **working logic** — then keep shaping it by chatting: *"add a second guard and a timer"*, *"raise the platforms"*, *"make the door open on a pressure plate"*.

The architecture is **schema-first and data-driven**. The LLM emits a validated JSON game document; a fixed, deterministic TypeScript engine executes it. No generated code ever runs.

- **Spec:** [`docs/superpowers/specs/2026-10-09-prompt-to-playable-game-design.md`](docs/superpowers/specs/2026-10-09-prompt-to-playable-game-design.md)
- **Implementation plan:** [`docs/superpowers/plans/2026-10-09-prompt-to-playable-game.md`](docs/superpowers/plans/2026-10-09-prompt-to-playable-game.md)
- **Submission description:** [`docs/submission/description.md`](docs/submission/description.md)
- **Demo script:** [`docs/submission/demo-script.md`](docs/submission/demo-script.md)

## What it is

A single JSON document describes the entire game: `meta`, `world`, `entities`, `objectives`, `rules`, and a mutable `scratch` bag. The engine interprets that document every tick; the renderer reflects it. Because game logic lives in data, the same engine plays collect-a-thons, switch puzzles, platformers, and stealth levels.

Four curated archetypes: `collect-a-thon`, `puzzle-switch`, `platformer-lite`, `stealth-chase`.

## Architecture (schema-first)

```
Browser (client)                       Thin backend (Node/Express)
┌──────────────────────────┐          ┌────────────────────────────────┐
│ Chat / command input      │          │ POST /generate                 │
│ Game runtime (engine)     │ ◄──────► │ POST /edit                     │
│ Scene renderer (Three.js) │   JSON   │ Archetype classifier           │
│ HUD / objectives UI       │          │ Structured generator           │
└──────────────────────────┘          │ Zod validator + repair loop    │
                                       │ Sanity / solvability checks    │
                                       │ API keys stay server-side      │
                                       └────────────────────────────────┘
```

Boundaries that the code enforces:

1. **Client only ever sees validated JSON.** `/generate` and `/edit` run every document through the Zod schema and sanity checks before responding. Invalid LLM output is repaired (≤2 retries) or rejected — it is never handed to the client.
2. **Engine is pure TypeScript.** `packages/engine` holds state + `tick(dt)` and imports no DOM/Three.js. It is deterministic: fixed timestep (60 Hz) + seeded RNG, so the same initial state and inputs produce the same simulation.
3. **Renderer never mutates state.** `packages/render` reconciles Three.js objects to engine snapshots by entity `id` (create on spawn, update transforms, remove on despawn).
4. **Edits are RFC 6902 JSON Patch only.** `/edit` asks the LLM for a minimal patch, applies it to the current validated document, then re-validates and re-checks sanity before committing. The full document is not regenerated.
5. **No arbitrary code execution.** Game logic is expressed purely as data (entities + objectives + rules) interpreted by the fixed engine.

### Packages

| Path | Role |
|---|---|
| `packages/schema` | Zod schema + inferred types — the single source of truth |
| `packages/engine` | Pure, deterministic simulation (movement, collision, rules, objectives) |
| `packages/render` | Three.js reconciliation layer (entity `id` → mesh) |
| `packages/shared` | Shared types, math, seeded RNG, id helpers |
| `server` | Express API: classifier, generator, validator, repair, sanity, edit patch |
| `apps/web` | Vite client: canvas, chat input, HUD, validation badge |
| `scripts/eval-corpus.ts` | Prompt-corpus reliability harness |

## How to run (dev)

Requires Node 18+ (uses the built-in `fetch`).

```bash
npm install
```

**Backend** (API keys stay server-side, in `server/.env`):

```bash
cp server/.env.example server/.env   # then fill in the values
npx tsx server/src/index.ts          # http://localhost:3000
```

`server/.env` variables (names only — the file is gitignored, never commit real values):

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Key for the chat-completions endpoint |
| `OPENAI_BASE_URL` | Optional; OpenAI-compatible base URL (defaults to `https://api.openai.com/v1`) |
| `OPENAI_MODEL` | Optional; model id (defaults to `gpt-4o-mini`) |

Any OpenAI-compatible endpoint works (OpenAI, DeepSeek, Gemini) by setting
`OPENAI_BASE_URL` and `OPENAI_MODEL` — e.g. Gemini at
`https://generativelanguage.googleapis.com/v1beta/openai` with model
`gemini-3.1-flash-lite`. The server loads `server/.env` at boot; without a key
it still starts, but `/generate` and `/edit` fail with a clear error.

**Client** (in a second terminal):

```bash
npm --workspace @prompt-to-playable/web run dev      # Vite dev server
```

Open the printed URL, type a game prompt, and play. Follow-up messages are applied as conversational edits.

### Controls

| Action | Keys |
|---|---|
| Move | `W`/`A`/`S`/`D` or arrow keys |
| Jump | `Space` |
| Interact (switches, doors) | `E` |

Production builds:

```bash
npm run build
npm --workspace @prompt-to-playable/web run build
```

## How to test

```bash
npm install         # first time only
npm test            # Vitest: unit + integration + e2e smoke + fixture playtest
npm run test:watch  # watch mode
```

The offline suite is **25 files / 231 tests**, needs no API key, and includes the
rules evaluator, movement/gravity/jump and obstacle/platform collision, enemy
patrol/chase, objectives, the deterministic input-only playtest over the live
fixtures (`tests/playtest.test.ts`: 3 auto-won games + label/coverage guards),
patch application (RFC 6902), validation/sanity, repair loop, generation/edit
pipelines, renderer reconciliation, and an end-to-end smoke test.

## Live smoke (real model)

End-to-end check against a real model, loaded from `server/.env` (see
[`server/.env.example`](server/.env.example)):

```bash
npm run llm:smoke                # 4 generations + 1 edit, writes tests/fixtures/live-*.json
npm run llm:smoke -- --no-edit   # skip the edit stage
npm run llm:smoke -- --prompts my-prompts.json
```

Each result is classified, generated, validated, sanity-checked, and captured;
without `server/.env` the command exits non-zero with
`No OPENAI_API_KEY found (expected it in server/.env).`

## Reliability metric

Success criterion: **≥ 95% of prompt-corpus games are valid + solvable** (schema-valid, pass sanity checks, and contain a winning rule). Run the deterministic harness:

```bash
npm run eval:corpus
```

It classifies, generates, validates, sanity-checks, and confirms a win path for each of the 21 curated prompts using a deterministic mock LLM. Current result: **21/21 (100%) valid + solvable**, target ≥ 95% → PASS.

### Live model evaluation

The same pipeline was run against a real model (`gemini-3.1-flash-lite` via an
OpenAI-compatible endpoint) on 2026-10-12: **4/4 generated games valid +
solvable, plus 1/1 conversational edit** (one transient `503`, auto-retried).
The captured documents are committed as `tests/fixtures/live-*.json`; three of
them (collect-a-thon and puzzle-switch) are auto-won by input-only steering in
the offline suite. Per-prompt results and failure classes:
[`docs/llm-eval-2026-10-12.md`](docs/llm-eval-2026-10-12.md).

## Tech stack

- **Language:** TypeScript (strict) across client and server
- **Schema/validation:** Zod (runtime validation + inferred types)
- **Engine:** framework-agnostic pure TS, fixed timestep, seeded RNG
- **Renderer:** Three.js (direct, no React)
- **Backend:** Node + Express
- **Build/tooling:** npm workspaces, Vite, tsx, Vitest

## Submission notes

- **Focus category:** Prompt-to-playable game / AI-assisted interactive 3D creation.
- **Artifacts:** public repo, hosted browser demo, demo video < 3 min, written description (`docs/submission/description.md`).
- **AI usage:** archetype classifier → constrained structured generator → Zod validation + ≤2 repair retries → sanity/solvability checks; conversational edits via RFC 6902 JSON Patch, re-validated before commit.
- **Demo script:** `docs/submission/demo-script.md`.
