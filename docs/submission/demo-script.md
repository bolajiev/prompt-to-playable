# Demo Script (< 3 minutes)

Goal: show **plain language → working game logic**, live, with movement, jump,
interact, and one live-generation beat. No dead air.

Controls (shown in the app's bottom-right hint): **WASD / arrows move ·
Space jump · E interact.**

## 0:00–0:25 — Prompt (one sentence, live generation beat)

- Screen shows the empty scene and the chat box.
- Say: *"Everything you're about to see starts from one sentence."*
- Type the prompt and submit:
  > **"open flat chamber with no obstacles: press three switches placed in the open; win when every switch is activated"**
- As it generates, say: *"A real model, running server-side, turns that sentence into a structured game document. The server validates it against a strict schema before it reaches the screen — no generated code ever runs."*

## 0:25–1:15 — Playable (move / interact / jump)

- The game appears: player, three switches, HUD with objective and the "validated ✔" badge.
- Play with the keyboard (point at the controls hint):
  - **Move** with WASD / arrows to switch 1.
  - **Press E** to activate it — the switch disables and objective progress ticks up.
  - **Jump** with Space on the way (gravity pulls the player back to the ground, landing cleanly).
  - Activate switch 2 with **E**.
- Say: *"That's real logic — objectives, interactables, collision, gravity, win and lose states — all driven by the validated document, not generated code."*

## 1:15–2:15 — Conversational edit

- Pause before the last switch, then type a follow-up in the same chat box:
  > **"add one patrolling guard and a raised platform near the switches"**
- The game updates **in place** (no page reload): a guard appears on a patrol route, and a platform rises in the scene.
- **Jump onto the platform** with Space to show gravity + platform collision.
- Let the guard catch the player once: the **lose** banner fires with a message; respawn.
- Say: *"Edits go through as a tiny JSON Patch — the AI changes only what you asked for, and the result is re-validated before it's applied. That's why it stays reliable."*

## 2:15–2:45 — Win

- Avoid the guard and press **E** on the last switch.
- The objective completes and the **win** banner fires (the exit opens, if the level generated one).
- Say: *"One sentence in, a playable game out — then refined by conversation. Same flow works for collect-a-thons, platformers, and stealth levels."*

## 2:45–3:00 — Close

- Show the reliability line.
- Say: *"We measure it: on a real model, 4 of 4 generated games came out valid and solvable, and across our deterministic corpus harness, 21 of 21, against a 95% target. Plain language in, working logic out."*

---

### Recording notes

- Alternate prompt (more visually active, also validated live): *"open flat field with no obstacles: collect 3 glowing crystals placed in the open; walking through a crystal collects it; win when all are collected"* — for the interact beat, ask the edit for *"a switch I can press with E to open the exit door"*.
- Keep the chat box, HUD, and controls hint visible at all times; use a large font.
- Prefer one clean edit over many small ones; the point is *live, safe re-editing*.
- If the live LLM is slow, cut to the result after submitting; do not show waiting.
- Target runtime ~2:45 to leave buffer under 3 minutes.
