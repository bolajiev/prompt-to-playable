# Phase 7 — Agent harness, interactive machines, black theme

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** (1) Turn generation into a real **agent** with tools and self-verification (plan → generate → validate → sanity → **simulate** → repair → ship) with a visible reasoning trace. (2) Add **interactive controls** (sliders/toggles/buttons bound to entity motion) and a **machine kit** so prompts like "a robotic arm with joint sliders I can control" produce plug-and-play interactive machines (reference: sim-robotic-arm.netlify.app — click-to-learn parts + live control panels). (3) Restyle the frontend to a **premium black** theme.

**Architecture:** Engine stays pure/deterministic. Controls are data: `doc.controls[]` bindings (slider/toggle/button → entity property or scratch var/action); `state.ui.controls` holds live values; engine applies bindings each tick. The agent is a server-side loop over tool functions (existing pipeline pieces + a new headless **simulate** tool that runs the real engine on the candidate document and reports pass/fail with reasons). Trace of steps+timings returned with the document and rendered in the studio.

**Spec:** docs/superpowers/specs/2026-10-09-prompt-to-playable-game-design.md

## Global Constraints
- Engine purity/determinism; renderer non-mutation; validated-JSON-only; secrets rules unchanged.
- Backward compatibility: new schema fields optional; existing fixtures/tests stay green.
- Quality over latency (budgets stay loose).
- No external assets; fonts bundled.
- `npx vitest run` + `npx tsc -b` green after every task.

## Interfaces (canonical)

```ts
// schema additions
export const ControlSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["slider","toggle","button"]),
  label: z.string().min(1),
  min: z.number().optional(), max: z.number().optional(), step: z.number().optional(),   // slider
  value: z.number().optional(),                                                          // default/initial
  bind: z.object({
    entity: z.string().optional(),
    property: z.enum(["rotation.x","rotation.y","rotation.z","position.x","position.y","position.z","visible","color","emissive"]).optional(),
    scale: z.number().optional(), offset: z.number().optional(),
    var: z.string().optional(),                       // write scratch var instead
    onPress: z.array(ActionSchema).optional(),        // button actions (rules vocabulary)
  }).optional(),
});
// doc: controls?: ControlSchema[] (default [])
// meta.mode adds "machine"
// GameState.ui adds: controls: Record<string, number>  (live values; button = pulse 1→0)
// Engine: setControl(id, value), pressControl(id); bindings applied each tick AFTER integrate:
//   rotation.{axis} = base + (value*scale + offset); position.{axis} = base + ...; visible = value > 0.5; color/emissive via existing runtime overrides.
```

```ts
// server agent (new server/src/agent.ts)
export interface AgentStep { tool: string; status: "ok"|"fail"|"skipped"; detail: string; ms: number }
export interface AgentResult { doc: GameDoc; steps: AgentStep[]; repairs: number }
runAgent(prompt, deps): Promise<AgentResult>
// tools: plan (kit+outline), generate, validate (zod), sanity, simulate (headless engine), repair, finalize
```

Simulate tool checks: engine loads doc; N ticks with neutral input — no NaN/throw; for games: scripted pursuit to objective targets → win reachable (or lose if intended); for machine: sweep each slider min→max, assert bound entity property changes and stays finite; for inspect/walkthrough/drive: existing kit playtests as checks; returns structured failures.

---

### Task 1: Black premium theme (landing + studio)
Files: `apps/web/src/styles/tokens.css`, `landing.css`, `studio.css`, `apps/web/index.html`, `app.html`
- Pure-black theme: page `#000` (OLED), panels `#0a0a0b`/`#101013`, hairline borders rgba(255,255,255,0.07), text #f5f6f8 / muted #8b8f98, single accent (keep #7c5cff→#6ea8fe gradient sparingly), stronger type contrast, more whitespace, glassy nav with blur, subtle top-glow only. No purple-tinted background wash.
- Apply consistently to landing + studio; keep all ids/behavior; update screenshots in shots/ only if stale (they show the studio chrome — re-capture 1 shot after theme lands is optional; controller decides).
- Commit: `style(web): premium black theme across landing and studio`.

### Task 2: Controls schema + engine bindings + web control panel
Files: `packages/schema/src/schema.ts`, `packages/engine/src/{state,engine,tick,rules}.ts` (+ `controls.ts` new), `apps/web/src/ui/controls-panel.ts` (new), `app.html`, tests
- Schema per Interfaces (controls optional, mode "machine").
- Engine: `state.ui.controls` init from defaults; `setControl`/`pressControl` APIs; per-tick binding application (after integrate, before rules? binding sets runtime overrides; buttons push `controlPressed` events into the tick event list with targetId=control id so rules can react — add event type `controlPressed {controlId}`).
- Web: control panel UI (right sidebar section above composer): sliders (range inputs, live value), toggles (checkbox), buttons; wired to engine APIs; hidden when doc has no controls; styled per theme.
- Tests: schema accept/reject; engine binding math (slider→rotation, toggle→visible, button→event+actions); determinism; panel pure view-model tests; backward compat.
- Commit: `feat(engine,web,schema): interactive controls and machine mode`.

### Task 3: Machine kit few-shot (robotic arm) + guidance
Files: `server/src/generator.ts`, `server/src/classifier.ts`, `server/src/sanity.ts`, tests, `tests/fixtures/kit-machine.json`, `tests/playtest-v5.test.ts`
- Classifier: machine cues (robot|arm|machine|crane|conveyor|turret|joint|servo|arm) → mode "machine" (archetype explore), keep pcb→inspect.
- Few-shot: 5-axis desktop arm: base cylinder, shoulder/link/link/gripper parts with flat labels (BASE/SHOULDER/ELBOW/WRIST/GRIP), 4 joint sliders (bind rotation.z per joint, scale ~±1.2 rad), a grip toggle (bind visible or var), 2 buttons ("HOME" → actions resetting vars via setVar; "WAVE" → animate sequence), click rules on 3 parts → showPanel (what it does, like the reference), cameraFocus on first click. ≤ 14 entities, ≤ 8 rules + controls ≤ 8.
- Sanity: machine = player optional? (keep player required by schema — place it off to the side); machine checks: ≥1 slider bound to an entity property; every bound entity exists.
- Re-capture fixture (≤3 calls); playtest: sweep shoulder slider → entity rotation changes monotonically; press WAVE → animation entry exists; click a part → panel.
- Commit: `feat(server): machine kit with interactive robotic-arm example`.

### Task 4: Agent harness with tools + visible trace
Files: `server/src/agent.ts` (new), `server/src/simulate.ts` (new tool), `server/src/{pipeline,routes}.ts`, `apps/web/src/ui/agent-trace.ts` (new), tests
- `runAgent(prompt, deps)` per Interfaces; pipeline `/generate` (and `/edit`) use it; response gains `agent: {steps, repairs}` (keep doc as the top-level body for compatibility; add `agent` alongside — update client types).
- Simulate tool per Interfaces (engine-driven; deterministic; bounded ticks; returns failures with reasons).
- Trace UI: a compact "agent" strip in the studio (collapsible): steps with icons/status/timings ("planned kit: machine · generated 14 entities · validated · simulated: joints respond, no NaN · shipped"), animated as they arrive (client animates the returned trace; streaming is out of scope).
- Tests: agent loop with mocked tools (pass first try; simulate-fail → repair → pass; budget exhaustion); simulate tool unit tests on known docs (game win-path, machine slider sweep, NaN guard).
- Commit: `feat(server,web): tool-using agent loop with simulate and visible trace`.

### Task 5: Live re-eval + deploy + docs
- Live subset (machine/arm, PCB, house, race, forest) ≤ 12 calls; playtests; full deployed QA (`--explore --kits`, landing smoke) + manual screenshots (arm with sliders visible).
- README/description: agent section (tools + simulate), machine kit row, black theme screenshots; push.
- Commit: `docs,test: agent + machine kit eval, deploy verified`.

## Acceptance
- Prompt "a robotic arm with joint sliders I can control" → interactive arm: sliders move joints live, grip toggle, HOME/WAVE buttons, click-to-learn panels.
- PCB keeps working (and may gain a control example later — not required).
- Every generation runs through the agent with a visible trace; simulate failures trigger repair (demonstrated by tests).
- Black premium landing + studio.
- Deployed + pushed; all tests green.
