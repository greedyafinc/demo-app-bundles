# demo-app-bundles

Source, build tooling, and public download host for [UnifiedApp](https://github.com/greedyafinc/UnifiedApp)
marketplace bundles.

This repo plays two roles:

1. **Release host.** Built `.zip` bundles are published as GitHub **Releases** here and referenced by
   SHA256 from the desktop app data (`apps/desktop/src/data/apps.js` in UnifiedApp). Installed clients
   verify each download against the recorded hash. **Do not modify or delete published release assets** —
   doing so breaks integrity checks on already-installed clients.
2. **Bundle source.** Each marketplace app's source + the tooling needed to build a release lives under
   [`apps/`](apps/). These were previously kept in `UnifiedApp/tmp/` (git-ignored); they now live here,
   next to where they are released.

## Apps

All apps are `kind: node-service` and currently ship `darwin-arm64`.

| App | Dir | Upstream | Latest release |
|-----|-----|----------|----------------|
| Vibe-Trading | [`apps/vibe-trading`](apps/vibe-trading) | [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | `vibe-trading-v0.1.9` |
| Hermes Web UI | [`apps/hermes`](apps/hermes) | [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui) | _pending_ (`hermes-v0.51.247`) |
| OpenDesign | [`apps/open-design`](apps/open-design) | [nexu-io/open-design](https://github.com/nexu-io/open-design) | `opendesign-v1.1.0` |
| OpenClaw | [`apps/openclaw`](apps/openclaw) | [openclaw/openclaw](https://github.com/openclaw/openclaw) | `openclaw-v1.0.0` |

See each app's own `README.md` for its pinned upstream commit, exact build command, build dependencies,
and the changes layered on top of upstream.

## What's tracked vs. not

Each app directory is **upstream source (pinned to a commit, with our changes applied in-place) plus our
bundling layer** (`build-bundle.sh`/`build.sh`, `launch.py`/`start.mjs`, `BUNDLING.md`,
`normalize-symlinks.mjs`, and any new source files). Regenerable artifacts — `node_modules/`,
`.bundle-build/` (downloaded CPython/Node + staging), build outputs (`dist/`, `out/`), caches, and the
release `.zip` archives — are **not** committed (see [`.gitignore`](.gitignore)); the build scripts
recreate them.

## Cutting a release

```bash
cd apps/<app>
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh      # OpenClaw: cd apps/openclaw/openclaw-bundle && ./build.sh
```

The script prints the output `.zip`'s SHA256 and byte size. Then:

```bash
gh release upload <tag> <app>-bundle-darwin-arm64.zip --repo greedyafinc/demo-app-bundles
```

and update that app's `sha256` + `sizeBytes` in UnifiedApp `apps/desktop/src/data/apps.js`. Per-app
READMEs document the exact tag, artifact name, and any cross-repo build dependencies.
