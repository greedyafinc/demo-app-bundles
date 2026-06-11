# Bundling Rowboat for the UnifiedApp marketplace

This directory ships [rowboatlabs/rowboat](https://github.com/rowboatlabs/rowboat)'s
**RowboatX** agent workspace as a UnifiedApp **marketplace bundle**, the same way
OpenDesign, Hermes, OpenClaw and Vibe-Trading do. This document explains what is
vendored, what was changed, and how the pieces fit the `node-service` model.

## What Rowboat is (and which part we bundle)

The upstream repo is a monorepo in motion. The part we ship is the current
self-hostable core:

- **`apps/cli`** (vendored as [`cli/`](cli/)) — the `@rowboatlabs/rowboatx` Node
  service: a Hono HTTP server + agent runtime. Agents are plain Markdown files
  with YAML frontmatter; the copilot agent is built in. LLM calls go through the
  Vercel AI SDK behind a provider registry (`src/models/models.ts`), tools come
  from MCP servers (`~/.rowboat/config/mcp.json`) and builtins.
- **`apps/rowboatx`** (vendored as [`ui/`](ui/)) — the dashboard: a Next.js
  **static export** (`output: "export"`), i.e. a pile of static files with no
  Next server. Upstream pairs it with an Electron shell; we serve it from the
  rowboatx server itself, same-origin with the API.

NOT bundled: the legacy `apps/rowboat` web stack (Mongo/Redis/Qdrant
docker-compose), the `apps/x` Electron app (IPC-based renderer, no HTTP seam),
docs, and the python-sdk.

## Bundle layout (`node-service` kind)

```
manifest.json            ← kind + how to start the service (healthPath /health)
launch.mjs               ← service entrypoint (ours): env bridge + config seed
cli/                     ← compiled server (dist/) + production node_modules
ui/out/                  ← dashboard static export, served same-origin by the server
runtime/node/            ← embedded Node 24 (no system Node required)
index.html               ← placeholder for older hosts
```

On launch the desktop host (desktop_core/service.rs) allocates a port, injects
`OD_PORT`/`OD_BIND_HOST`/`OD_DATA_DIR` (+ broker env, below), spawns
`runtime/node/bin/node launch.mjs` with workingDir = bundle root, polls
`/health` until 2xx, and opens the webview at the service URL.

`launch.mjs` bridges the host env to Rowboat's own seams:

| Host env | → | Rowboat |
|----------|---|---------|
| `OD_PORT` | → | `PORT` (the Hono server binds it) |
| `OD_BIND_HOST` | → | `HOST` (127.0.0.1) |
| `OD_DATA_DIR` | → | `ROWBOAT_HOME` = `$OD_DATA_DIR/rowboat` (agents/config/runs live here; the install tree is read-only) |
| — | → | `ROWBOAT_UI_DIR=ui/out` (server serves the dashboard) |

## Auth — the loopback broker + `@unifiedai/sdk`

A bundled app **never sees the user's long-lived token**. The host injects
`UNIFIED_BROKER_URL` / `UNIFIED_BROKER_TOKEN` / `UNIFIED_APP_SLUG`;
`cli/src/unified/auth.ts` exchanges them for a short-lived app-scoped JWT
(signed by base-api, accepted by unified-api), caches it until ~30s before
expiry, and re-reads `$OD_DATA_DIR/.broker.json` on every mint so a service
reused across a desktop restart self-heals (the OpenDesign daemon pattern).

Two consumers sit on top of that token provider:

1. **The `unified` model-provider flavor** (`cli/src/models/models.ts`) — the
   LLM path. `createOpenAICompatible` pointed at unified-api's `/api/v1`
   surface, with a custom `fetch` that injects a *fresh* broker token per
   request (and retries once on 401). The AI SDK caches provider instances, so
   auth deliberately lives in the fetch layer, not in a static `apiKey` — the
   ~5-minute token rotation is invisible to the runtime.
2. **`@unifiedai/sdk` in trusted-token mode** (`cli/src/unified/sdk.ts`) — the
   platform-surface path. The SDK gets `token: () => getUnifiedToken()` and
   serves `GET /unified/models`, the gateway catalog (with author metadata)
   for model pickers. Imported from the SDK's **browser entry** on purpose:
   the `/node` entry adds OAuth + OS-keychain machinery a brokered marketplace
   app must never use.

The gateway address is `UNIFIED_API_URL` (default `http://localhost:3141`, the
dev gateway on loopback — the same default as OpenDesign and Hermes; the host
injects broker coords but not a gateway URL).

### Seamless chat — seeding `models.json`

When `launch.mjs` detects broker env, it seeds
`$ROWBOAT_HOME/config/models.json`:

```json
{
  "providers": { "unified": { "flavor": "unified" } },
  "defaults": { "provider": "unified", "model": "gpt-5.4" }
}
```

so the first chat works with zero setup. The seed is conservative: an existing
config is replaced **only** when it is byte-for-byte the untouched upstream
default (provider `openai`, no key — dead anyway); anything user-edited is
respected. The default model is a **concrete** catalog id (`UNIFIED_DEFAULT_MODEL`
override), not `auto`. No URLs or keys are stored in the file — the gateway
address comes from env and auth from the broker — so there is nothing to go
stale (no self-heal pass needed, unlike Hermes's seeded `base_url`).

## What was changed vs upstream (all in-place, env-gated where possible)

| File | Change |
|------|--------|
| `cli/src/unified/auth.ts` (new) | Broker auth: mint/cache, `.broker.json` re-read, `unifiedFetch` (per-request token + one 401 retry). |
| `cli/src/unified/sdk.ts` (new) | `@unifiedai/sdk` trusted-token client (broker token provider). |
| `cli/src/models/models.ts` | `unified` flavor in the `Flavor` enum + `getProvider` case (openai-compatible against the gateway via `unifiedFetch`). |
| `cli/src/app.ts` | `unified` rows in the interactive `modelConfig` default maps (compile-time `Record<Flavor, …>` exhaustiveness). |
| `cli/src/config/config.ts` | `ROWBOAT_HOME` env seam for `WorkDir`; ensure `runs/` exists (POST `/runs/new` appends before the runtime ever mkdirs it). |
| `cli/src/server.ts` | Completed the REST surface its own TUI client (`src/tui/api.ts`) and the dashboard already call but HEAD doesn't serve: `/health`, `GET /runs`, `GET /runs/:id`, `POST /runs/new`, `/agents` list/get/put, `/mcp` get/upsert/delete, `/models` get + providers upsert/delete + default, `/config/:name`; dashboard-origin routes (`/api/stream` SSE alias, `/api/rowboat/{summary,agent,config,run}` with path-traversal guards); `GET /unified/models`; static `ui/out` serving (`ROWBOAT_UI_DIR`); `HOST` binding. |
| `cli/package.json` | `@unifiedai/sdk` git dependency. |
| `ui/app/page.tsx` + `ui/global.d.ts` | `apiBase` falls back to `window.location.origin` when no Electron-style `window.config` is injected (the bundle serves UI + API same-origin). |

Everything else is byte-identical to upstream `e2178c14` (see
[`.upstream-sha`](.upstream-sha)).

## Build

```bash
# from this dir (requires: bash, curl, git, zip, and bun on PATH — the
# @unifiedai/sdk git dep builds itself with bun in its prepare script)
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh
```

Downloads Node 24 (cached in `.bundle-build/`), builds `cli` (tsc) and `ui`
(next static export), stages, normalizes symlinks (the installer rejects any
that escape the bundle root), zips to `./rowboat-bundle-darwin-arm64.zip`, and
prints the `sha256` + `sizeBytes` for `apps.js`. The build embeds a
platform-specific Node, so run it on (or set `NODE_PLATFORM` for) the target.

## Install + test locally

1. `./build-bundle.sh`.
2. In the UnifiedApp desktop, enable the **"Use local bundles"** dev toggle
   (installer reads `localUrl`, skips sha256).
3. Install **Rowboat** from the marketplace. Verify: the service spawns on
   `OD_PORT`; `/health` returns 200 inside `readyTimeoutMs`; the dashboard
   loads; the sidebar lists workspace files; chat with the copilot routes
   through the broker token to unified-api (watch `apps/logs/rowboat.log`).

## Known risks / follow-ups

- **Upstream is mid-pivot.** `apps/cli` + `apps/rowboatx` is the self-hostable
  core today, but Rowboat Labs' release artifact is the `apps/x` Electron app.
  Expect drift when re-vendoring; the server-route completion in `server.ts`
  may collide with (or be superseded by) upstream's own server work.
- **Agent ↔ gateway E2E.** Chat through the broker needs the live desktop +
  unified-api; the standalone smoke test exercises the API surface and UI
  serving, not a real model call. Confirm a chat after installing.
- **Tool execution is real.** Rowboat agents can run shell commands via the
  builtin `executeCommand` tool (that's the product). Runs are permission-gated
  per tool call through the dashboard, but treat installs accordingly.
- **Model picker.** The dashboard edits `models.json` as raw JSON; the gateway
  catalog is available at `GET /unified/models` but the stock UI doesn't render
  a picker from it yet. A follow-up could surface it next to the agent selector.
- **Voice input** (microphone button) is upstream UI affordance only here —
  no Deepgram key is bundled.
