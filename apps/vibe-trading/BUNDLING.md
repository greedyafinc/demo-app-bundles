# Bundling Vibe-Trading for the UnifiedApp marketplace

This repo has been prepped to ship as a UnifiedApp **marketplace bundle**, the same
way OpenDesign and OpenClaw do. This document explains the model, what was added,
and how to build + install it.

## How UnifiedApp marketplace apps work (the OpenDesign model)

A marketplace app is a **self-contained zip** the desktop downloads, verifies
(sha256), extracts, and runs. Apps declare a `kind`:

- `web` — static SPA served via a custom protocol.
- `node-service` — a **local daemon** the desktop spawns, health-checks, and proxies
  a webview to. OpenDesign, OpenClaw — and now Vibe-Trading — are this kind.

A `node-service` bundle is just:

```
manifest.json          ← kind + how to start the service
launch.py              ← service entrypoint (ours)
runtime/python/...      ← embedded, relocatable interpreter (no system Python needed)
agent/                  ← the Python app source
frontend/dist/          ← prebuilt SPA, served same-origin by the app
index.html              ← placeholder for older hosts
```

### Spawn + lifecycle (Rust `desktop_core/src/service.rs`)

`kind: "node-service"` is a **lifecycle category, not a runtime lock** — `service.command`
is a generic executable path relative to the bundle root, so a Python interpreter works
with **zero host changes**. On launch the host:

1. Allocates a free loopback port and injects it as **`OD_PORT`** (+ `OD_BIND_HOST=127.0.0.1`).
2. Injects **`OD_DATA_DIR`** — a writable per-app dir (the install tree is read-only).
3. Spawns `service.command service.args` with `workingDir` = bundle root.
4. Polls `http://127.0.0.1:$OD_PORT$healthPath` until 2xx/3xx or `readyTimeoutMs`.
5. Opens the webview at the service's URL (same-origin SPA + API).

### Auth — the loopback broker (`desktop_core/src/broker.rs`)

A bundled app **never sees the user's long-lived token**. Instead the host injects:

- `UNIFIED_BROKER_URL`, `UNIFIED_BROKER_TOKEN`, `UNIFIED_APP_SLUG`

The app `POST`s `${UNIFIED_BROKER_URL}/token` with header `x-broker-token` and body
`{"app_slug": "<slug>"}` and receives `{ token, expires_in }` — a short-lived,
app-scoped JWT (signed by base-api, trusted by unified-api). It uses that as the
`Authorization: Bearer` for the OpenAI-compatible gateway at
`https://api.unifiedai.app/api/v1` (`/chat/completions`, `/models`, …). This is
exactly what OpenDesign's `apps/daemon/src/unified-auth.ts` does; `launch.py` is the
Python equivalent (~30 lines).

## What was added/changed in this repo to fit the model

| File | Change |
|------|--------|
| `launch.py` (new) | Service entrypoint: maps `OD_PORT`/`OD_BIND_HOST` → uvicorn, mints the broker token, points the LLM client at the Unified gateway, refreshes the token before expiry, then runs `api_server.serve_main`. |
| `build-bundle.sh` (new) | Embeds relocatable CPython (python-build-standalone), pip-installs deps into it, builds the frontend, stages the tree, writes `manifest.json`, normalizes symlinks, zips, copies to `/tmp` for Local installs. |
| `normalize-symlinks.mjs` (new) | Clamps any symlink whose target escapes the bundle root (the installer rejects the whole archive otherwise). Copied from OpenDesign. |
| `agent/src/providers/llm_providers.json` | Added a first-class **`unifiedai`** provider (`base_url_env: UNIFIED_API_BASE_URL`, `api_key_env: UNIFIED_API_KEY`, default `https://api.unifiedai.app/api/v1`). |
| `agent/src/providers/llm.py` | Added `unifiedai` to `_PROVIDER_MAP` so `build_llm()` resolves its env at call time. |
| `agent/api_server.py` | `RUNS_DIR`/`SESSIONS_DIR`/`UPLOADS_DIR`/`ENV_PATH`/swarm dir now honor `VIBE_TRADING_DATA_DIR`; frontend dist honors `VIBE_TRADING_FRONTEND_DIST`. Defaults unchanged for a plain checkout. |
| `agent/src/swarm/store.py` | `swarm_runs_root()` honors `VIBE_TRADING_DATA_DIR` (keeps the store + path allow-list in sync on a read-only root). |
| `apps/desktop/src/data/apps.js` (UnifiedApp) | Registered the `vibe-trading` marketplace entry. |
| `apps/desktop/public/apps/vibe-trading.png` (UnifiedApp) | App icon. |

### Seamless ("managed") experience

When the desktop host launches us, `launch.py` sets **`VIBE_TRADING_MANAGED=1`**
alongside the broker token. In that mode the app behaves like OpenDesign —
**zero config, no API keys, no provider picker**:

| File | Change |
|------|--------|
| `launch.py` | Sets `VIBE_TRADING_MANAGED=1` so the app/UI knows it's host-managed. |
| `agent/api_server.py` | `_is_managed()` + `_effective_settings_values()`: `GET /settings/llm` reflects the **live broker-injected** provider/model/key (process env wins over the saved `.env`, managed-only so plain checkouts stay file-hermetic). `LLMSettingsResponse` gains `managed` + `managed_label`. `PUT /settings/llm` pins provider/model/base and refuses to clear the injected token when managed (server-side backstop). |
| `agent/src/providers/llm.py` | `.env` search also looks in `VIBE_TRADING_DATA_DIR` first, so in-app saved settings (e.g. Tushare token, generation params) actually load from the writable data dir in a bundle. |
| `frontend/src/lib/api.ts` | `LLMSettings` gains `managed` / `managed_label`. |
| `frontend/src/pages/Settings.tsx` | When `managed`, the **Connection** card becomes a read-only "Powered by your Unified subscription" panel (provider + `auto` model, no provider dropdown / model / base-URL / API-key inputs) and the remote-deploy "Local API access" (server key) card is hidden. Generation + data-source settings stay editable. |

The user installs Vibe-Trading, it spawns, mints a broker token, and lands
directly in a working app on their Unified subscription — they never see a model
key or a provider chooser. Outside UnifiedApp (plain checkout / web deploy) the
full provider/key settings UI is unchanged. Covered by regression tests in
`agent/tests/test_settings_api.py` (managed reflect, unmanaged hermetic, PUT
token-clobber backstop).

These data-dir/env seams are **backwards-compatible**: with `VIBE_TRADING_DATA_DIR`
unset, every path resolves exactly as before, so a normal source checkout / Docker run
is unaffected.

## Build

```bash
# from this repo root (requires: bash, curl, node/npm, python toolchain to pip-install)
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh
```

Produces `./vibe-trading-bundle-darwin-arm64.zip`, prints its `sha256` + `sizeBytes`,
and copies it to `/tmp/vibe-trading-bundle-darwin-arm64.zip` (the Local-install path).

> The build must run **on the target platform** (native wheels for numpy/scipy/pandas/
> scikit-learn/duckdb/etc. are platform-specific and cannot be rebuilt on the user's
> machine). Bump `PBS_RELEASE`/`PY_VERSION` in `build-bundle.sh` to the latest
> python-build-standalone `install_only` asset for your platform if the pinned one 404s.

## Install + test locally

1. `./build-bundle.sh` (writes `/tmp/vibe-trading-bundle-darwin-arm64.zip`).
2. In the UnifiedApp desktop, enable the **"Use local bundles"** dev toggle (so the
   installer reads `localUrl` and skips sha256).
3. Install **Vibe-Trading** from the marketplace. Verify: the installer extracts with
   no symlink/path rejection; the service spawns on `OD_PORT`; `/health` returns 200
   within `readyTimeoutMs`; the SPA loads; an agent run routes a chat call through the
   broker token to unified-api.

## Publish path (optional)

1. Host the zip in a GitHub release; put the real `url`/`sha256`/`sizeBytes` in the
   `apps.js` entry (or add an idempotent `unified-db` migration to `public.apps` +
   `public.app_bundles` so base-api `GET /apps` serves it and `hydrateApps()` merges it
   by slug). **Note:** a DB row *replaces* the static `apps.js` entry by slug — keep
   `localUrl` and friends in sync if you maintain both.

## Known risks / follow-ups

- **Token lifetime.** The broker token is ~5 min; `launch.py` re-mints in a daemon
  thread and updates `os.environ`. `build_llm()` re-reads the key per call, so new agent
  runs pick up the refreshed token. A single very-long-running `ChatOpenAI` instance can
  still 401 mid-run — add a 401→re-mint→retry path if that surfaces.
- **Native wheels / bundle size.** Expect a large bundle (relocatable CPython + scientific
  wheels, likely 200–500 MB, in OpenClaw's range).
- **weasyprint** needs system cairo/pango at runtime; it's imported lazily, so PDF
  reports degrade to HTML-only if those libs are absent — not a startup blocker.
- **Model default.** `LANGCHAIN_MODEL_NAME` defaults to `auto` (gateway auto-routes);
  users can pick any Unified-catalog model in Settings → LLM.
- **`--dev`** spawns `npx vite` (needs Node at runtime) — never used by the bundle, which
  serves the prebuilt `frontend/dist` in prod static mode.
