# Bundling the Rowboat desktop app (Electron) as a UnifiedApp solo bundle

This directory ships the **full Rowboat Electron app** — upstream `apps/x`, the
"local-first AI coworker" (knowledge graph, Gmail/Calendar/Composio/Slack
integrations, voice, scheduled & background tasks) — as a **prebuilt standalone
`.app`** installed through the UnifiedApp marketplace's solo-bundle path, with
the **UnifiedAI platform integrated as a first-class model provider**.

It is the sibling of [`apps/rowboat`](../rowboat) (the in-shell `node-service`
bundle of the lighter RowboatX agent server + dashboard). Same upstream repo
and pin (`e2178c14`, see [.upstream-sha](.upstream-sha)); different product
surface and delivery channel.

## How it differs from the node-service bundles

A `node-service` bundle runs inside the UnifiedApp shell and authenticates via
the host's loopback **broker**. This app is a real Electron `.app` launched
from /Applications — there is no broker. Auth therefore uses
`@unifiedai/sdk/node`'s standalone flow, in order:

1. cached session (file-backed keychain, see below),
2. token **handoff** from a running UnifiedApp desktop,
3. browser **PKCE** sign-in (system browser opens the platform consent page).

The user signs in once with their UnifiedAI account; refresh is SDK-managed.

- **OAuth client id**: `rowboat-desktop` (override `UNIFIED_CLIENT_ID`). A
  matching `oauth_clients` row must exist in unified-db for the PKCE flow.
- **Gateway**: `UNIFIED_API_URL` (default `http://localhost:3141`, dev parity
  with the other bundles); authorize/token endpoints come from uni-sdk's
  defaults (`UNIFIEDAI_AUTHORIZE_URL`/`UNIFIEDAI_TOKEN_URL` to override).
- **Token storage**: the SDK's default OS-keychain needs `@napi-rs/keyring`, a
  native module the esbuild-bundled main process can't ship (the Forge config
  packages no node_modules). We inject a file-backed `KeychainAdapter` (0600
  JSON at `$ROWBOAT_WORKDIR/config/unified-tokens.json`) — the same posture as
  upstream's own OAuth repo, which keeps Rowboat/Google tokens in plain JSON
  in the same directory.

## What was changed vs upstream (all in-place)

| File | Change |
|------|--------|
| `packages/core/src/unified/auth.ts` (new) | uni-sdk node client (subclass exposing the protected token hooks), file keychain, `unifiedFetch` (fresh bearer per request + one 401-refresh retry), sign-in/out + catalog helpers. |
| `packages/shared/src/models.ts` | `"unified"` in the `LlmProvider` flavor enum. |
| `packages/core/src/models/models.ts` | `unified` case in `createProvider` — `createOpenAICompatible` against `UNIFIED_API_URL/api/v1` with `unifiedFetch` (mirrors upstream's own `rowboat` gateway flavor, which also authenticates in the fetch layer). |
| `packages/shared/src/ipc.ts` + `apps/main/src/ipc.ts` | `unified:{status,signIn,signOut,models}` IPC channels (zod schemas + main handlers). |
| `apps/renderer` onboarding (`use-onboarding-state.ts`, `steps/llm-setup-step.tsx`, `provider-icons.tsx`) | "UnifiedAI — all models, one subscription" tile (first) in the BYOK path; a **Sign in with UnifiedAI** panel instead of an API-key field; gateway catalog populates the model dropdowns (preferred default `gpt-5.4`). |
| `apps/renderer/src/components/settings-dialog.tsx` | Same provider tile + sign-in panel in Settings → Models, so users can switch after onboarding. |
| `apps/main/src/main.ts` | **Auto-updater gated behind `ROWBOAT_UPDATE_REPO`.** The stock updater points at upstream `rowboatlabs/rowboat` and downloaded their release within seconds of first boot in testing — it would silently replace this build (and its UnifiedAI integration) on relaunch. |
| `apps/main/forge.config.cjs` | `osxSign`/`osxNotarize` only when `APPLE_ID` is set; otherwise an ad-hoc build (notarizing an ad-hoc signature fails the build). |
| `apps/main/bundle.mjs` | `@napi-rs/keyring` external (the SDK's lazy default keychain import; never executed at runtime). |
| `pnpm-workspace.yaml` | `@unifiedai/sdk` in `onlyBuiltDependencies` (pnpm 10 blocks its prepare script otherwise). |
| `packages/core/package.json` | `@unifiedai/sdk` git dependency. |

Upstream's own cloud path ("Sign in with Rowboat", their hosted gateway and
billing) is left intact — the BYOK rails this integration rides are first-class
upstream; nothing was removed.

## Build

```bash
./build-bundle.sh        # needs: pnpm, bun (uni-sdk git dep), macOS for the .app
```

pnpm-installs the nested workspace, builds shared → core → preload → renderer
→ main, packages `Rowboat.app` via electron-forge (ad-hoc signed without
`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`), and ditto-zips it with
`Rowboat.app` at the archive root — exactly the layout the desktop's
`install_solo_app` command expects (download → sha256 verify → extract →
move to /Applications → quarantine strip → register).

## Install path (UnifiedApp)

The `rowboat` marketplace card declares this artifact as its **soloBundle**
(`apps/desktop/src/data/apps.js`): a soloBundle with a `url` takes the
prebuilt-download branch in `stores/marketplace.js` (the UNI-48 v1
`install_solo_app` path) instead of on-device synthesis. Installing Rowboat
from the marketplace installs the in-shell workspace app AND places
`Rowboat.app` in /Applications. Dev: the "Use local bundles" toggle resolves
`localUrl` (`${DEMO_BUNDLES_DIR}/apps/rowboat-desktop/...`) and skips sha
verification.

## Verified / not verified

- ✅ Builds end-to-end; packaged `.app` boots (sandboxed `ROWBOAT_WORKDIR`):
  schedulers, knowledge-graph builder and sync services start; no update fetch.
- ✅ shared/core/preload/renderer compile with the integration; IPC schemas
  typecheck.
- ❌ Not yet verified E2E: the PKCE sign-in against a live base-api/unified-api
  (needs the `rowboat-desktop` oauth_clients row in unified-db) and a real
  chat through the gateway. Onboarding UI flow needs a by-hand pass.

## Follow-ups

- **unified-db migration**: seed `oauth_clients` with `rowboat-desktop`
  (loopback redirect URIs) so PKCE works outside dev.
- **Per-app icon**: the .app ships upstream's Rowboat icon; fine to keep.
- **Updates**: publish releases under a greedyafinc repo and set
  `ROWBOAT_UPDATE_REPO` at build time if auto-update is wanted.
- **Windows/Linux**: forge makers exist upstream; only darwin-arm64 is built.
