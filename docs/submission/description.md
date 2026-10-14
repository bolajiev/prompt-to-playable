# Prompt-to-Playable Game

**Live demo:** https://prompt-to-playable-steel.vercel.app
**Repo:** https://github.com/bolajiev/prompt-to-playable
**Demo video (66 s, captioned):** `docs/submission/demo.mp4`

**Focus category:** AI-generated gameplay systems / prompt-to-world creation

## What we built

A web app that turns a plain-language prompt into a **playable 3D game with working logic** in the browser — then lets you keep shaping it by chatting. You type something like *"collect three crystals while avoiding patrolling guards,"* and you are controlling a character in a 3D scene: **WASD / arrow keys** to move, **Space** to jump, **E** to interact. Gravity, obstacle and platform collision, patrolling and chasing enemies, and win and lose states all work in real time. Follow-up messages such as *"add a second guard and a timer"* or *"raise the platforms"* update the live game in place, no reload.

The core idea: **game logic lives in data, not generated code.** The AI produces a validated JSON game document; a fixed, deterministic engine plays it. That keeps AI output safe, keeps behavior reliable, and makes conversational editing cheap.

Scene-like prompts — *"a quiet forest clearing with a campfire at dusk"* — open in **free-roam explore** mode: a lit 3D scene with no objectives and no win/lose, where you walk, jump, and orbit the camera (drag; mouse wheel to zoom). Collectibles, enemies, and props are animated, pickups burst into particles, and a small procedural WebAudio layer plays jump/collect/hit/win cues. Everything is generated at runtime from primitives and synthesized sound — no external art or audio assets (Three.js is the only renderer).

## Problem / opportunity

Creating interactive 3D experiences is locked behind specialized skills. Even with modern tools, going from an idea to something with *real mechanics* — objectives, hazards, win conditions, feedback — takes hours or days of scripting and level design. Meanwhile, text-to-3D tools mostly produce static scenes or visuals, not *games*: things you can play, fail, and win.

The opportunity is to make interactive 3D creation **conversational**: describe what you want, get something playable, and refine it by talking. The hard part is not generating pretty geometry — it is generating **correct, working logic**. Our answer is a schema-first, data-driven pipeline that makes AI output constrained, verifiable, and repairable, so "plain language → working game" is reliable enough to demo every time.

## How AI is used

AI is used only where it adds leverage: turning fuzzy natural language into structured game data. Everything after that is deterministic.

1. **Archetype classifier.** An LLM call maps the prompt to one of five modes: the four curated game archetypes (`collect-a-thon`, `puzzle-switch`, `platformer-lite`, `stealth-chase`) or `explore` for place-like prompts with no stated goal ("a cozy reading room with a fireplace"). Constraining the output set keeps the generator focused and the results predictable.
2. **Structured generator.** A second LLM call, given the full schema and few-shot examples, emits a complete game document: world settings, entities, objectives, and rules. For `explore` prompts the document keeps `objectives` empty — a scene to roam, not a challenge.
3. **Constrained schema + validation.** The document is parsed against a **Zod** schema — the single source of truth. Types are inferred from it, so client and server agree on the exact shape. Malformed or out-of-bounds output is caught immediately.
4. **Repair loop.** If validation or sanity checks fail, the errors are fed back to the model with a targeted repair prompt (up to two retries). The model fixes the same document instead of starting over.
5. **Sanity / solvability checks.** Before anything reaches the client we verify references resolve, the player spawn and bounds are valid, and the game contains a real win path. Explore documents are exempt from the win-path requirement and must instead have zero objectives. Only then is the document returned.
6. **Conversational edits via JSON Patch.** Follow-up requests never regenerate the whole game. The model returns a minimal **RFC 6902 JSON Patch** (add/remove/replace operations). We apply it to the current validated document, re-validate and re-run sanity checks, and only then commit — so "add a second guard and a timer" produces a small, safe, reviewable change. Explore scenes keep their free-roam policy across edits: patches may add decorations but never objectives or win/lose actions.

Because the client only ever receives **validated JSON** and the engine is a fixed interpreter, the AI can never inject code or ship a broken game to the player. The HUD switches to a free-roam hint whenever the validated document has no objectives. The engine itself is pure TypeScript with a fixed timestep and seeded RNG, so gameplay is deterministic and testable.

## Architecture

One origin, two halves: a Vite browser client and a thin Express API. The client
posts the prompt to `/generate` and follow-ups to `/edit`; the API classifies,
generates, validates, repairs, and sanity-checks, then returns a validated game
document. The client never talks to the model directly, and API keys stay
server-side.

```
Browser                              Server (Node/Express)
┌──────────────────────────┐         ┌────────────────────────────────┐
│ Chat / command input     │         │ POST /generate  POST /edit     │
│ Game runtime (engine)    │ ◄─────► │ Archetype classifier           │
│ Scene renderer (Three.js)│  JSON   │ Structured generator           │
│ HUD / objectives UI      │         │ Zod validation + repair loop   │
└──────────────────────────┘         │ Sanity / solvability checks    │
                                     └────────────────────────────────┘
```

The codebase is split into npm workspaces: `packages/schema` (Zod schema, the
single source of truth), `packages/engine` (pure deterministic simulation:
movement, collision, rules, objectives), `packages/render` (Three.js
reconciliation by entity id), `packages/shared` (types, math, seeded RNG),
`server` (pipeline), and `apps/web` (Vite client). The fixed engine plus a
validated data document is what makes "plain language → working game" reliable:
same document and inputs, same simulation, every time.

## Tech stack

- **Language:** TypeScript (strict) across client and server
- **Schema/validation:** Zod
- **Engine:** framework-agnostic pure TS, fixed 60 Hz timestep, seeded RNG
- **Renderer:** Three.js (direct, no React)
- **Backend:** Node + Express
- **Build/tooling:** npm workspaces, Vite, tsx, Vitest; Playwright for dev-only browser QA
- **Hosting:** Vercel (static client + one serverless function), same code runs under Docker/local production

## Reliability

We treat reliability as a first-class metric. A deterministic prompt-corpus harness classifies, generates, validates, sanity-checks, and confirms a win path for 21 curated prompts; the target is **≥ 95% valid + solvable**, and the current result is **21/21 (100%) valid + solvable → PASS**. The live pipeline was also run against real models:

- **2026-10-12** (`gemini-3.1-flash-lite` via an OpenAI-compatible endpoint): **4/4 generated games valid + solvable, plus 1/1 working conversational edit** (one transient `503`, auto-retried) — `docs/llm-eval-2026-10-12.md`.
- **2026-10-14 judge-style set** (`deepseek-v4.1-flash`; 4 game prompts — one per archetype, 4 explore scenes, 2 conversational edits): **10/10 passed on the first iteration with zero repairs** — 4/4 games valid + winnable, 4/4 scenes valid + objective-free explorable, 2/2 edits applied as valid patches — `docs/llm-eval-2026-10-14.md`.

Three of the captured 2026-10-12 documents are auto-won by input-only steering in the offline suite, so playability is verified with no model and no network. Note that "solvable" is checked statically (schema + sanity + a win path exists), not by a simulated playthrough; the eval documents list the remaining limitations honestly. The full suite (unit, integration, end-to-end, fixture playtest) runs on every change and needs no API key.

## Links

- **Live demo:** https://prompt-to-playable-steel.vercel.app
- **Repository:** https://github.com/bolajiev/prompt-to-playable
- **Demo video (66 s, captioned):** `docs/submission/demo.mp4`
- **Deployment guide:** `docs/deployment.md`
- **Live model evaluation (2026-10-12):** `docs/llm-eval-2026-10-12.md`
- **Judge-style live evaluation (2026-10-14):** `docs/llm-eval-2026-10-14.md`

## Credits & attribution

- **Three.js** — MIT; browser 3D rendering.
- **Zod** — MIT; schema validation and inferred types.
- **Express** — MIT; thin Node API.
- **Playwright** — Apache-2.0; dev-only browser QA (`npm run qa:browser -- <url>`).
- **Google Gemini** via its OpenAI-compatible endpoint — used for the live model evaluation on 2026-10-12; no API key is included in the repository.
- **deepseek-v4.1-flash** via an OpenAI-compatible gateway — used for the judge-style live evaluation on 2026-10-14; no key or endpoint is recorded in the repository.
- **AI-assisted code generation:** the app, engine, schema, and tests were written with AI assistance; runtime behavior is verified by the test suite and by schema/sanity checks on every AI-generated game document.

## API key / environment

The live deployment's LLM API key is **not** in this repository and is supplied
only through environment variables: `OPENAI_API_KEY` (plus optional
`OPENAI_BASE_URL` and `OPENAI_MODEL`) in `server/.env` for local runs
(gitignored) or the host's project environment for deployments. The live key
should be rotated or revoked after the hackathon. Without a key the server still
boots, but `/generate` and `/edit` fail with a clear error. See
`docs/deployment.md`.
