# AionUi — UnifiedApp solo bundle

The full [AionUi](https://github.com/iOfficeAI/AionUi) Electron app
(Apache-2.0) — the multi-agent AI workspace (Gemini CLI/ACP agents, MCP
tools, teams, image generation, file workspace) — packaged as a **prebuilt
standalone `AionUi.app`** for the UnifiedApp marketplace's solo-bundle
channel, with **UnifiedAI integrated as a model provider** (sign in with your
UnifiedAI account via `@unifiedai/sdk`; no API keys). See
[BUNDLING.md](BUNDLING.md) for the design and the full change list; the
upstream README is preserved as [README.upstream.md](README.upstream.md).

- **Upstream**: `iOfficeAI/AionUi` @ `0e26239` (see [.upstream-sha](.upstream-sha));
  lean vendor — `mobile/`, docs, and README demo media excluded
- **Backend**: `aioncore` binary from `iOfficeAI/AionCore` releases, pinned by
  `aioncoreVersion` in [package.json](package.json) (downloaded at build time)
- **Bundle version**: `2.1.17` (upstream package version)
- **Latest release**: _pending_ (`aionui-desktop-v2.1.17`)
- **Artifact**: `aionui-desktop-bundle-darwin-arm64.zip` (`AionUi.app` at archive root)

## Build

```bash
./build-bundle.sh
```

Build deps: macOS (darwin-arm64), `node`, and **`bun` on PATH** (workspace
install + the `@unifiedai/sdk` git dependency builds itself with bun in its
`prepare` script). Export `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` for a
signed build; without them the `.app` keeps Electron's ad-hoc signatures
(fine for the marketplace channel, which strips quarantine on install).

## Release

```bash
gh release create aionui-desktop-v2.1.17 aionui-desktop-bundle-darwin-arm64.zip --repo greedyafinc/demo-app-bundles
```

then update the `soloBundle` sha256/sizeBytes on the `aionui` entry in
UnifiedApp `apps/desktop/src/data/apps.js` (and/or the unified-db
`app_solo_bundles` row).

## Using the UnifiedAI provider

Settings → Models → Add model → platform **UnifiedAI** → **Sign in with
UnifiedAI** (opens the browser) → pick models from the gateway catalog.
Requires the `aionui-desktop` OAuth client row in unified-db and, for local
dev, the stack running (web :9000, base-api :3000, unified-api :3141).
