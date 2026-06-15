# Grist Desktop — UnifiedApp solo-bundle design

How upstream [gristlabs/grist-desktop](https://github.com/gristlabs/grist-desktop)
(Apache-2.0), the Electron wrapper that embeds
[grist-core](https://github.com/gristlabs/grist-core), is packaged as a prebuilt
`Grist Desktop.app` for the UnifiedApp marketplace, with **Grist's AI Assistant
("Formula AI") routed through the UnifiedAI gateway** — no API keys, no second
login.

Pinned upstream: see [`.upstream-sha`](.upstream-sha) — grist-desktop `v0.3.12`
(`ed392da…`), grist-core submodule `586a286…`.

## Why a loopback proxy (the core design decision)

Grist's AI Assistant is configured by three env vars the **grist-core server**
reads (`https://support.getgrist.com/install/assistant/`):

| Purpose | Env var |
|---|---|
| OpenAI-compatible chat-completions URL (full path) | `ASSISTANT_CHAT_COMPLETION_ENDPOINT` |
| API key, sent as `Authorization: Bearer` | `ASSISTANT_API_KEY` |
| Model id (the `model` param; must support tool calls) | `ASSISTANT_MODEL` |

The server expects a **static** endpoint + key. UnifiedAI auth is OAuth with
short-lived, SDK-refreshed access tokens — the same impedance mismatch as the
AionUi bundle. So we point the assistant at a loopback proxy:

```
ASSISTANT_CHAT_COMPLETION_ENDPOINT = http://127.0.0.1:<port>/v1/chat/completions
ASSISTANT_API_KEY                  = <per-launch loopback secret>
ASSISTANT_MODEL                    = gpt-5.4   (UNIFIED_DEFAULT_MODEL / ASSISTANT_MODEL override)
```

The Electron **main process** runs that proxy
([`ext/app/electron/unified/proxy.ts`](ext/app/electron/unified/proxy.ts)). Per
request it:

1. validates the loopback secret (timing-safe),
2. acquires a session if needed (handoff from a running UnifiedApp is silent; a
   standalone launch falls back to a one-time browser PKCE sign-in),
3. swaps in a fresh OAuth access token from `@unifiedai/sdk` (401 → one
   refresh-and-retry),
4. forwards to the gateway's `/api/v1/*` (SSE streams pass through Node pipes).

Real tokens never leave the main process; only the loopback secret is ever
exposed to grist-core, and it is useless off-machine. Unlike the
persisted-provider apps, **Grist reads `ASSISTANT_*` fresh every launch**, so the
proxy binds an **ephemeral port** and mints a **random in-memory secret** each
launch — nothing is persisted (`GRIST_UNIFIED_PROXY_PORT` pins the port if
needed). Set `GRIST_UNIFIED_DISABLE=1` to opt out entirely and let upstream
`ASSISTANT_*`/`OPENAI_*` config apply.

Because grist-core runs **in-process** inside the Electron main, the integration
hooks in at exactly one place:
[`ext/app/electron/main.ts`](ext/app/electron/main.ts) calls `setupUnifiedAI()`
after `loadConfig()`/`setupLogging()` and **before** `GristApp.instance.run()`
boots the merged server — so the `ASSISTANT_*` vars are set when the server reads
them.

## Auth (`ext/app/electron/unified/auth.ts`)

`@unifiedai/sdk` node OAuth: keychain cache → handoff from a running UnifiedApp
desktop → browser PKCE. Client id `grist-desktop` (an `oauth_clients` row in
unified-db; `UNIFIED_CLIENT_ID` overrides). Token storage is a file-backed
`KeychainAdapter` (0600 JSON at `<userData>/unified/tokens.json`) because the
SDK's default OS-keychain adapter needs `@napi-rs/keyring`, a native module the
build does not ship.

Local-dev endpoint derivation (same as the other desktop bundles): when the
gateway is loopback (default `http://localhost:3141`), authorize/token URLs are
derived as `http://localhost:9000/oauth/authorize` (web client) and
`{gateway}/oauth/token` instead of the SDK's production defaults.
`UNIFIED_API_URL`, `UNIFIEDAI_WEB_BASE`, `UNIFIEDAI_AUTHORIZE_URL`,
`UNIFIEDAI_TOKEN_URL` env always win. Sign in/out is also exposed under
**Help → Sign in / Sign out of UnifiedAI** in the app menu.

### The `_sdk` shim (`ext/app/electron/unified/_sdk.d.ts` + built `_sdk.js`)

grist-core compiles with classic `moduleResolution: node` and emits **CommonJS**,
while `@unifiedai/sdk` is **ESM exposed only through a package.json `"exports"`
map** (no physical `node/` subpath). Classic node resolution ignores `"exports"`,
and a CJS `require()` of the SDK's ESM build fails at runtime. So the unified
module imports a local `./_sdk`:

- compile time → `_sdk.d.ts` (a hand-written minimal type surface; keep in sync
  with the SDK's node entry if the consumed surface grows),
- runtime → `_sdk.js`, a standalone CommonJS bundle of the SDK's node entry that
  `build-bundle.sh` produces with esbuild **after** `tsc`, written directly into
  `core/_build/ext/app/electron/unified/`.

## Changes layered on upstream (pinned @ `.upstream-sha`)

- `ext/app/electron/unified/` — **new**: SDK auth + loopback proxy + the
  `setupUnifiedAI()` entry + the `_sdk` shim.
- `ext/app/electron/main.ts` — call `await setupUnifiedAI()` before the server
  boots (3-line diff: one import, one call).
- `ext/app/electron/AppMenu.js` — Help-menu "Sign in / Sign out of UnifiedAI".
- `ext/package.json` — `@unifiedai/sdk` git dependency.
- Vendor exclusions vs upstream: `core/` (the grist-core submodule — fetched at
  build time, not committed) and `metadata/screenshots-linux/` (Linux-flatpak
  store art, unused for the darwin build).

Everything else is byte-for-byte upstream `v0.3.12`.

## Auto-update is off by default (do not enable)

grist-desktop bundles `electron-updater` pointed at gristlabs releases. Left
enabled it would replace this modified build with stock Grist. It is **inert by
default**: `UpdateManager` is constructed but never calls `startAutoCheck()` /
`schedulePeriodicChecks()`, and the "Check for Updates" menu only appears when
`GRIST_DESKTOP_USE_UPDATE === 'true'` — captured at module load, before
`loadConfig()` applies its default, so a Finder/`open -a`-launched `.app` (no
inherited shell env) shows no update UI and never checks. **Do not set
`GRIST_DESKTOP_USE_UPDATE=true`** for this build.

## Packaging

```bash
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh
```

→ fetch grist-core @ pin → `yarn install` → build `@unifiedai/sdk` →
`yarn run setup` (Pyodide sandbox + self-contained Python) → `yarn run build`
(tsc → `core/_build`, resolve-tspaths) → esbuild the SDK node entry to
`_build/ext/app/electron/unified/_sdk.js` → `electron-builder --mac --arm64
--dir` → `ditto` zip with `Grist Desktop.app` at archive root. Without
`APPLE_ID`, `CSC_IDENTITY_AUTO_DISCOVERY=false` keeps Electron's ad-hoc
signatures (notarize hook no-ops). Build needs Node 22 + `bun` on PATH; it is
slow and platform-specific (native modules, CPython, Pyodide).

## Known build risks to validate (release not yet cut)

- **tsc compile of the unified module.** It is written for grist-core's
  `target: es2017`, `strict`, `noUnusedLocals`, `types: []`, classic-node config
  (no global `fetch`/DOM types — the proxy uses node `http`/`https`). Confirm
  `yarn run build` is clean.
- **SDK build/install.** The `@unifiedai/sdk` git-dep prepare builds with `bun`;
  `build-bundle.sh` rebuilds it if `dist/node` is missing.
- **Single-org / no-login.** Default `GRIST_DESKTOP_AUTH=strict` auto-logs in a
  local default user (no outbound network from Grist itself); the assistant's
  only outbound call is the proxy → gateway. `mixed`/`none` are available.

## Deferred / follow-ups

- Notarized builds (`APPLE_ID`/`APPLE_ID_PASSWORD`/`APPLE_TEAM_ID`).
- Windows/Linux bundles (upstream supports both; marketplace is darwin-arm64).
- Seed the `grist-desktop` `oauth_clients` row in unified-db (PKCE, loopback
  redirect) before first sign-in.
- Cut the `grist-desktop-v0.3.12` release and fill `sha256`/`sizeBytes` in
  UnifiedApp `apps/desktop/src/data/apps.js`.
