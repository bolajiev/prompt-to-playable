# Deployment, Browser QA & Submission Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a hosted browser demo (Vercel), verify it with a real browser, record the <3min demo video, publish the public repo, and finalize submission assets.

**Architecture:** Production mode serves the built Vite client and the Express API from one origin (locally: Express static; on Vercel: static outputDirectory + one serverless function wrapping the same Express app). Browser QA and demo recording use Playwright (browsers already cached under /root/.cache/ms-playwright) with ffmpeg for mp4+captions.

**Tech Stack:** existing monorepo + Vercel CLI (authenticated), gh CLI (authenticated), Playwright, ffmpeg, Express static serving.

**Spec:** docs/superpowers/specs/2026-10-09-prompt-to-playable-game-design.md

## Global Constraints
- **Secrets:** live key stays in gitignored `server/.env` (mode 600) and in Vercel project env vars only. Never print it; never commit it; never put it in scripts/docs/logs/tests. On Vercel, set env vars by piping from `server/.env` without echoing.
- **Engine purity** (no DOM/Three) and all prior invariants remain.
- Client must keep posting to relative `/generate` and `/edit` (single-origin in every environment).
- No new runtime dependencies for the server; Playwright is dev-only.
- Live LLM calls are budgeted: ≤ 6 calls for QA/deploy verification beyond what's already been spent; demo recording should reuse one generation.
- Do not break `npm test` / `tsc -b`; browser scripts are separate from vitest (not picked up by `vitest run`).
- Vercel Hobby function duration cap: configure `maxDuration: 60`; the client must surface a clear error if a generation times out (serverless limit) rather than hanging.
- Demo video: < 3:00, mp4, captions burned in, stored at `docs/submission/demo.mp4` (commit only if < 40 MB).

## Interfaces (Phase 3)

```
Local prod:   node server/dist/index.js  →  HTTP :3000 serves API + apps/web/dist (SPA fallback)
Vercel prod:  static apps/web/dist  +  /generate,/edit,/healthz → api/index.ts (Express app)
QA:           scripts/qa-browser.ts    → screenshots artifacts/qa/*.png, exit 1 on console errors/failures
Demo:         scripts/demo-record.ts   → artifacts/demo/*.webm → ffmpeg → docs/submission/demo.mp4
```

---

## Task P3.0: Production build + single-origin serving

**Files:**
- Modify: `server/src/index.ts` (static serving + SPA fallback + `/healthz`; keep `startServer` testable; validate PORT finite)
- Modify: `server/package.json` (exports stay; deps unchanged)
- Modify: root `package.json` (scripts: `build:web`, `start`, `serve:prod`)
- Modify: `apps/web/vite.config.ts` (build output default `dist`; keep dev proxy)
- Test: `server/tests/static.test.ts`

**Interfaces:**
- Consumes: `createApp`/`createDefaultHandlers` (routes.ts/index.ts), `apps/web/dist` build output.
- Produces: `GET /healthz` → `{status:"ok"}`; static assets + SPA fallback (`index.html`) when `WEB_DIST` exists; `startServer` logs the URL (never secrets).

- [ ] **Step P3.0.1: Build scripts** — root: `"build:web": "npm --workspace apps/web run build"`, `"serve:prod": "node server/dist/index.js"`, `"start": "npm run build && npm run build:web && npm run serve:prod"`. Verify `apps/web/package.json` has `build` (vite build) and fix if needed.
- [ ] **Step P3.0.2: Failing test** (`static.test.ts`): create a temp dir with `index.html` + `asset.txt`; use a new `buildApp(handlers, { webDist })` seam → `GET /healthz` 200 `{status:"ok"}`; `GET /asset.txt` 200; `GET /some/spa/route` returns index.html; `GET /generate` still reaches the API (not the SPA fallback); invalid PORT → clear thrown message at startup. Use supertest against the app, not a real listen.
- [ ] **Step P3.0.3: Implement** — add `GET /healthz` inside `routes.ts createApp` (so the Vercel function gets it without static); in `index.ts` extend `buildApp(handlers, options?: {webDist?: string})`: when `webDist` is provided and exists, `express.static(webDist)` + SPA fallback `app.get("*", ...)` sending index.html for GETs that don't start with `/generate|/edit|/healthz`. `startServer` resolves `webDist` = `process.env.WEB_DIST ?? <repo>/apps/web/dist` and validates `PORT` is a finite number (clear error otherwise). Re-export `createApp` from `index.ts` for the Vercel entry.
- [ ] **Step P3.0.4: Verify locally** — `npm run build && npm run build:web`; start prod server on :3210; `curl -s localhost:3210/healthz`; `curl -sI localhost:3210/ | head -1`; `curl -s localhost:3210/generate -X POST -H 'content-type: application/json' -d '{}'` → 400 (validator), proving API routing. Kill server.
- [ ] **Step P3.0.5: Run tests + commit** — `npx vitest run && npx tsc -b`; commit `feat(server): production static serving, healthz, build scripts`.

---

## Task P3.1: Vercel deployment config

**Files:**
- Create: `api/index.ts` (repo root; default-export the Express app)
- Create: `vercel.json`
- Create: `.vercelignore`
- Create: `docs/deployment.md` (both Vercel and Docker paths; env var names only)

**Interfaces:**
- Consumes: built `server/dist` + workspace packages (built by `tsc -b` in the Vercel build).
- Produces: rewrites `/generate`, `/edit`, `/healthz` → `/api/index`; static `apps/web/dist`; `maxDuration: 60` for the function.
- `api/index.ts`:
```ts
import { createApp, createDefaultHandlers } from "../server/dist/index.js";
export default createApp(createDefaultHandlers());
```
  (If `server/dist/index.js` doesn't export `createApp`, re-export it from `server/src/index.ts` first — keep this import stable.)
- `vercel.json` (sketch; final values in file):
```json
{
  "buildCommand": "npm run build && npm run build:web",
  "outputDirectory": "apps/web/dist",
  "functions": { "api/index.ts": { "maxDuration": 60 } },
  "rewrites": [
    { "source": "/generate", "destination": "/api/index" },
    { "source": "/edit", "destination": "/api/index" },
    { "source": "/healthz", "destination": "/api/index" }
  ]
}
```
- `.vercelignore`: `.git`, `.superpowers`, `coverage`, `**/*.tsbuildinfo`, `.env*` (except `.env.example`), `artifacts`, `docs/superpowers`.

- [ ] **Step P3.1.1: Create files; ensure `createApp`/`createDefaultHandlers` are exported from `server/src/index.ts` (add exports if missing, no behavior change).**
- [ ] **Step P3.1.2: Local sanity** — `npx tsc -b` still clean (api/index.ts may need `// @ts-nocheck`? No: include it in a tsconfig or accept CLI-only compile. Prefer adding `api` to root tsconfig references only if clean; otherwise leave it type-checked by Vercel's builder and note it).
- [ ] **Step P3.1.3: Write `docs/deployment.md`** (Vercel deploy steps + env vars + Docker alternative one-command, no secrets).
- [ ] **Step P3.1.4: Commit** `chore(deploy): vercel config, api entry, deployment docs, single-origin server`.

---

## Task P3.2: Deploy to Vercel + verify (controller-run)

**Files:**
- No repo files (ops).

**Interfaces:**
- Consumes: `vercel` CLI (authenticated), `server/.env`.
- Produces: production URL; then verified `/healthz`, static `/`, one live `/generate`.

- [ ] **Step P3.2.1: Link/create project** — `vercel link --yes --project prompt-to-playable` (scope = authed account). Never print `.env`.
- [ ] **Step P3.2.2: Set env vars** (piped, no echo):
```bash
for k in OPENAI_API_KEY OPENAI_BASE_URL OPENAI_MODEL; do
  grep "^$k=" server/.env | cut -d= -f2- | vercel env add "$k" production
done
```
- [ ] **Step P3.2.3: Deploy** — `vercel deploy --prod --yes`; capture the production URL.
- [ ] **Step P3.2.4: Verify** — `curl -s $URL/healthz` → `{"status":"ok"}`; `curl -sI $URL/` → 200 text/html; live `POST $URL/generate` with one simple prompt → 200 + valid doc (archetype + player present); `POST $URL/edit` with that doc + "add a second guard" → 200 + `{doc,patch}`. Budget ≤ 3 live calls. If a 60s timeout occurs, record it in the ledger and retry once.
- [ ] **Step P3.2.5: Record URL in README + description (P3.5 does the edits; note URL in ledger).**

---

## Task P3.3: Playwright browser QA (screenshots + console errors)

**Files:**
- Create: `scripts/qa-browser.ts` (standalone; `npx tsx scripts/qa-browser.ts <url>`)
- Create: `scripts/playwright-env.ts` (small helper to resolve chromium executable from /root/.cache/ms-playwright if the Playwright download path is unavailable)
- Modify: root `package.json` (`"qa:browser": "tsx scripts/qa-browser.ts"`), add devDependency `playwright` (match cached chromium build; if version mismatch downloads once — allowed)
- Output: `artifacts/qa/01-landing.png`, `02-generated.png`, `03-playing.png`, `04-edited.png`, `console.log` (gitignored artifacts dir)

**Interfaces:**
- Consumes: deployed or local prod URL; the real UI (`#chat-input`, `#chat-submit`, canvas `#game`, `#hud`, `#badge`).
- Produces: exit 0 only if: page loads with 0 console errors; after submitting `a small room where I collect 3 glowing crystals while avoiding one guard`, `#badge` shows `validated`, `#hud` lists an objective, canvas has non-trivial pixels; after pressing `w` for 1s the player position changes (read via a `window.__debug` hook OR screen-diff of canvas pixels); screenshots saved for every beat.

- [ ] **Step P3.3.1: Add a debug hook** — in `apps/web/src/app.ts`, expose `window.__gameDebug = { getState: () => engine.getState() }` (read-only snapshot; dev/QA aid, harmless in prod) so QA can assert player movement without pixel diffing. Test in `apps/web/tests` that the factory returns a snapshot shape (pure function, no DOM).
- [ ] **Step P3.3.2: Implement `qa-browser.ts`** — launch chromium headless (no-sandbox), 1280×720; capture console errors; screenshot each beat; assert badge/HUD/debug movement; print a one-line PASS/FAIL summary; exit 1 on failure. Keep one live generation per run.
- [ ] **Step P3.3.3: Run against the deployed URL** (P3.2 URL). Fix issues found (camera behaviour, HUD, badge) as small follow-up commits.
- [ ] **Step P3.3.4: `npx vitest run` (web tests green) + commit** `test(qa): browser QA script with debug hook and screenshots`.
- [ ] **Step P3.3.5 (controller): view screenshots** (`artifacts/qa/*.png`) and confirm the scene renders: player visible, crystals/guard present, HUD + controls hint + badge correct. Record any visual fixes as follow-up tasks.

---

## Task P3.4: Demo video recording

**Files:**
- Create: `scripts/demo-record.ts` (Playwright video context, scripted beats, captions timestamps emitted to `artifacts/demo/beats.json`)
- Create: `scripts/demo-encode.sh` (ffmpeg: webm → mp4 H.264 + burned captions per beat)
- Output: `docs/submission/demo.mp4` (<3:00; commit only if <40MB; else keep in artifacts and document)

**Interfaces:**
- Consumes: deployed URL; demo-script beats (`docs/submission/demo-script.md`).
- Produces: `demo.mp4` with captions at: 0:00 prompt typed; 0:08 generating; 0:20 playable + badge; 0:35 movement/jump/interact; 1:10 live edit ("add a second guard"); 1:30 replay; 2:05 lose beat (optional); 2:20 win beat; 2:40 close.

- [ ] **Step P3.4.1: Implement `demo-record.ts`** — one generation reused for all beats (budget: 1 gen + 1 edit); generous waits keyed to badge/HUD state, not fixed sleeps; `recordVideo.size = 1280x720`; save beats.json (ms offsets).
- [ ] **Step P3.4.2: Implement `demo-encode.sh`** — check font: `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf` (fallback to any available `*.ttf`); drawtext per beat window; `-c:v libx264 -pix_fmt yuv420p -crf 23 -preset veryfast`; print duration with ffprobe.
- [ ] **Step P3.4.3: Record + encode**; verify with `ffprobe` duration < 180s and `docs/submission/demo.mp4` exists.
- [ ] **Step P3.4.4 (controller): view 3-4 extracted frames** (`ffmpeg -ss ... -frames:v 1`) to confirm readability (captions legible, HUD visible).
- [ ] **Step P3.4.5: Commit** `docs(submission): demo video artifact + recording scripts` (skip mp4 if >40MB).

---

## Task P3.5: Public GitHub repo + submission assets

**Files:**
- Modify: `README.md` (live demo URL, repo URL, deploy section link, QA/video scripts, credits/licensing note)
- Modify: `docs/submission/description.md` (final: what/problem/AI role/tech + URLs + category)
- Create: `LICENSE` (MIT, author = user's gh identity `bolajiev`)
- Create: `CONTRIBUTING.md` (optional; skip if noise)
- `.gitignore`: add `artifacts/`

**Interfaces:**
- Consumes: gh CLI (authed `bolajiev`).
- Produces: public `https://github.com/bolajiev/prompt-to-playable`(name TBD) with full history.

- [ ] **Step P3.5.1: Pre-push secret audit** — `git log --all --full-history -- . ':!package-lock.json' | grep -nE 'AIza|sk-[A-Za-z0-9]{20,}'` must be empty; `git log --all --full-history -- server/.env` must be empty; `.env` in `.gitignore` (already).
- [ ] **Step P3.5.2: Docs edits** (live URL from P3.2; video path; QA instructions).
- [ ] **Step P3.5.3 (controller): create + push** — `gh repo create prompt-to-playable --public --source=. --remote=origin --push` (name may need `-2` suffix if taken; confirm in ledger).
- [ ] **Step P3.5.4: Verify** — `gh repo view --json url,visibility` shows PUBLIC; fresh-clone smoke: `git clone` to /tmp, `npm install`, `npm test` (must pass without server/.env).
- [ ] **Step P3.5.5: Commit remaining doc edits.**

---

## Task P3.6: Final verification + handoff

- [ ] **Step P3.6.1** `npx tsc -b && npx vitest run` (all green), engine purity grep clean.
- [ ] **Step P3.6.2** Deployed URL re-check: `/healthz`, static page, and one generation (≤1 call). Re-check after any later deploy.
- [ ] **Step P3.6.3** Submission checklist in ledger: public repo ✅ / hosted demo ✅ / demo video ✅ / description ✅ / category ✅ / credits ✅ / key rotation reminder.
- [ ] **Step P3.6.4** Update `README.md` "How to test" to include `npm run build` before `npm test` (clean-clone requirement noted by final review M2).

## Acceptance Criteria
- `https://<project>.vercel.app` serves the client; `/healthz` OK; a real prompt generates a playable game; an edit works (live verification recorded).
- Browser QA passes with screenshots proving rendering, HUD, badge, and movement.
- `docs/submission/demo.mp4` exists, < 3:00, captions burned in.
- Public GitHub repo with clean secret audit; fresh clone runs `npm install && npm run build && npm test` green.
- No secrets in repo/history/artifacts/docs; live key remains only in `server/.env` + Vercel env.
- Post-hackathon key rotation documented in README/description.
