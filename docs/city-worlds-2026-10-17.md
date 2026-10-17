# City worlds + free-form default — 2026-10-17

**Commit:** `feat(server): city worlds with ambient walkers; world as free-form default`
**Scope:** `server/src/classifier.ts`, `server/src/generator.ts`, doc comments in
`server/src/sanity.ts` and `scripts/llm-smoke.ts`, tests, captured fixture
`tests/fixtures/kit-city.json`. `server/.env` untouched.

## 1. What changed

### 1.1 Free-form default (classifier fallback)

`parseArchetype`'s deterministic fallback now routes **neutral scene prompts**
(no goal cues, no quiet-scene cues) to `world` instead of `explore`:

- New `QUIET_SCENE_PATTERN = /\b(quiet|calm|peaceful|clearing|forest|room|cozy)\b/`
  and a new exported predicate `isQuietScenePrompt()`.
- `isWorldPrompt()` keeps its higher-precedence deferrals (goal, inspect object,
  drive, walkthrough verb, machine) and now returns `true` when the prompt
  matches the explicit world cues **or** any remaining scene language, and
  `false` when an explicit quiet cue is present.
- Precedence in `parseArchetype` is unchanged: machine > inspect > drive >
  walkthrough > world > explore > `DEFAULT_ARCHETYPE`. Game goals, technical
  objects, vehicles, interior walk-throughs and quiet scenes keep their kits;
  unknown non-scene prompts still fall back to `collect-a-thon`.
- `buildClassifierPrompt` now teaches the same rule: quiet/calm/peaceful/cozy
  scene → explore, any other goal-less scene/place (cities, streets, buildings,
  sandboxes) → world, with a city few-shot example.
- `isExplorePrompt` still answers "is this scene language?" so the
  walkthrough predicate keeps treating "a museum hall with marble statues" as a
  scene rather than an interior walk.

Explore expectations that moved to world (all updated):

| File | Expectation | Before | After |
|---|---|---|---|
| `server/tests/classifier.test.ts` | `"a museum hall with marble statues"` in the GAME_AND_FREEROAM fallback table | explore | world |
| `server/tests/classifier.test.ts` | `parseArchetype("banana", "a museum hall with marble statues")` | explore | world |
| `server/tests/classifier.test.ts` | `classifyByKeywords("a museum hall with marble statues")` | explore | world |
| `server/tests/pipeline.test.ts` | explore-case list entry `"a museum hall with marble statues"` | explore fallback | moved to the world-case list; fallback now asserted world |

Unchanged explore expectations: `"a quiet forest clearing with a campfire at
dusk"` (quiet/forest/clearing) and `"show me a cozy room"` (cozy/room). Added
coverage: city prompt in `WORLD_PROMPTS`, `isWorldPrompt`/`isQuietScenePrompt`
cases, and a deterministic-fallback test that neutral scenes default to world.

### 1.2 City guidance + few-shot (generator)

- New exported `CITY_WORLD_EXAMPLE` — a schema-valid, sanity-clean 22-entity
  city: 4 part-assembly towers (heights 16/11/9/14, brick/metal/grid bodies +
  stacked glass window bands + roofs), a cross of two dark asphalt streets,
  2 emissive street lamps, 2 trees, a fountain, a rooftop wind spinner, a
  parented clock-window emissive band, 6 peaceful patrolling walkers (2 with a
  parented head to show the character chain, 4 compact single-root composed
  walkers) with diagonal/street routes that criss-cross the map, and 4 controls:
  button "Build tower" (spawns a new id with glass windows), button "Traffic"
  (spawns a car-like patrolling character), toggle "Night" (binds
  `emissive` + `var: night` on the window band, with a guarded tick rule pair
  recoloring the lamps), slider "Wind" (rotation.y on the spinner).
- New exported `CITY_WORLD_BLOCK` prompt guidance: bounds 70x28x70 within
  60–80, ≥4 towers with glass bands and heights 6–16 laid out on a block grid,
  cross/grid streets, ≥6 peaceful patrol NPCs with criss-crossing 2–4 waypoint
  routes, lamps/trees, the four controls above and click panels on 2 landmarks.
  Budget for cities: **at most 28 entities** (explicitly counted, parented
  limbs included), 12 rules, 6 controls.
- `isCityWorldPrompt()` detects city/street/downtown/urban/avenue/traffic
  prompts. `buildGenerationPrompt(prompt, "world")` selects `CITY_WORLD_BLOCK`
  + `CITY_WORLD_EXAMPLE` + a city intro/layout only for those prompts; every
  other world prompt keeps the island guidance and the old 24-entity cap. All
  other kits are byte-for-byte unchanged.
- No new hard gates were added: `sanityCheck` world still only requires a spawn
  button (`missing-world-spawn`), and `scripts/llm-smoke.ts`'s world kit gate is
  unchanged. Both carry comments stating city checks are prompt guidance only.

## 2. Live city capture — stats

**Model:** `deepseek-v4.1-flash`, stock pipeline (classify → generate, up to 2
repairs). **Command:** `npx tsx scripts/llm-smoke.ts --prompts <city.json>
--no-edit --no-write --capture-fixtures`. Prompt:
`a city with tall buildings, streets and characters walking around everywhere`.
`server/.env` was only read by the smoke runner; never modified.

| Run | Calls | Latency | Result | Stats |
|---|---|---|---|---|
| 1 (guidance v1) | 2 | 47.9 s | PASS, fixture written | 32 entities (player 1/prop 25/enemy 6), 6 rules, 4 controls; 4 towers but one 18 tall, over the 28 cap |
| 2 (guidance once tightened: hard "no tower exceeds 16", "28 entities TOTAL" count) | 2 | 265.4 s | PASS, fixture re-captured | **27 entities (player 1/prop 20/enemy 6), 5 rules, 4 controls** |

Final capture (`tests/fixtures/kit-city.json`):

- Title `Lantern Heights`, bounds `[72, 28, 72]`, `meta.mode="world"`,
  objectives `[]`, schema-valid, sanity-clean.
- 4 towers with street-scale heights (14/15/9/12) and body textures
  brick/metal; `tower-cobalt`'s glass bands are a parented
  `tower-cobalt-windows` prop, the others carry inline bands.
- 2 streets, 2 emissive lamps, 2 trees, fountain + founders statue
  (2 click-panel landmarks), wind spinner, one composed `keeper` prop.
- 6 patrolling walkers (`juno` with parented head/arms/legs, the other five
  single-root composed) with 2–4 waypoints each.
- Controls: `Build tower` → spawns new `tower-spawn-1`; `Traffic` → spawns new
  `car-1`; `Night` toggle (bound `emissive` + `var: night`, tick rule pair
  recolors 3 entities); `Wind` slider (rotation.y).
- Total live calls spent: 4 (2 + 2), inside the ≤3/≤5 budget (one guidance
  iteration). `transientRetries=0`.

## 3. Tests

| Command | Result |
|---|---|
| `npx tsc -b` | clean |
| `npx vitest run` | 67 files, **817/817 passed** (playtest-v5 grew 5 → 6) |
| `npm run eval:corpus` | 23/23 valid+solvable (100%), target 95% → PASS |

New/updated tests:

- `server/tests/classifier.test.ts` — free-roam table, quiet-scene predicate,
  neutral-scene world routing, city few-shot in the classifier prompt,
  `classifyByKeywords` museum/city → world.
- `server/tests/pipeline.test.ts` — explore/quiet vs world/neutral fallback
  split, city prompt fallback → world.
- `server/tests/generator.test.ts` — city example structural checks
  (towers/streets/walkers/controls/landmarks/budget) and city prompt selection
  (city block + city few-shot for city prompts, island block + island few-shot
  otherwise).
- `tests/playtest-v5.test.ts` — new city case: loads `kit-city.json`, asserts
  ≥4 part-assembly buildings (inline or parented glass bands), ≥6 peaceful
  walkers with patrol paths, that walkers visibly move over 300 ticks, and that
  pressing "Build tower" increases the entity count.

## 4. Concerns

- `tower-cobalt` keeps its glass window bands in a parented window-band entity
  rather than inline in the tower's own parts. It still counts as a composed
  building and passes both the capture definition and the playtest predicate,
  but a strict "glass parts on the building entity itself" reading would count
  3 inline towers; the four entity-level towers are all present.
- The city capture is 27 entities against the 28 cap (guidance only, not
  enforced), so a future model run could overrun; `sanityCheck` deliberately
  does not reject it (per the "city checks are prompt-guidance only" rule).
- Only the guidance was iterated once per the brief; the model still varies
  layout quality between runs (run 1 exceeded both the height range and the
  entity cap).
- `isExplorePrompt` retains its scene-language meaning (museum hall → true), so
  code that reads it as "will classify as explore" should use
  `isQuietScenePrompt` instead; all in-repo callers were checked.
- Non-scene unknown prompts still default to `collect-a-thon`; the new
  free-form default covers neutral *scene* prompts only, matching the brief.
