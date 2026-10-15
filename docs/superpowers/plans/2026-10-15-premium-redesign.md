# Phase 6 — Premium Product: landing page, studio UI, PCB-quality visuals

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Make the project look and feel like a funded product: a real landing page, a reworked studio UI, and PCB output that reads as an actual circuit board (reference: heypcb.ai renders — dark green mask, gold traces/pads, black ICs with pin rows, silkscreen designators, mounting holes, top-down presentation). Quality over latency: generation budgets are re-loosened.

**Architecture:** Two pages (landing `index.html`, studio `app.html`) built by Vite multi-page; shared design tokens in CSS. Renderer gains PCB-grade texture + composite prop shapes + flat silkscreen labels. Generator gets a rich PCB few-shot + loosened budgets. Gallery screenshots are captured from real generations and bundled as static assets.

**Spec:** docs/superpowers/specs/2026-10-09-prompt-to-playable-game-design.md

## Global Constraints
- No external CDN/art assets at runtime. Fonts: bundle `@fontsource-variable/inter` (npm, build-time) with system fallback. Gallery screenshots are OUR OWN captures committed under `apps/web/public/shots/`.
- Engine purity, renderer non-mutation, validated-JSON-only, secrets rules unchanged.
- Backward compatibility: new schema fields optional; existing fixtures/tests keep passing unless a task explicitly updates them.
- Latency is NOT a constraint: re-loosen generation budgets; richer output preferred.
- `npx vitest run` + `npx tsc -b` green after every task.
- QA/demo scripts switch to the studio page path (`/app.html`) where needed.

## Interfaces (canonical additions)

```ts
// schema (packages/schema): label gains `flat?: boolean` (default false = billboard sprite)
// renderer shape vocabulary gains: "chip" | "header" | "capacitor" | "led" | "hole"
//   chip: black body box + two pin rows (gold cylinders) along the long edges (pin count from size ratio)
//   header: black strip + single/double gold pin row(s) on top
//   capacitor: black cylinder + orange/gray top disc
//   led: small emissive cylinder (color from entity color)
//   hole: black torus (mounting hole / pad ring)
// inspect camera: top-down-ish framing (pitch ~1.05 rad, distance auto-fit to assembly bbox, clamped)
```

---

### Task 1: Render — circuit texture v2, PCB shapes, flat silkscreen labels
Files: `packages/render/src/{textures,shapes,labels,renderer}.ts`, `packages/schema/src/schema.ts` (label.flat), tests
- Circuit texture v2 (deterministic, canvas, node-guarded): dark green solder mask base (#1b4d2e-ish), gold traces (3-5 polylines with 45° segments per tile, pads as gold discs with dark centers, small vias), subtle mask mottling; 1024px tile, repeat per board size. Keep other texture names working.
- New shapes in shapes.ts (multi-part groups, unit-box fit): chip (body + pin rows), header (strip + pins), capacitor (body + top disc), led (emissive), hole (torus). Reuse existing material helpers; pins use gold color (#d4af37) regardless of entity color unless part color given.
- `label.flat`: schema optional boolean; labels.ts builds a PlaneGeometry with canvas text (white on transparent, silkscreen style: small caps, letter-spaced) lying flat (rotateX -90°), positioned by label.offset; non-flat keeps existing sprite behavior.
- Renderer: flat labels follow runtime position/rotation, dispose correctly, scale by label.size (default 0.6 world units tall text).
- Tests: texture determinism + node fallback; shape child counts/bounds; flat vs sprite label; existing extents/materials/shapes suites untouched.
- Commit: `feat(render): PCB-grade circuit texture, composite shapes, flat silkscreen labels`.

### Task 2: Server — PCB few-shot v2 + loosened budgets + inspect camera fit
Files: `server/src/generator.ts`, `apps/web/src/app.ts` (inspect camera), `server/tests/generator.test.ts`, `tests/fixtures/kit-pcb.json` (re-capture), `tests/playtest-v5.test.ts` (adapt if needed)
- Rewrite the inspect/PCB few-shot to heypcb-grade composition: board plate (green, circuit texture, size ~2:1), 3 chips (with silkscreen designator flat labels: U1/U2/U3), a header strip (PI1), 2-3 capacitors, 3 LEDs (emissive, one blinking via animate pulse), 4 mounting holes (torus), a board title flat label (e.g., "SENSOR NODE v1.0"), 2-4 click rules → showPanel with realistic info (name, function, pins) + setColor emphasis + cameraFocus on first click; a click on a "reset" pad → hidePanel. All labels flat; components labeled with silkscreen designators.
- Inspect guidance: layout discipline (rows/columns, alignment), silkscreen naming, spacing ≥ component size; keep ≤ 14 entities / ≤ 8 rules (quality over count, but allow up to 14).
- Re-loosen other kit budgets: walkthrough ≤ 16 entities/10 rules, drive ≤ 14/10, explore ≤ 14/6, games ≤ 14/8; remove the "terse JSON" line (prefer readable, well-formed JSON).
- Inspect camera in app.ts: for mode inspect, pitch ≈ 1.05 rad and distance auto-fit: compute bbox of entities with parts (from state at load), set distance = clamp(max(bbox diag * 1.1, 8), 8, 26); fallback to current 15 when no parts.
- Re-capture `tests/fixtures/kit-pcb.json` live (≤ 3 calls); keep playtest-v5 inspect case green (adapt selectors if the fixture's labeled entity ids changed — never weaken assertions).
- Tests: generator few-shot validity + PCB composition assertions (board texture, ≥2 chips, flat labels, click rules with panels); camera-fit pure function tests.
- Commit: `feat(server,web): heypcb-grade PCB kit, loosened budgets, inspect camera fit`.

### Task 3: Web — landing page + studio page split (premium design)
Files: `apps/web/index.html` (landing, new), `apps/web/app.html` (studio, moved from index.html), `apps/web/vite.config.ts` (multi-page), `apps/web/public/shots/*.png` (gallery captures), CSS in each page, `apps/web/src/main.ts` (studio entry) + new `apps/web/src/landing.ts` (landing interactions only), `@fontsource-variable/inter` dependency
- Landing (`/`): hero ("Describe a world. Play it." + sub: plain language → interactive 3D with working logic), primary CTA → `/app.html`, secondary "watch 60s demo" anchor; live-looking hero visual (bundled screenshot in a framed device panel with subtle glow); example prompt chips (visual only, click → opens studio with prompt prefilled via `?prompt=`); "How it works" 3 steps (describe → play → reshape); 5 kits feature grid with small screenshots; reliability strip (live evals: 13/13 kit prompts, 10/10 judge prompts, offline playtests); footer (repo link, credits, no false claims).
- Design system: Inter variable font, dark premium palette (near-black #0a0c10, panel #12151c, border rgba white 8%, accent #6ea8fe→#7c5cff gradient), large display type (clamp sizes), generous spacing, soft shadows, subtle grid/noise background, tasteful motion (fade-up on scroll via IntersectionObserver, CSS only), no external images beyond bundled shots.
- Studio (`/app.html`): same design tokens; layout rework: top bar (logo → landing, title, mode badge, validated badge), left canvas panel with floating controls hint + interact prompt + drive HUD, right sidebar (chat log, composer, example chips, panels as stacked info cards with close), crosshair; refined buttons/inputs/chips; progress UI restyled; mobile-ish narrow fallback (sidebar collapses under canvas).
- main.ts stays the studio bootstrap; landing.ts is tiny (smooth scroll + prompt prefill link builder).
- Tests: prompt-prefill link builder pure test; existing web tests keep passing (selectors unchanged in app.html).
- Commit: `feat(web): premium landing page and studio UI rework`.

### Task 4: Gallery + QA path updates + captures
Files: `scripts/qa-browser.ts` (studio path), `scripts/demo-record.ts` (studio path), `apps/web/public/shots/*` (captures), `scripts/capture-shots.ts` (new)
- Update QA/demo scripts to open `<url>/app.html` (and landing smoke: `/` returns 200 + hero text).
- `scripts/capture-shots.ts`: Playwright captures (1280x800, 2x scale) of: PCB inspect (clicked panel open), house walkthrough interior, race chase view, forest explore, one game scene; writes to `apps/web/public/shots/` (committed; keep each ≤ 400KB via JPEG quality 85 or PNG optimised — prefer JPEG for photos-of-3D).
- Landing uses these shots; refresh after T2/T5 deploys.
- Commit: `chore(web): studio QA paths, gallery captures`.

### Task 5: Live re-eval + fixtures refresh + deploy
Files: `scripts/prompts-judge-v5.json` (unchanged), fixtures, `docs/llm-eval-2026-10-15.md` (append follow-up), deploy
- Live run of the 15-prompt v5 set (quality over budget; ≤ 20 calls): confirm kits still usable with loosened budgets; capture fresh kit-pcb + kit-house + kit-race fixtures; run playtests.
- Full QA: `--explore --kits` on the deployed URL against `/app.html`; screenshots reviewed; landing smoke.
- Docs: README (landing URL, screenshots section, kit table), description.md (mention landing + PCB-grade inspect kit), demo video NOT re-recorded (per user).
- Deploy Vercel prod; push origin.
- Commit: `docs,test: premium re-eval, refreshed fixtures, deploy verified`.

## Acceptance
- Landing page at `/` looks premium (hero, shots, kits, reliability) and links to the studio; studio at `/app.html` has the reworked UI.
- PCB prompt yields a heypcb-grade board: green mask + gold traces, chips with pins + silkscreen designators, header, caps, LEDs, mounting holes, title label; click → premium info panel.
- All prior kits still work; walls solid; collision fixed; 642+ tests green; no external assets; no secrets.
- Deployed + pushed.
