# Demo Script (< 3 minutes)

Goal: show **plain language → working game logic**, fast, with no dead air.

## 0:00–0:30 — Prompt (one sentence)

- Screen shows the empty scene and the chat box.
- Say: *"Everything you're about to see starts from one sentence."*
- Type the prompt and submit:
  > **"collect three crystals while avoiding patrolling guards"**
- As it generates, say: *"The AI classifies the idea, writes a structured game document, and validates it against a strict schema before it ever reaches the screen."*

## 0:30–1:10 — Playable + fail

- The game appears with the player, three glowing crystals, and patrolling guards; the HUD shows the objective and the "validated ✔" badge.
- Play: grab one or two crystals (objective progress updates live).
- Deliberately walk into a guard. The **lose** banner fires with a message.
- Say: *"That's real logic — objectives, patrol AI, collision, win and lose states — all driven by data, not generated code."*

## 1:10–2:20 — Conversational edit

- Restart / respawn, then type a follow-up in the same chat box:
  > **"add a second guard and a timer"**
- The game updates **in place** (no page reload): a new guard appears on its own patrol route and a countdown timer shows in the HUD.
- Optional quick second edit to show range:
  > **"raise the platforms"** or **"make the crystals worth ten points"**
- Say: *"Edits go through as a tiny JSON Patch — the AI changes only what you asked for, and the result is re-validated before it's applied. That's why it stays reliable."*

## 2:20–2:50 — Win

- With the timer running, collect the remaining crystals and reach the exit.
- The **win** banner fires.
- Say: *"One sentence in, a playable game out — then refined by conversation. Same flow works for switch puzzles, platformers, and stealth levels."*

## 2:50–3:00 — Close

- Show the reliability line.
- Say: *"We measure it: across our curated prompt corpus, 100% of games come out valid and solvable, against a 95% target. Plain language in, working logic out."*

---

### Recording notes

- Use a large font; keep the chat box and HUD visible at all times.
- Prefer one clean edit over many small ones; the point is *live, safe re-editing*.
- If the live LLM is slow, cut to the result after submitting; do not show waiting.
- Target runtime ~2:45 to leave buffer under 3 minutes.
