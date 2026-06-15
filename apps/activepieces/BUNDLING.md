# Activepieces — UnifiedApp marketplace bundle

This directory is the upstream **[activepieces/activepieces](https://github.com/activepieces/activepieces)**
source, pinned to a commit (see [`.upstream-sha`](.upstream-sha)) with our changes applied in-place, **plus**
the UnifiedApp bundling layer (`build-bundle.sh`, `launch.mjs`, `normalize-symlinks.mjs`, this file).

- **Upstream:** activepieces/activepieces — open-source workflow automation (an open-source Zapier/n8n).
- **Pinned tag:** `0.85.2` (commit in `.upstream-sha`).
- **Kind:** `node-service` (runs as a local daemon, embedded in the UnifiedApp shell). The marketplace card
  also declares a synthesized `soloBundle`, so it can additionally be installed as a standalone
  **Activepieces.app** with its own Dock icon (UNI-48 data-driven solo runner — no separate artifact).
- **License:** MIT (community edition). Enterprise (`packages/server/api/src/app/ee`, `packages/ee`) code
  is present in the tree but never reached: we run with `AP_EDITION=ce`.

## How it runs

Activepieces is a **Fastify** backend + **React/Vite** frontend (build tooling: **Bun 1.3.3**, **Node 24.14**).
In production a single Fastify process serves the built frontend **and** the API on one port (`AP_PORT`), and a
separate worker process polls the app over HTTP to execute flows. We run it in its **single-machine** shape so
there are **no external Postgres/Redis** dependencies:

- `AP_DB_TYPE=PGLITE` — embedded Postgres (data under the writable per-app data dir).
- `AP_REDIS_TYPE=MEMORY` — in-process queue.

`launch.mjs` is the manifest `service.command` target. It mirrors Activepieces' own `docker-entrypoint.sh`
single-container behaviour by spawning **two** Node children that share a stable `AP_JWT_SECRET` /
`AP_ENCRYPTION_KEY` (persisted to `OD_DATA_DIR/secrets.json` so the encrypted DB stays readable across restarts):

| child | entry | `AP_CONTAINER_TYPE` | role |
|-------|-------|---------------------|------|
| app    | `packages/server/api/dist/src/main.js`     | `APP`            | binds `AP_PORT` (= `OD_PORT`), serves UI + API + job broker. cwd = bundle root (the app resolves `dist/packages/web` from `process.cwd()`). |
| worker | `packages/server/worker/dist/src/index.js` | `WORKER_AND_APP` | polls `http://127.0.0.1:$AP_PORT/api/` and starts **no** health server (that only happens when `AP_CONTAINER_TYPE=WORKER`), avoiding a port clash with the app. |

The worker needs `AP_WORKER_TOKEN` (an HS256 JWT signed with `AP_JWT_SECRET`, claims `{type:'WORKER'}`), minted in
`launch.mjs` exactly as the upstream entrypoint does.

Host **health check:** the desktop polls `GET /api/v1/health` on `OD_PORT` (the app); `readyTimeoutMs` is 180s
because the first boot runs PGLite migrations.

## Changes applied to upstream

In-place source patches (everything else is bundling-layer files):

- **`packages/server/api/src/app/server.ts` — iframe embedding.** The `onSend` hook sets a CSP
  `frame-ancestors` header that defaults to `'self'`, which blocks the desktop shell from embedding the app in an
  iframe. The shell's macOS production parent origin is the custom scheme `tauri://localhost`, which
  Activepieces' `isValidOrigin()` rejects, so the stock `AP_ALLOWED_EMBED_ORIGINS` path can't carry it. The patch
  honours a raw `AP_EMBED_FRAME_ANCESTORS` env override (set by `launch.mjs` to the UnifiedApp Tauri origins —
  kept in sync with `apps/openclaw`) and otherwise falls back to the normal embed-security resolution.

- **`packages/server/api/src/app/server.ts` — local auto-login.** So the single-user appliance opens straight to
  the dashboard with no sign-in screen: when `AP_LOCAL_AUTOLOGIN_EMAIL`/`_PASSWORD` are set (by `launch.mjs`,
  password persisted in `OD_DATA_DIR/secrets.json`), the SPA `index.html` handler provisions/signs-in a single
  local admin over loopback and injects its **real** session token into `localStorage` (`token`/`projectId`)
  before the React app loads. Uses only the public auth endpoints; a real token works for both HTTP and the
  socket.io handshake; cached + refreshed an hour before its 7-day expiry. `index:false` + explicit `/` +
  `/index.html` routes are needed because `@fastify/static` otherwise 403s the root with `index:false` (and
  claims `/` with the default `index:true`).

- **`packages/server/api/src/app/authentication/authentication.service.ts` — full token in CE.** A Community
  sign-in normally returns an **onboarding** token (`getPreferredPlatformId` is null for CE), forcing the
  `/create-platform` onboarding screen. Gated on `AP_LOCAL_AUTOLOGIN`, `signInWithPassword` instead resolves the
  identity's platform — creating it (`createPlatformWithProject`, name `Local`) on first run, resolving the
  existing one on later runs (no duplicates) — and returns a full **USER** token. The user is auto-verified by
  upstream's own `sendVerificationOrAutoVerify` (CE path), so no SMTP/OTP is needed.

> The local admin is `local@activepieces.local`. To restore the normal sign-in/signup flow, clear the
> `AP_LOCAL_AUTOLOGIN*` env in `launch.mjs`.

## Building

```bash
cd apps/activepieces
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh
```

Prerequisites on the build host: a C/C++ toolchain (macOS: **Xcode Command Line Tools**) for any native deps, and
network access (Bun fetches prod deps; Activepieces fetches pieces at runtime). The script:

1. Downloads + embeds **Node 24.14** (`runtime/node`) and **Bun 1.3.3** (`runtime/bun`) — both go on `PATH` at
   launch (the worker shells out to `bun` to install registry pieces at runtime).
2. `bun install --frozen-lockfile`, then `turbo run build --filter=web --filter=@activepieces/engine
   --filter=api --filter=worker` (the Dockerfile's build set).
3. Trims pieces to the 4 the api imports (`slack`, `square`, `facebook-leads`, `intercom`) the way the Dockerfile
   does and produces a lean production `node_modules` **in place**, then stages the run tree **with**
   `node_modules` (the workspace piece symlinks live in `packages/server/api/node_modules`, so the stage must
   carry it — an `--exclude node_modules` rsync makes the app crash at boot).
4. Embeds the ephemeral-**redis** binary at `runtime/redis/redis-server` (fetched once via a throwaway
   `redis-memory-server` start/stop) so the MEMORY queue never downloads redis at runtime — `launch.mjs` points
   `REDISMS_SYSTEM_BINARY` at it.
5. Writes `manifest.json`, copies `launch.mjs`, normalizes escaping symlinks, and zips
   `activepieces-bundle-darwin-arm64.zip` (printing the sha256 + byte size for `apps.js`).

The remaining 400+ pieces are fetched from the cloud registry on demand at runtime
(`AP_PIECES_SYNC_MODE=OFFICIAL_AUTO`, the upstream default), so they are intentionally not bundled.

After building, paste the printed `sha256` / `sizeBytes` into UnifiedApp
`apps/desktop/src/data/apps.js` and (for a remote release) upload the zip:

```bash
gh release upload activepieces-v0.85.2 activepieces-bundle-darwin-arm64.zip --repo greedyafinc/demo-app-bundles
```

## Using AI on your Unified subscription

Activepieces' AI pieces / Universal AI read their provider config from the **Admin Console → AI** (stored in the
DB), and support a **custom Base URL** in the community edition. `launch.mjs` runs a small loopback proxy that
forwards OpenAI-compatible requests to the Unified gateway with a freshly-minted, app-scoped token attached (the
app never sees a long-lived credential; the rotating token is refreshed in the background). To wire it up:

1. Open **Settings → AI** (Platform Admin) in Activepieces.
2. Add an **OpenAI**-compatible provider with **Base URL** `http://127.0.0.1:25152/v1` (the launcher logs this and
   writes it to `OD_DATA_DIR/.unified-ai-gateway.json`; override the port with `UNIFIED_AI_PROXY_PORT`). Any API
   key value works — the proxy substitutes the real token.

> Status: the launcher + proxy are wired, but the end-to-end AI flow has not yet been smoke-tested against a built
> bundle. Auto-seeding the provider into the PGLite DB at first run (true zero-setup) is a follow-up.

## Notes / follow-ups

- **darwin-arm64 only** for now (matches the other bundles). Other platforms need their Node/Bun targets (the
  script already maps `NODE_PLATFORM` → the right Bun target).
- **Not yet built/released** — `apps.js` carries the `localUrl` (dev "Local" install) and a placeholder remote
  `url` + empty `sha256`; fill them in after the first `./build-bundle.sh` + release.
- **Account:** Activepieces keeps its own local account (first signup becomes the admin) — sign-in is not bridged
  to the UnifiedApp account. The gateway hook above is what ties it to the Unified subscription.
