# Phase 8 — Open World Sandbox: agent builds any world + interactive controls

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Prompt → an OPEN WORLD the user explores, with on-screen interactive controls (buttons/sliders) the agent wires up; the agent can compose any character (humanoid/robot/animal) from parts+FK. Reference: MuJoCo-style envs (world + control panel), not static cards.

**Engine already has (verified):** walker player, NPCs (patrol/chase), props/parts/flat labels, FK parenting, animations, controls (slider/toggle/button with onPress actions incl. spawn/despawn/setVar/animate/showPanel), click/hover events, panels, modes inspect/walkthrough/drive/machine/explore/game.

**Constraints:** engine purity/determinism; validated-JSON only; backward compat; no external assets; tests green; quality over latency.

## Task 1: World mode end-to-end (server + schema + client)
- Schema: meta.mode enum adds "world".
- Classifier: world cues (open world|sandbox|island|city|zoo|farm|village|park|world|explore freely|build me|create a) → mode "world" (archetype explore); precedence: machine > inspect > drive > walkthrough > world > explore; deterministic fallback + tests.
- Generator few-shot (world): LARGE bounds (e.g. 60×60), open ground, scattered terrain props (trees/rocks/buildings via shapes), 3-6 NPCs (patrol/idle, some parented characters), the player, AND 4-6 controls that make the world interactive: buttons "Spawn tree", "Spawn robot", "Call companion" (spawn actions), toggles "Night mode" (setColor/visible on sky props? keep to entity effects), sliders for e.g. "Wind" (animate speed) or "Grow" (scale via position? use color bind), plus click rules on 2-3 props → info panels. Guidance: characters are composed from parts with parented limbs (head/torso/arms/legs; robot = boxes+cylinders, animal = body+4 legs) and idle bob animations; interactive buttons MUST spawn/change things visibly.
- Sanity (world): ≥1 spawn button control; all control binds/onPress refs resolve (existing checks); no win path required; player required.
- Client: mode "world" HUD line ("Explore freely — use the world controls"); camera = orbit (default) with assembly-fit only if parts exist? Use orbit-player follow (walker). Keep it simple: orbit like explore.
- Fixture tests/fixtures/kit-world.json (live capture ≤3 calls); playtest: load world → press spawn button → entity count increases; move player; click a labeled prop → panel.
- Tests for classifier/sanity/few-shot/playtest. Commit: "feat(schema,server): open world mode with interactive world controls".

## Task 2: Character composition + landing/studio polish
- Generator guidance + few-shot update: a reusable character pattern (humanoid: pelvis→torso→head + 2 arms + 2 legs parented; robot/animal variants) used by world NPCs and spawn buttons; idle bob + optional walk via patrol on the root.
- Landing: REMOVE PCB hero/card; hero = open world ("Describe a world. Walk into it."), gallery = world/machine/race shots (re-capture world shot); keep kits grid but lead with Open World.
- Studio: controls panel renamed "World controls", more prominent when present; first-run copy updated for open worlds.
- Commit: "feat(server,web): character composition; open-world landing".

## Task 3: Deploy + verify
- Live probes: "an open world island with trees, animals and buttons to spawn things" → walkable, buttons work (spawn increases entities), panels work.
- Deployed QA (--explore --kits + landing smoke); re-capture world gallery shot; push.
