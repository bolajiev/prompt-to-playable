# Deployment

The app is one origin in every environment: the Vite client is served as static
files and the Express API handles `/generate`, `/edit`, and `/healthz`. The
browser always calls those paths relative to its own origin, so there is no
client-side API URL or CORS configuration.

| Target | Static client | API |
|---|---|---|
| Vercel | `apps/web/dist` (CDN) | `api/index.ts` → `server/dist` (one Vercel Function) |
| Docker / local prod | Express static from `apps/web/dist` | same Express process |

## Environment variables

Names only — never commit or print values.

| Name | Required | Where | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | yes (for generation) | Vercel project env, or `server/.env` locally | Key for the chat-completions endpoint. Without it the server still boots; `/generate` and `/edit` fail with a clear error. |
| `OPENAI_BASE_URL` | no | same | OpenAI-compatible base URL. Default `https://api.openai.com/v1`. |
| `OPENAI_MODEL` | no | same | Model id. Default `gpt-4o-mini`. |
| `OPENAI_SESSION_ID` | no | same | Stable session id sent as the `X-Session-Id` header; required by the OpenCode go gateway. |
| `PORT` | no | local/Docker only | Port for `node server/dist/index.js`. Default `3000`. |
| `WEB_DIST` | no | local/Docker only | Static client directory for the Express process. Default `<repo>/apps/web/dist`. |

Any OpenAI-compatible endpoint works with the same vars (base URL + model +
key only). The OpenCode gateway uses
`OPENAI_BASE_URL=https://opencode.ai/zen/go/v1` and
`OPENAI_MODEL=deepseek-v4.1-flash`; its `go` route additionally requires a
stable session id in `OPENAI_SESSION_ID`, which the server sends as the
`X-Session-Id` header. Zen and other OpenAI-compatible endpoints do not need
it. The Google AI Studio option remains valid:
`OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`
with model `gemini-3.1-flash-lite`.

Local values live in `server/.env` (gitignored, mode 600, excluded from Vercel
uploads by `.vercelignore`); copy the shape from `server/.env.example`.
Vercel functions never read `server/.env` — they use project environment
variables.

## Vercel

`vercel.json` pins the build (`npm run build && npm run build:web`), the static
output (`apps/web/dist`), `maxDuration: 60` for `api/index.ts`, and rewrites
`/generate`, `/edit`, `/healthz` to that function. `framework` is `null` so no
framework preset overrides the explicit static output.

1. Link the repo to a project (once):

   ```bash
   vercel link --yes --project prompt-to-playable
   ```

2. Add environment variables (names only; values are read from `server/.env`
   locally or typed into the dashboard). Repeat for `preview` if preview
   deployments should generate games:

   ```bash
   vercel env add OPENAI_API_KEY production
   vercel env add OPENAI_BASE_URL production   # optional
   vercel env add OPENAI_MODEL production      # optional
   vercel env add OPENAI_SESSION_ID production # optional; required by the OpenCode go gateway
   ```

   Dashboard alternative: Project → Settings → Environment Variables.

3. Deploy:

   ```bash
   vercel deploy            # preview
   vercel deploy --prod     # production
   ```

4. Verify:

   ```bash
   curl -s https://<project>.vercel.app/healthz          # {"status":"ok"}
   curl -sI https://<project>.vercel.app/ | head -1      # HTTP/2 200
   curl -s https://<project>.vercel.app/generate \
     -X POST -H 'content-type: application/json' \
     -d '{"prompt":"a small room where I collect 3 glowing crystals"}'
   ```

Notes:

- Vercel Hobby caps function duration at 60 s (configured). A generation that
  exceeds it surfaces as a gateway timeout; the UI shows an error instead of
  hanging.
- `npm run build` is `tsc -b`: it builds `packages/*`, `server/dist`,
  `apps/web/dist` types and the `api/` entry before Vercel traces the function.
- `server/.env` must never be uploaded: it is covered by `.vercelignore`
  (`.env*` with `!.env.example`) because the Vercel CLI does not honor
  `.gitignore`.

## Docker / local production (single origin)

Local, no Docker:

```bash
npm ci && npm run build && npm run build:web && npm run serve:prod
```

Then open http://localhost:3000. `serve:prod` loads `server/.env` at boot.

Docker — add this `Dockerfile` to the repo root:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm run build:web
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
```

and a `.dockerignore` so the build context never carries secrets or stale
artifacts:

```
node_modules
**/dist
.env*
!.env.example
```

Build and run (one command, values come from the untracked `server/.env`):

```bash
docker build -t prompt-to-playable . && docker run --rm -p 3000:3000 --env-file server/.env prompt-to-playable
```

Open http://localhost:3000. In the container the Express process serves both
the API and the SPA fallback from `apps/web/dist` (`WEB_DIST` default), so no
reverse proxy is required.
