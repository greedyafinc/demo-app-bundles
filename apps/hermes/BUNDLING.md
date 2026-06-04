# Bundling Hermes Web UI for the UnifiedApp marketplace

This repo has been prepped to ship as a UnifiedApp **marketplace bundle**, the same
way OpenDesign, OpenClaw and Vibe-Trading do. This document explains the model, what
was added, and how to build + install it.

## How UnifiedApp marketplace apps work (the OpenDesign model)

A marketplace app is a **self-contained zip** the desktop downloads, verifies
(sha256), extracts, and runs. Apps declare a `kind`:

- `web` — static SPA served via a custom protocol.
- `node-service` — a **local service** the desktop spawns, health-checks, and proxies
  a webview to. OpenDesign, OpenClaw, Vibe-Trading — and now Hermes Web UI — are this kind.

A `node-service` bundle for Hermes is just:

```
manifest.json          ← kind + how to start the service
launch.py              ← service entrypoint (ours: OD_* → HERMES_WEBUI_* + broker auth + agent wiring)
runtime/python/...      ← embedded, relocatable CPython + WebUI deps + agent deps (no system Python)
server.py  api/  static/  ← the Hermes WebUI app, copied as-is (no build step)
hermes-agent/          ← (fat bundle, default) the NousResearch/hermes-agent checkout
api/_version.py        ← baked version (the bundle has no .git for `git describe`)
index.html             ← placeholder for older hosts
```

By **default** `build-bundle.sh` produces the **fat bundle** (UI **+** Hermes Agent), so
chat works on install. Set `INCLUDE_AGENT=0` to build the lean UI-only bundle (then chat
needs an externally-installed agent via `HERMES_WEBUI_AGENT_DIR`).

### Spawn + lifecycle (Rust `desktop_core/src/service.rs`)

`kind: "node-service"` is a **lifecycle category, not a runtime lock** — `service.command`
is run as a generic, containment-guarded executable relative to the bundle root, so an
embedded **Python** interpreter works with **zero host changes** (verified against
`service.rs`: the host does `Command::new(bundle_root.join(command))`, never assuming
Node). On launch the host:

1. Allocates a free loopback port and injects it as **`OD_PORT`** (+ `OD_BIND_HOST=127.0.0.1`).
2. Injects **`OD_DATA_DIR`** — a writable per-app dir (the install tree is read-only).
3. Spawns `service.command service.args` with `workingDir` = bundle root.
4. Polls `http://127.0.0.1:$OD_PORT$healthPath` until 2xx/3xx or `readyTimeoutMs`.
5. Opens the webview at the service's URL (same-origin UI + API).

Hermes reads `HERMES_WEBUI_PORT` / `HERMES_WEBUI_HOST` / `HERMES_WEBUI_STATE_DIR`, not the
`OD_*` names, so **`launch.py` bridges them** (and points state at `OD_DATA_DIR/webui`).
The readiness probe uses **`/health`**, which returns 200 on a fresh boot from the
streams-lock heartbeat alone — it does **not** require a Hermes Agent (only
`/health?deep=1` probes agent/state, and even that treats a missing agent as healthy).

### Auth — the loopback broker (`desktop_core/src/broker.rs`)

A bundled app **never sees the user's long-lived token**. Instead the host injects:

- `UNIFIED_BROKER_URL`, `UNIFIED_BROKER_TOKEN`, `UNIFIED_APP_SLUG`

The app `POST`s `${UNIFIED_BROKER_URL}/token` with header `x-broker-token` and body
`{"app_slug": "hermes"}` and receives `{ token, expires_in }` — a short-lived,
app-scoped JWT (signed by base-api, accepted by unified-api as `internal_jwt` via its
JWKS). `launch.py` exports it as `UNIFIED_API_KEY` (+ `OPENAI_*` aliases).

### Seamless chat — the `custom:unified` provider (OpenDesign parity)

To make the bundled agent **chat with zero setup**, `launch.py` (only inside UnifiedApp,
once a token is minted) seeds `HERMES_HOME/config.yaml`:

```yaml
custom_providers:
  - name: Unified
    base_url: "http://localhost:3141/api/v1"        # the dev gateway; UNIFIED_API_URL override
    api_key: "${UNIFIED_API_KEY}"                   # rotating broker token, read per request
    api_mode: chat_completions
    models: [gpt-5.4]
model:
  provider: custom:unified
  default: gpt-5.4                                   # UNIFIED_DEFAULT_MODEL override
  base_url: "http://localhost:3141/api/v1"
  api_key: "${UNIFIED_API_KEY}"
  api_mode: chat_completions
```

> **Gateway URL — the "stuck on loading" gotcha.** The base must point at the gateway the
> desktop actually runs. The desktop injects the broker URL but **not** the gateway URL, so
> apps default it: OpenDesign's daemon uses `process.env.UNIFIED_API_URL || 'http://localhost:3141'`,
> and `launch.py` matches (`DEFAULT_UNIFIED_API_HOST = http://localhost:3141`). Pointing at an
> unreachable gateway (e.g. a prod URL in a dev shell) makes the WebUI's `/api/models` +
> `/api/onboarding/status` probes hang on a cold cache and the loader never clears. The seed
> carries a `unified-managed-gateway` sentinel so `launch.py` **self-heals a stale base_url**
> on the next launch (without touching a user-customised config or their model choice). For a
> non-dev gateway, set `UNIFIED_API_URL` (ideally injected by the desktop for all apps).

Why a **custom provider** rather than the built-in `openai-api`:
- Custom providers default to the `openai_chat` transport (`hermes_cli/providers.py`), and we
  pin `api_mode: chat_completions` so the agent ALWAYS `POST`s `{base}/chat/completions` — the
  **same** OpenAI-compatible endpoint OpenDesign uses, and the one unified-api's catalog +
  auto-router serve. (`openai-api`'s `codex_responses` transport hits `/responses`, which on
  unified-api is thinner — `GET /responses/:id` is 501; chat/completions is battle-tested.)
- `api_key` accepts the `${ENV}` form (`api/config.py:resolve_custom_provider_connection`), so
  the **rotating** token is read fresh from `UNIFIED_API_KEY` on every request — the
  `launch.py` refresh loop just keeps that env var current; the file never changes.
- The default model is a **concrete** catalog id (`UNIFIED_DEFAULT_MODEL`, default `gpt-5.4`),
  not `auto`: hermes resolves model capabilities from the id, and unified-api's `auto` is
  currently a fixed stub. Users can switch models in-app (list populated from the gateway).

`launch.py` also sets `HERMES_WEBUI_SKIP_ONBOARDING=1` (an operator override honored
unconditionally in `api/onboarding.py`) so the first-run wizard never blocks. Net effect,
verified by smoke test: `/api/onboarding/status` → `completed: true`,
`resolve_custom_provider_connection('custom:unified')` → `(token, gateway_base_url)`.
Standalone (no broker) installs skip this seed and fall through to normal onboarding.

> **Hermes Web UI makes no model calls itself** — it is a thin UI over a *separate* Hermes
> Agent (`run_agent.py`), imported **in-process** (`api/streaming.py`: `from run_agent import
> AIAgent`), which is where the LLM client lives. The **fat bundle co-ships that agent**
> (NousResearch/hermes-agent, MIT, ~v0.15.1) and installs its runtime deps — `openai`,
> `pydantic`, `httpx`, `fastapi`/`uvicorn` (a *hosted-model* agent; no torch/transformers)
> — into the same embedded interpreter. `launch.py` sets `HERMES_WEBUI_AGENT_DIR` to the
> bundled checkout, sandboxes `HERMES_HOME` under the writable data dir, and seeds a
> `config.yaml` selecting provider `openai-api`, whose creds come from the broker-token
> `OPENAI_BASE_URL`/`OPENAI_API_KEY`. The agent's `openai-api` transport is `codex_responses`,
> which targets the gateway's `/api/v1/responses` surface. The lean UI-only bundle
> (`INCLUDE_AGENT=0`) still installs and serves `/health`, but chat needs an external agent.

## What was added in this repo to fit the model

| File | Change |
|------|--------|
| `launch.py` (new) | Service entrypoint: maps `OD_PORT`/`OD_BIND_HOST` → `HERMES_WEBUI_*`, sandboxes WebUI state under `OD_DATA_DIR/webui`; if the agent is co-bundled, sets `HERMES_WEBUI_AGENT_DIR` + `HERMES_HOME` and seeds `config.yaml` (provider `openai-api`); mints the broker token and exports `OPENAI_BASE_URL`/`OPENAI_API_KEY` (refreshed before expiry), then runs `server.main()`. |
| `build-bundle.sh` (new) | Embeds relocatable CPython, pip-installs `requirements.txt` into it; **(default) clones NousResearch/hermes-agent, installs its runtime deps into the same interpreter, and stages the agent source under `hermes-agent/`** (`INCLUDE_AGENT=0` skips this); stages `server.py`+`api/`+`static/`, bakes `api/_version.py`, writes `manifest.json` (`readyTimeoutMs` 90s), normalizes symlinks, zips. **No frontend build** — Hermes WebUI is vanilla JS. |
| `normalize-symlinks.mjs` (new) | Clamps any symlink whose target escapes the bundle root (the installer rejects the whole archive otherwise). Copied from OpenDesign. |
| `apps/desktop/src/data/apps.js` (UnifiedApp) | Registered the `hermes` marketplace entry (kind `node-service`). |
| `apps/desktop/public/apps/hermes.svg` + `apps/web/public/apps/hermes.svg` (UnifiedApp) | App icon (from `static/favicon-512.svg`). |

| `api/helpers.py` (one-line gate) | The desktop marketplace renders apps in a **loopback iframe** (`AppHost.vue`), but `_security_headers()` sent `X-Frame-Options: DENY` on every response → the browser refused the embed ("Refused to display … X-Frame-Options to DENY"). Gated that header behind `HERMES_WEBUI_ALLOW_FRAMING` (which `launch.py` sets); **default unchanged** (still `DENY` for a direct/SSH-exposed run). |
| `static/vendor/unified-sdk.js` (new) | Vendored uni-sdk browser ESM (`UnifiedAI` + `getModelLogo`/`getProviderLogo`), built from the sibling uni-sdk repo by `build-bundle.sh` (best-effort; committed copy is the fallback). Loaded via a `<script type="module">` shim in `index.html` → `window.UnifiedSDK`. |
| `static/index.html`, `static/ui.js`, `static/style.css` | **Model picker redesign**: unified-api is the sole provider, so the picker is a flat model list (no provider grouping/selection) sourced from `UnifiedAI.models.list({include:['author']})` (same-origin passthrough below; plain-fetch fallback), each row + the composer chip rendered with the model's brand logo via `getModelLogo`. |
| `api/routes.py` (`/api/v1/models`) | Same-origin passthrough proxying the gateway's OpenAI-compatible `/api/v1/models?include=author` (server-side, token-injected), so the browser picker can list the catalog under the enforced `connect-src 'self'` CSP. |

**Hermes's source is unchanged except one backward-compatible, env-gated line** in
`api/helpers.py` (above) — required because the WebUI exposes no knob to allow framing, and
the desktop must embed it in an iframe. Everything else rides existing env seams
(`HERMES_WEBUI_PORT`/`HOST`/`STATE_DIR`, `NO_OPEN`, `HERMES_WEBUI_AUTO_INSTALL`,
`HERMES_WEBUI_SKIP_ONBOARDING`, `custom_providers`), so a normal checkout / Docker run with
`HERMES_WEBUI_ALLOW_FRAMING` unset behaves exactly like upstream.

## Build

```bash
# from this repo root (requires: bash, curl, git, node, and the embedded python to pip-install)
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh            # fat bundle (UI + agent) — default
INCLUDE_AGENT=0 NODE_PLATFORM=darwin-arm64 ./build-bundle.sh   # lean UI-only bundle
```

Produces `./hermes-webui-bundle-darwin-arm64.zip`, prints its `sha256` + `sizeBytes`, and
copies it to `/tmp/hermes-webui-bundle-darwin-arm64.zip` (the Local-install path).

> The build embeds a platform-specific CPython and installs platform wheels (pydantic-core,
> etc.), so run it **on the target platform** (or set `NODE_PLATFORM=` and bump
> `PBS_RELEASE`/`PY_VERSION` to a valid python-build-standalone `install_only` asset).
> Reference sizes (darwin-arm64): lean UI-only ≈ **33 MB**; fat (UI + agent) ≈ **80 MB**.

## Install + test locally

1. `./build-bundle.sh` (writes `/tmp/hermes-webui-bundle-darwin-arm64.zip`).
2. In the UnifiedApp desktop, enable the **"Use local bundles"** dev toggle (so the
   installer reads `localUrl` and skips sha256).
3. Install **Hermes Web UI** from the marketplace. Verify: the installer extracts with
   no symlink/path rejection; the service spawns on `OD_PORT`; `/health` returns 200
   within `readyTimeoutMs`; the three-panel UI loads; the startup log shows
   `agent dir : …/hermes-agent [ok]` and chat (once you pick a model from the
   gateway-populated list) routes through the broker token to unified-api.

## Publish path (optional)

1. Host the zip in a GitHub release; put the real `url`/`sha256`/`sizeBytes` into the
   `apps.js` entry (or add an idempotent `unified-db` migration to `public.apps` +
   `public.app_bundles` so base-api `GET /apps` serves it and `hydrateApps()` merges it
   by slug). **Note:** a DB row *replaces* the static `apps.js` entry by slug — keep
   `localUrl` and friends in sync if you maintain both. The `app_bundles` CHECK requires a
   NOT-NULL `url` and a 64-hex `sha256` for any non-`file://` URL.

## Known risks / follow-ups

- **Agent ↔ gateway is wired but not E2E-tested here.** The fat bundle co-ships the agent
  and the UI detects + imports it (`from run_agent import AIAgent` → ok); the gateway
  routing is wired via env + seeded config. A *real* chat needs the live broker +
  unified-api (only present inside a running UnifiedApp desktop), so it wasn't exercised in
  this prep. Confirm a model call end-to-end after installing in the desktop.
- **Model selection.** `config.yaml` seeds provider `openai-api` but leaves the model unset
  (the in-app picker is populated from the gateway's `/api/v1/models`). Hermes's stock
  defaults are GPT-5 / Claude-4 ids; pick whatever the Unified catalog serves. (Avoid
  pinning `auto` for the `responses` transport — `auto` is chat-surface only.)
- **Agent version pin.** `build-bundle.sh` shallow-clones `main` and records the SHA in
  `hermes-agent/.bundled-sha` (this build: `9fbfeb3`, v0.15.1). Set `AGENT_REPO`/re-clone to
  bump. Only the agent's *core* deps are installed; provider extras (`anthropic`, `exa`,
  `firecrawl`, voice/messaging) are lazy and absent — the gateway's OpenAI-compatible
  surface covers chat without them.
- **Token lifetime.** The broker token is ~5 min; `launch.py` re-mints in a daemon thread
  and updates `os.environ`, which the agent's provider re-reads per build. A single
  very-long-running provider instance could still 401 mid-run.
- **Auth off by default.** The WebUI binds loopback only (`HERMES_WEBUI_HOST=127.0.0.1`)
  and the desktop reaches it over loopback, so no password is set. Set
  `HERMES_WEBUI_PASSWORD` if you ever expose it off-loopback.
