# Rowboat — UnifiedApp marketplace bundle

[RowboatX](https://github.com/rowboatlabs/rowboat) (Apache-2.0), the open-source
agent workspace from Rowboat Labs, packaged as a UnifiedApp `node-service`
marketplace bundle: the Hono agent server (`cli/`, upstream `apps/cli`) plus the
static-export Next.js dashboard (`ui/`, upstream `apps/rowboatx`), served
same-origin by one embedded-Node service. Chat authenticates through the
UnifiedApp loopback broker and routes through the Unified gateway via a new
`unified` model-provider flavor; the gateway model catalog is exposed through
`@unifiedai/sdk`. See [BUNDLING.md](BUNDLING.md) for the full design and the
list of changes layered on upstream.

- **Upstream**: `rowboatlabs/rowboat` @ `e2178c14` (see [.upstream-sha](.upstream-sha));
  subset vendor — `apps/cli` + `apps/rowboatx` only (the Electron `apps/x` and the
  legacy Mongo/Redis web stack are not bundled).
- **Bundle version**: `0.16.0` (upstream `apps/cli` package version)
- **Latest release**: _pending_ (`rowboat-v0.16.0`)
- **Artifact**: `rowboat-bundle-darwin-arm64.zip`

## Build

```bash
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh
```

Build deps: `bash`, `curl`, `git`, `zip`, `node`-independent (Node 24 is
downloaded + embedded), and **`bun` on PATH** (the `@unifiedai/sdk` git
dependency builds itself with bun in its `prepare` script).

The script prints the zip's `sha256` + `sizeBytes` for the `apps.js` /
`unified-db` registration.

## Release

```bash
gh release create rowboat-v0.16.0 rowboat-bundle-darwin-arm64.zip --repo greedyafinc/demo-app-bundles
```

then update `sha256` + `sizeBytes` in UnifiedApp `apps/desktop/src/data/apps.js`
(and/or the `unified-db` `apps`/`app_bundles` migration — a DB row replaces the
static entry by slug).
