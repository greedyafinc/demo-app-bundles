# Rowboat Desktop — UnifiedApp solo bundle

The full [Rowboat](https://github.com/rowboatlabs/rowboat) Electron app
(upstream `apps/x`, Apache-2.0) — the local-first "AI coworker" with knowledge
graph, Google/Composio/Slack integrations, voice, and scheduled tasks —
packaged as a **prebuilt standalone `Rowboat.app`** for the UnifiedApp
marketplace's solo-bundle channel, with **UnifiedAI integrated as a model
provider** (sign in with your UnifiedAI account via `@unifiedai/sdk`; no API
keys). See [BUNDLING.md](BUNDLING.md) for the design and the full change list.

- **Upstream**: `rowboatlabs/rowboat` @ `e2178c14` (subtree `apps/x`; see [.upstream-sha](.upstream-sha))
- **Bundle version**: `0.1.0` (upstream `apps/main` package version)
- **Latest release**: _pending_ (`rowboat-desktop-v0.1.0`)
- **Artifact**: `rowboat-desktop-bundle-darwin-arm64.zip` (`Rowboat.app` at archive root)

## Build

```bash
./build-bundle.sh
```

Build deps: macOS (darwin-arm64), `pnpm`, and **`bun` on PATH** (the
`@unifiedai/sdk` git dependency builds itself with bun in its `prepare`
script). Export `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` for a signed +
notarized build; without them the `.app` is ad-hoc signed (fine for the
marketplace channel, which strips quarantine on install).

## Release

```bash
gh release create rowboat-desktop-v0.1.0 rowboat-desktop-bundle-darwin-arm64.zip --repo greedyafinc/demo-app-bundles
```

then update the `soloBundle` sha256/sizeBytes on the `rowboat` entry in
UnifiedApp `apps/desktop/src/data/apps.js` (and/or the unified-db
`app_solo_bundles` row).
