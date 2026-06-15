# Grist Desktop (UnifiedApp solo bundle)

[Grist](https://www.getgrist.com/) is an open-source spreadsheet-database hybrid:
relational tables with spreadsheet-style formulas, views, and a built-in AI
Assistant. This bundle packages the official Electron desktop app
([gristlabs/grist-desktop](https://github.com/gristlabs/grist-desktop), which
embeds [grist-core](https://github.com/gristlabs/grist-core), both Apache-2.0) as
a standalone `Grist Desktop.app` for the UnifiedApp marketplace, with **Grist's
AI Assistant powered by your Unified subscription** — no API keys, no second
login.

- **kind:** `solo` (prebuilt `.app`, installed to `/Applications`)
- **upstream:** grist-desktop `v0.3.12` (see [`.upstream-sha`](.upstream-sha))
- **UnifiedAI:** the AI Assistant is routed through the gateway via a loopback
  OAuth proxy in the Electron main process — see [`BUNDLING.md`](BUNDLING.md).
- **docs are local:** all your documents stay in SQLite on your machine.

## Build

```bash
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh
```

Needs macOS arm64, Node 22, `bun`, `git`, `make`, and network access. The script
fetches the pinned grist-core, builds, packages an ad-hoc-signed `.app` (export
`APPLE_ID`/`APPLE_ID_PASSWORD`/`APPLE_TEAM_ID` to sign + notarize), zips it, and
prints the `sha256` + `sizeBytes` for the marketplace registration. See
[`BUNDLING.md`](BUNDLING.md) for the design, the layered changes, and known
build risks.

## Release

```bash
gh release upload grist-desktop-v0.3.12 grist-desktop-bundle-darwin-arm64.zip \
  --repo greedyafinc/demo-app-bundles
```

Then update Grist's `soloBundle` `sha256` + `sizeBytes` in UnifiedApp
`apps/desktop/src/data/apps.js`.
