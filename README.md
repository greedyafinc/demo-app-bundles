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

Most apps are `kind: node-service` and currently ship `darwin-arm64`. The exception is **Peak**, a standalone
[Tauri 2](https://tauri.app) app (desktop + mobile) authored here rather than vendored from an upstream — see
[`apps/peak`](apps/peak).

| App | Dir | Upstream | Latest release |
|-----|-----|----------|----------------|
| Peak (Tauri desktop + mobile) | [`apps/peak`](apps/peak) | _original (Claude Design `Peak.dc.html`)_ | _pending_ (`peak-v0.1.0`) |
| Vibe-Trading | [`apps/vibe-trading`](apps/vibe-trading) | [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | `vibe-trading-v0.1.9` |
| Hermes Web UI | [`apps/hermes`](apps/hermes) | [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui) | _pending_ (`hermes-v0.51.247`) |
| OpenDesign | [`apps/open-design`](apps/open-design) | [nexu-io/open-design](https://github.com/nexu-io/open-design) | `opendesign-v1.1.0` |
| OpenClaw | [`apps/openclaw`](apps/openclaw) | [openclaw/openclaw](https://github.com/openclaw/openclaw) | `openclaw-v1.0.0` |
| Rowboat (in-shell, unregistered) | [`apps/rowboat`](apps/rowboat) | [rowboatlabs/rowboat](https://github.com/rowboatlabs/rowboat) | — (superseded by Rowboat Desktop) |
| Rowboat Desktop (.app) | [`apps/rowboat-desktop`](apps/rowboat-desktop) | [rowboatlabs/rowboat](https://github.com/rowboatlabs/rowboat) `apps/x` | _pending_ (`rowboat-desktop-v0.1.0`) |
| Grist Desktop (.app) | [`apps/grist-desktop`](apps/grist-desktop) | [gristlabs/grist-desktop](https://github.com/gristlabs/grist-desktop) (embeds [grist-core](https://github.com/gristlabs/grist-core)) | _pending_ (`grist-desktop-v0.3.12`) |
| Pile (.app) | [`apps/pile`](apps/pile) | [UdaraJay/Pile](https://github.com/UdaraJay/Pile) | _pending_ (`pile-v1.0.0`) |
| Activepieces (in-shell + .app) | [`apps/activepieces`](apps/activepieces) | [activepieces/activepieces](https://github.com/activepieces/activepieces) `0.85.2` | _pending_ (`activepieces-v0.85.2`) |

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
