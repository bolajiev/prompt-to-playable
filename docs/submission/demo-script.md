# Demo Script (< 3 minutes)

Shipped video: `demo.mp4` — **~1:06 total** (66 s). Every beat below is in the
video; timings and details come from the recorded run
(`artifacts/demo/beats.json`).

Goal: show **plain language → working game logic**, live, with movement, jump,
interact/collect, one conversational edit, and a post-edit replay of the same
level. No dead air.

Controls (shown in the app's bottom-right hint): **WASD / arrows move ·
Space jump · E interact.**

## 0:00–0:03 — Landing

- Screen shows the empty scene, the "unvalidated" badge, the chat box, and the
  controls hint.
- On-screen caption: *"Describe a game in plain language."*

## 0:03–0:12 — Prompt (one sentence, live generation beat)

- Type the prompt and submit:
  > **"a small room where I collect 3 glowing crystals while avoiding one guard"**
- Caption while it generates: *"AI generates a playable 3D game — validated, no
  generated code runs."*
- Say: *"A real model, running server-side, turns that sentence into a structured
  game document. The server validates it against a strict schema before it reaches
  the screen — no generated code ever runs."*

## 0:12–0:32 — Generated game

- The game appears: **Crystal Heist** (stealth-chase) — the player, three glowing
  crystals, one patrolling guard, and the HUD with the "validated ✔" badge and the
  objective `collect: crystal-1, crystal-2, crystal-3 0/3`.

## 0:32–0:39 — Play: collect all three crystals to win

- Caption: *"Play it with WASD / Space / E — real objectives and collision."*
- Play with the keyboard (point at the controls hint):
  - **Move** with WASD / arrows to each crystal; a single **Space** jump happens on
    the way.
  - Walk through the crystals — each one despawns and the objective progress ticks
    up, exactly as the recorded run does (3/3, won after ~6 s, zero lose beats).
- All three collected: the HUD flips to `3/3 · done` and the **"You win!"** banner
  fires.
- Say: *"That's real logic — objectives, collectibles, collision, gravity and win
  states — all driven by the validated document, not generated code."*

## 0:39–0:55 — Conversational edit

- In the same chat box, type:
  > **"add a second guard that patrols the room"**
- Caption: *"Keep shaping it by talking."*
- The game updates **in place** (no page reload): `Applied edit to "Crystal Heist".`
  A second patrolling guard appears — the recorded run goes from 1 guard to 2.
- Say: *"Edits go through as a tiny JSON Patch — the AI changes only what you asked
  for, and the result is re-validated before it's applied. That's why it stays
  reliable."*

## 0:55–1:03 — Post-edit replay

- Caption: *"Updated live: a second guard patrols the room."*
- Without touching the prompt, the same level is replayed under the edited
  document: the player collects all three crystals while **both** guards patrol
  (recorded run: won after ~7.5 s with 2 guards).
- `3/3 · done` and **"You win!"** fire again with two guards in the scene.

## 1:03–1:06 — Close

- Hold on the won state: HUD shows `Crystal Heist`, `3/3 · done`, `You win!`.
- Caption: *"Plain language in, playable game out."*
- Say: *"One sentence in, a playable game out — then refined by conversation. Same
  flow works for collect-a-thons, platformers, and stealth levels."*

---

### Recording notes

- Recorded with `scripts/demo-record.ts` against the deployed app; beats,
  captions, and timings are saved under `artifacts/demo/`. Target runtime is
  ~1:06, comfortably under 3 minutes.
- Exact prompts live in `scripts/demo-record.ts`: `DEMO_PROMPT` = *"a small room
  where I collect 3 glowing crystals while avoiding one guard"*,
  `DEMO_EDIT_PROMPT` = *"add a second guard that patrols the room"*.
- Keep the chat box, HUD, and controls hint visible at all times; use a large font.
- If the live LLM is slow, cut to the result after submitting; do not show waiting.
- The video does not make a reliability claim; benchmark numbers live in
  `docs/submission/description.md`.
