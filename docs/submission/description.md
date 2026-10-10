# Prompt-to-Playable Game

## What we built

A web app that turns a plain-language prompt into a **playable 3D game with working logic** in the browser — then lets you keep shaping it by chatting. You type something like *"collect three crystals while avoiding patrolling guards,"* and within seconds you are controlling a character in a 3D scene with objectives, enemies, win and lose states. Follow-up messages such as *"add a second guard and a timer"* or *"raise the platforms"* update the live game in place, no reload.

The core idea: **game logic lives in data, not generated code.** The AI produces a validated JSON game document; a fixed, deterministic engine plays it. That keeps AI output safe, keeps behavior reliable, and makes conversational editing cheap.

## Problem / opportunity

Creating interactive 3D experiences is locked behind specialized skills. Even with modern tools, going from an idea to something with *real mechanics* — objectives, hazards, win conditions, feedback — takes hours or days of scripting and level design. Meanwhile, text-to-3D tools mostly produce static scenes or visuals, not *games*: things you can play, fail, and win.

The opportunity is to make interactive 3D creation **conversational**: describe what you want, get something playable, and refine it by talking. The hard part is not generating pretty geometry — it is generating **correct, working logic**. Our answer is a schema-first, data-driven pipeline that makes AI output constrained, verifiable, and repairable, so "plain language → working game" is reliable enough to demo every time.

## How AI is used

AI is used only where it adds leverage: turning fuzzy natural language into structured game data. Everything after that is deterministic.

1. **Archetype classifier.** An LLM call maps the prompt to one of four curated archetypes (`collect-a-thon`, `puzzle-switch`, `platformer-lite`, `stealth-chase`). Constraining the output set keeps the generator focused and the results predictable.
2. **Structured generator.** A second LLM call, given the full schema and few-shot examples, emits a complete game document: world settings, entities, objectives, and rules.
3. **Constrained schema + validation.** The document is parsed against a **Zod** schema — the single source of truth. Types are inferred from it, so client and server agree on the exact shape. Malformed or out-of-bounds output is caught immediately.
4. **Repair loop.** If validation or sanity checks fail, the errors are fed back to the model with a targeted repair prompt (up to two retries). The model fixes the same document instead of starting over.
5. **Sanity / solvability checks.** Before anything reaches the client we verify references resolve, the player spawn and bounds are valid, and the game contains a real win path. Only then is the document returned.
6. **Conversational edits via JSON Patch.** Follow-up requests never regenerate the whole game. The model returns a minimal **RFC 6902 JSON Patch** (add/remove/replace operations). We apply it to the current validated document, re-validate and re-run sanity checks, and only then commit — so "add a second guard and a timer" produces a small, safe, reviewable change.

Because the client only ever receives **validated JSON** and the engine is a fixed interpreter, the AI can never inject code or ship a broken game to the player. The engine itself is pure TypeScript with a fixed timestep and seeded RNG, so gameplay is deterministic and testable.

## Reliability

We treat reliability as a first-class metric. A deterministic prompt-corpus harness classifies, generates, validates, sanity-checks, and confirms a win path for 21 curated prompts; the target is **≥ 95% valid + solvable**. The suite (unit, integration, end-to-end) runs on every change.
