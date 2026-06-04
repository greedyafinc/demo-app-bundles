# Hermes Web UI — marketplace bundle source

> Source + build tooling for the **Hermes Web UI** UnifiedApp marketplace app (`kind: node-service`).
> Built `.zip` bundles are published as GitHub **Releases** on this repo and referenced by SHA256
> from UnifiedApp `apps/desktop/src/data/apps.js`. The release archives themselves are NOT committed here.

## Upstream provenance

- **Repo:** [`nesquena/hermes-webui`](https://github.com/nesquena/hermes-webui)
- **Pinned commit:** `81e748b4557c7ad364e35ec662903526581730d8` (tag `v0.51.247`, branch `master`)
- Our marketplace changes are applied **in-place to the upstream working tree** (this directory *is* the
  upstream checkout). The authored bundle tooling (`build-bundle.sh`, `launch.py`, `BUNDLING.md`,
  `normalize-symlinks.mjs`, `static/vendor/unified-sdk.js`) and a small set of patched upstream files
  live alongside the original Hermes WebUI source. See **What we changed vs upstream** below and
  [`BUNDLING.md`](BUNDLING.md) for the full rationale.

The upstream repo is named **hermes-webui**; the built bundle asset is named **`hermes-webui-bundle-*`**.

## Marketplace metadata (UnifiedApp apps.js)

| Field | Value |
|-------|-------|
| slug | `hermes` |
| name | Hermes Web UI |
| category | Assistants |
| kind | `node-service` |
| version | `0.51.247` |

**Current release: PENDING — not yet published.**

`apps/desktop/src/data/apps.js` already references the values below, but **no matching GitHub Release
exists on this repo yet**:

| Field | Value |
|-------|-------|
| tag | `hermes-v0.51.247` |
| asset | `hermes-webui-bundle-darwin-arm64.zip` |
| sha256 | `1b7fa0abc765f0b1faa3e206aa309ef07c230bce392f88a184c85cc3168f5112` |
| sizeBytes | `83177797` |

> **Maintainer action:** cut the `hermes-v0.51.247` release, upload the asset, and **re-verify the
> `sha256` and `sizeBytes`** against the freshly built archive. The build is non-deterministic (it
> downloads CPython and git-clones the agent at build time), so the recorded hash/size must be taken
> from the exact `.zip` you publish, then synced back into `apps.js`.

## Build a release

```bash
# from this directory (apps/hermes); requires: bash, curl, git, node, and network access
NODE_PLATFORM=darwin-arm64 ./build-bundle.sh                  # fat bundle (UI + agent) — DEFAULT
INCLUDE_AGENT=0 NODE_PLATFORM=darwin-arm64 ./build-bundle.sh  # lean UI-only bundle (~33 MB)
```

What it does:
- Downloads a **relocatable CPython 3.12.7** (python-build-standalone, `install_only`) and pip-installs
  the Python deps (`requirements.txt`) into that embedded interpreter.
- **Default (FAT):** git-clones `NousResearch/hermes-agent`, installs its runtime deps into the same
  interpreter, and stages the agent source under `hermes-agent/` so the agent runs **in-process** in the
  embedded CPython. `INCLUDE_AGENT=0` skips this for a lean UI-only bundle.
- Refreshes the vendored uni-sdk browser bundle (`static/vendor/unified-sdk.js`) that powers the model
  picker, then stages `server.py` + `api/` + `static/` + `launch.py`, bakes `api/_version.py`, writes
  `manifest.json`, normalizes symlinks, and zips. **No frontend build step** — Hermes WebUI is vanilla JS.

Output artifact: **`./hermes-webui-bundle-darwin-arm64.zip`** (the script also prints `sha256` + `sizeBytes`
and copies the zip to `/tmp/hermes-webui-bundle-darwin-arm64.zip` for desktop "Local" installs).

Publish steps:
1. Upload the artifact to the release tag:
   ```bash
   gh release upload hermes-v0.51.247 hermes-webui-bundle-darwin-arm64.zip --repo greedyafinc/demo-app-bundles
   ```
   (Create the tag first with `gh release create hermes-v0.51.247 ...` if it does not exist yet.)
2. Copy the `sha256` and `sizeBytes` the build printed into the `hermes` entry in UnifiedApp
   `apps/desktop/src/data/apps.js` (and point its `url` at the published release asset).

> The build embeds a platform-specific CPython and installs platform wheels, so run it **on the target
> platform** (or set `NODE_PLATFORM=` plus a valid `PBS_RELEASE`/`PY_VERSION` python-build-standalone
> `install_only` asset). Reference sizes (darwin-arm64): lean UI-only ≈ 33 MB; fat (UI + agent) ≈ 80 MB.

## Build dependencies

Toolchain (must be on PATH): `bash`, `curl`, `git`, `node`, `zip`/`rsync`, plus the embedded CPython
the script downloads and pip-installs into.

Network downloads the build performs:
- A relocatable **CPython 3.12.7** (`install_only`) from astral-sh/python-build-standalone.
- **`NousResearch/hermes-agent`** via shallow `git clone` (default fat build only; skipped with
  `INCLUDE_AGENT=0`).
- Python wheels for `requirements.txt` and the agent's runtime deps, via pip.

Cross-repo dependencies:
- **`uni-sdk` (sibling repo).** `UNI_SDK_DIR` defaults to `$SCRIPT_DIR/../../../uni-sdk` and, when it is
  present together with `bun`, is used to rebuild `static/vendor/unified-sdk.js` (the `UnifiedAI` client +
  brand-logo helpers that drive the model picker). That `../../../uni-sdk` path **only resolves to
  `GitHub/uni-sdk` inside the sibling-repo workspace** — i.e. when `demo-app-bundles/apps/hermes` sits
  next to the other `greedyafinc` repos. When the sibling repo or `bun` is absent, the build falls back
  to the **committed `static/vendor/unified-sdk.js`** and continues; that committed file is the fallback
  that lets the build succeed standalone.

## What is NOT committed (regenerated by the build)

- `.bundle-build/` — the staging dir, the downloaded relocatable CPython, and the cloned hermes-agent.
- `node_modules/` and `__pycache__/` / `*.pyc`.
- The release `*.zip` (`hermes-webui-bundle-darwin-arm64.zip`) — published as a GitHub Release, not committed.
- `api/_version.py` — baked by the build (the `.git`-less bundle cannot `git describe`).
- Build logs and other transient artifacts.

## What we changed vs upstream

Authored (new) files:
- `build-bundle.sh` — bundle builder (embeds CPython, co-bundles the agent, stages the app, zips).
- `launch.py` — service entrypoint; bridges the desktop's `OD_*` env vars to the `HERMES_WEBUI_*` names
  the app expects, wires broker auth, and seeds the agent/gateway config.
- `BUNDLING.md` — design notes for the marketplace bundle.
- `normalize-symlinks.mjs` — clamps any symlink whose target escapes the bundle root (the installer
  rejects archives with escaping symlinks).
- `static/vendor/unified-sdk.js` — generated uni-sdk browser bundle, committed as the build fallback.

Patched upstream files (unified-sdk model picker + unified-api integration):
- `api/helpers.py`, `api/routes.py`
- `static/index.html`, `static/style.css`, `static/ui.js`
