# Pile (UnifiedApp marketplace bundle)

[Pile](https://github.com/UdaraJay/Pile) — an open-source (MIT) desktop journal
with **AI reflections** — packaged as a standalone macOS `.app` for the
UnifiedApp marketplace (`kind: 'solo'`), with its AI routed through the UnifiedAI
gateway on the user's subscription (no OpenAI API key, no separate login).

- **Upstream:** [UdaraJay/Pile](https://github.com/UdaraJay/Pile) — Electron
  React Boilerplate (Electron 33, webpack, electron-builder 24).
- **Pinned commit:** [`.upstream-sha`](.upstream-sha) →
  `234aa902f6a5b8b231b815501d5dac996feb8cdf` (tag `v1.0.0`).
- **Integration + build details:** [`BUNDLING.md`](BUNDLING.md).

This directory is upstream Pile source (pinned, with our UnifiedAI integration
applied in place under `src/main/unified/`) plus the bundling layer
(`build-bundle.sh`). Regenerable artifacts (`node_modules/`, `release/`, the
`.zip`) are git-ignored; the build script recreates them.

## Build

```bash
cd apps/pile
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh   # -> pile-bundle-darwin-arm64.zip
```

The script prints the output `.zip`'s `sha256` + `sizeBytes`; copy them into the
`pile` `soloBundle` entry in UnifiedApp `apps/desktop/src/data/apps.js` and
upload the asset to a `pile-v1.0.0` GitHub release. See [`BUNDLING.md`](BUNDLING.md).
