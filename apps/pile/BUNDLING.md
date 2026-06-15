# Bundling Pile for the UnifiedApp marketplace

[Pile](https://github.com/UdaraJay/Pile) is an open-source (MIT) desktop
journaling app — an [Electron React Boilerplate](https://electron-react-boilerplate.js.org/)
app (Electron 33, webpack, electron-builder 24). Its standout feature is
**AI reflections**: an LLM responds to your journal entries to help you reflect,
plus an optional semantic vector index for "chat with your journal" search.

This directory vendors Pile's upstream source (pinned to
`234aa902f6a5b8b231b815501d5dac996feb8cdf`, the `v1.0.0` tag, see
[`.upstream-sha`](.upstream-sha)) with a small **UnifiedAI integration applied
in place**, plus the bundling layer that produces a standalone macOS `.app` for
the UnifiedApp `kind: 'solo'` channel.

Like the other Electron `.app`s (`grist-desktop`, `aionui-desktop`,
`rowboat-desktop`), it installs as a standalone `Pile.app` with its own Dock
icon. The user signs in once with their UnifiedAI account; every AI call routes
through the Unified gateway on their subscription — **no OpenAI API key, no
separate login.**

## How the UnifiedAI integration works

Pile builds its OpenAI client **in the renderer**
(`src/renderer/context/AIContext.js`) from three persisted settings: `baseUrl`
(an OpenAI-compatible base URL), the encrypted `aiKey` (sent as a Bearer token),
and `model`. It expects a *static* endpoint + key. UnifiedAI auth is OAuth with
short-lived, SDK-refreshed tokens, so — exactly like Grist Desktop — we insert a
**loopback gateway proxy** in the Electron main process and point Pile at it.

Integration module: [`src/main/unified/`](src/main/unified)

| File | Role |
|------|------|
| `auth.ts` | `@unifiedai/sdk/node` OAuth: keychain-cached tokens → handoff from a running UnifiedApp desktop → browser PKCE. Uses a **file-backed keychain** (`<userData>/unified/tokens.json`, `0600`) so the native `@napi-rs/keyring` is never loaded. Subclasses `UnifiedAI` to expose access/refresh tokens to the proxy. |
| `proxy.ts` | A `127.0.0.1` HTTP server (ephemeral port, or `PILE_UNIFIED_PROXY_PORT`). Validates the per-launch loopback secret, swaps in a fresh OAuth access token, and forwards `/v1/*` → the gateway's `/api/v1/*` (SSE streams pipe through). 401 → refresh-and-retry. Real tokens never leave the main process. |
| `index.ts` | `setupUnifiedAI()` — starts the proxy and pre-seeds Pile's settings: `baseUrl = http://127.0.0.1:<port>/v1`, `pileAIProvider = 'openai'`, `model = 'auto'` (only while still on the upstream default), and seeds the proxy secret as the `aiKey` so the renderer actually constructs its client. |

`setupUnifiedAI()` is awaited in `src/main/main.ts` inside `app.whenReady()`
**before** the window loads, so the renderer reads the seeded settings on first
paint. The semantic-index embeddings path
(`src/main/utils/pileEmbeddings.js`) was changed to read the same `baseUrl`
(it previously hard-coded `https://api.openai.com/v1/embeddings`), so it flows
through the proxy too.

### Changes applied on top of upstream

- **added** `src/main/unified/{auth,proxy,index}.ts` — the integration module.
- **edited** `src/main/main.ts` — `import { setupUnifiedAI }` + `await
  setupUnifiedAI()` before `createWindow()`.
- **edited** `src/main/utils/pileEmbeddings.js` — embeddings now use the
  configured `baseUrl` instead of a hard-coded OpenAI URL.
- **edited** `.erb/configs/webpack.config.base.ts` — mark `@napi-rs/keyring`
  (the SDK's only native dep) external; we supply a file keychain so it is never
  loaded.
- **edited** `package.json` — add `"@unifiedai/sdk": "github:greedyafinc/uni-sdk"`;
  set `build.appId` to `com.greedyafinc.pile` (a stable marketplace identity
  that won't collide with a user's own Pile install); rewrite the legacy
  `devEngines` (`{node, npm}` string form) to npm's current
  `{runtime, packageManager}` object schema with `onFail: warn` — npm 10/11
  reject the old form (`Invalid property "devEngines.node"`).

### Upstream-compat build notes

- **`npm install --legacy-peer-deps`** (in `build-bundle.sh`) — upstream Pile
  pins `react@19` while its dev-only `@testing-library/react@14` peers
  `react@18`; npm's strict peer resolution otherwise `ERESOLVE`s. The conflict
  is test tooling only and unused by the build. (Pile ships a `pnpm-lock`; its
  maintainer uses pnpm, which is lenient here.)

Pile's `main` process is bundled by **webpack** (`target: electron-main`), which
honors the SDK's package `"exports"` map, so `@unifiedai/sdk/node` is imported
directly — no CommonJS shim is needed (unlike grist-core's classic-resolution
build). The only native dep, `@napi-rs/keyring`, is `import()`ed lazily inside
the SDK's default keychain factory, which we never call, so externalizing it is
safe.

### Escape hatch

Set `PILE_UNIFIED_DISABLE=1` to skip the integration entirely and use Pile's own
`baseUrl`/`aiKey` settings (bring-your-own OpenAI key). Other overrides:
`UNIFIED_API_URL` (gateway host), `UNIFIED_DEFAULT_MODEL`,
`PILE_UNIFIED_PROXY_PORT`, and the standard `UNIFIEDAI_*` OAuth endpoint vars.

## Building

```bash
cd apps/pile
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh
```

Requires macOS (`darwin-arm64`), Node 20+, `npm`, `bun` (on PATH — the SDK git
dep builds with bun), `npx`, `git`, `ditto`, and network access. The script
installs deps, ensures the SDK node entry is built, runs the webpack build,
packages `Pile.app` via `electron-builder --dir` (ad-hoc signed unless
`APPLE_ID`/`APPLE_ID_PASS`/`APPLE_TEAM_ID` are exported with `CI=true`), zips it
with `ditto`, and prints the `sha256` + `sizeBytes` for the registration block.

> **Verified build** (Node 22, bun 1.3.14, Electron 33.4.11, darwin-arm64,
> ad-hoc unsigned): `pile-bundle-darwin-arm64.zip` = **116,155,554 bytes**,
> sha256 `368aca0401a9fd3208066af853a584fdd5a8f0f9b7e377c470bda226188c1a20`.
> The full pipeline (npm install → SDK build → webpack main+renderer →
> electron-builder → ditto) runs green; `main.js` bundles `src/main/unified`
> with `@napi-rs/keyring` correctly externalized. electron-builder is not
> byte-reproducible, so the **release** asset's hash must come from the actual
> release build (don't paste the number above into `apps.js` for a remote
> install — re-hash the uploaded asset).

## Releasing

```bash
gh release upload pile-v1.0.0 pile-bundle-darwin-arm64.zip \
  --repo greedyafinc/demo-app-bundles
```

Then fill `sha256` + `sizeBytes` into the `pile` `soloBundle` entry in
UnifiedApp `apps/desktop/src/data/apps.js`, and seed the `pile-desktop` OAuth
client (`oauth_clients`) so the consent page shows Pile's name/icon. ("Local"
installs via the Marketplace toggle clear `sha256` automatically, so you can
test before cutting the release.)
