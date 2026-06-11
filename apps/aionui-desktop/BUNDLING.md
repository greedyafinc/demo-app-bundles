# AionUi — UnifiedApp solo-bundle design

How upstream [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi) (Apache-2.0)
is packaged as a prebuilt `AionUi.app` for the UnifiedApp marketplace, with
**UnifiedAI integrated as a sign-in model provider** (no API keys).

## Why a loopback proxy (the core design decision)

AionUi's LLM calls are **not** made by code in this repo: chats execute inside
`aioncore`, a pre-compiled backend binary downloaded at build time from
`iOfficeAI/AionCore` releases (pinned by `aioncoreVersion` in `package.json`).
Providers reach it as plain rows: `platform` + `base_url` + a **static**
`api_key`. There is no seam to inject a refreshing OAuth token into the binary.

So the UnifiedAI integration registers an ordinary OpenAI-compatible provider —

```
base_url = http://127.0.0.1:25141/v1      api_key = <local proxy secret>
```

— and the Electron **main process** (our code) runs a loopback proxy behind
that URL (`packages/desktop/src/process/unified/proxy.ts`). Per request it:

1. validates the local secret (timing-safe; persisted 0600 under
   `<userData>/unified/proxy-secret` so provider rows survive restarts),
2. swaps in a fresh OAuth access token from `@unifiedai/sdk` (401 → one
   refresh-and-retry),
3. forwards to the gateway's `/api/v1/*` (SSE streams pass through).

Everything downstream works unmodified: aioncore's chat calls, its
`fetch-models` probe (`GET {base_url}/models` → the gateway's OpenAI-compatible
catalog), protocol detection, and the in-process image-gen OpenAI clients.
Real tokens never leave the main process; the persisted provider config only
holds the loopback secret, useless off-machine. Port: `25141`
(`AIONUI_UNIFIED_PROXY_PORT` overrides).

## Auth (`packages/desktop/src/process/unified/auth.ts`)

`@unifiedai/sdk/node` OAuth: keychain cache → handoff from a running
UnifiedApp desktop → browser PKCE. Client id `aionui-desktop`
(`oauth_clients` row in unified-db; `UNIFIED_CLIENT_ID` overrides). Token
storage is a file-backed `KeychainAdapter` (0600 JSON at
`<userData>/unified/tokens.json`) because the SDK's default OS-keychain
adapter needs `@napi-rs/keyring`, a native module the bundled main process
doesn't ship (the SDK is bundled inline; the keyring import is lazy, marked
rollup-external, and never executes).

Local-dev endpoint derivation (same as rowboat-desktop): when the gateway is
loopback (default `http://localhost:3141`), authorize/token URLs are derived
as `http://localhost:9000/oauth/authorize` (web client) and
`{gateway}/oauth/token` instead of the SDK's production defaults.
`UNIFIED_API_URL`, `UNIFIEDAI_WEB_BASE`, `UNIFIEDAI_AUTHORIZE_URL`,
`UNIFIEDAI_TOKEN_URL` env always win.

## Changes layered on upstream (pinned @ `.upstream-sha`)

- `packages/desktop/src/process/unified/` — **new**: SDK auth + loopback proxy.
- `packages/desktop/src/process/bridge/unifiedBridge.ts` — **new**: IPC
  providers `unified:{status,sign-in,sign-out}`; starts the proxy eagerly at
  bridge init (persisted providers may call it as soon as aioncore is up).
  Registered in `bridge/index.ts`.
- `packages/desktop/src/common/adapter/ipcBridge.ts` — `unified` namespace
  (stays IPC, not the HTTP bridge: main owns the OAuth session).
- `packages/desktop/src/common/types/provider/unifiedTypes.ts` — **new**:
  `UnifiedStatus` shape shared renderer↔main.
- `packages/desktop/src/renderer/utils/model/modelPlatforms.ts` — `UnifiedAI`
  platform entry (value `unified`, `platform: 'custom'` since it speaks
  OpenAI end-to-end; inline data-URI logo) + `isUnifiedOption()`.
- `packages/desktop/src/renderer/pages/settings/components/AddPlatformModal.tsx`
  — UnifiedAI panel: "Sign in with UnifiedAI" button (PKCE via IPC), hides the
  base_url/api_key inputs and fills them from the main process after sign-in,
  suppresses protocol detection, clears the loopback values when switching
  platforms, guards submit/model-fetch until signed in.
- `packages/desktop/src/renderer/services/i18n/locales/*/settings.json` —
  `unified*` keys in all 9 locales (zh translated, others English).
- `packages/desktop/src/process/services/autoUpdaterService.ts` — **updater
  hard-gated**: electron-updater points at the upstream iOfficeAI/AionUi
  feed, so any check/download from this modified build would replace it with
  stock AionUi. All checks no-op unless `AIONUI_ENABLE_AUTO_UPDATE=1`.
- `packages/desktop/electron.vite.config.ts` — bundle `@unifiedai/sdk` inline
  in main; `@napi-rs/keyring` external.
- `package.json` — `@unifiedai/sdk` git dependency.
- Vendor exclusions: `mobile/`, `docs/`, `examples/`, `.github/`, `homebrew/`,
  README demo media in `resources/` (~470 MB of GIF/MP4).

## Packaging

`./build-bundle.sh` → `bun install` → `i18n:types` → upstream's
`scripts/build-with-builder.js` with `--dir` (electron-vite build, MCP-server
re-bundle, aioncore download/stage, electron-builder unpacked .app) → `ditto`
zip with `AionUi.app` at archive root. Without `APPLE_ID`,
`CSC_IDENTITY_AUTO_DISCOVERY=false` keeps Electron's ad-hoc signatures.

## Deferred / follow-ups

- Notarized builds (`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`).
- Windows/Linux bundles (upstream supports both; marketplace is darwin-arm64).
- A marketplace-channel update feed (updater is disabled, see above).
- Sign-out / account display in Settings (sign-in lives in the add-provider
  modal; sign-out = remove `<userData>/unified/tokens.json` or the provider).
