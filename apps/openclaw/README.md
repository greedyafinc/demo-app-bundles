# OpenClaw — marketplace bundle source

> Source + build tooling for the **OpenClaw** UnifiedApp marketplace app (`kind: node-service`).
> Built `.zip` bundles are published as GitHub **Releases** on this repo and referenced by SHA256
> from UnifiedApp `apps/desktop/src/data/apps.js`. The release archives themselves are NOT committed here.

## Layout

This app lives in two co-located subdirectories under `apps/openclaw/`:

| Subdir | What it is |
|--------|------------|
| `openclaw/` | Pristine upstream OpenClaw source (the cloned project, unmodified). |
| `openclaw-bundle/` | The bundling harness — build script + node-service wrapper + manifest that turn the upstream build output into a marketplace `.zip`. |

All UnifiedApp-specific bundling lives in `openclaw-bundle/`. The upstream tree under `openclaw/`
has **no in-place patches** — `openclaw-bundle/build.sh` builds upstream as-is and then post-processes
the built output (CSP / X-Frame-Options / token-scrub) into the staged copy. The two subdirs must stay
co-located: `build.sh` reaches the source via `$SCRIPT_DIR/../openclaw`.

## Upstream provenance

- **Repo:** https://github.com/openclaw/openclaw
- **Pinned commit:** `f07c87405c3094feceaaf2f0f19a2e765a25e78d`
- **Describe / tag:** `v2026.4.19-beta.2-18608-gf07c87405c`
- **Branch:** `main`
- **Patching model:** None applied to the upstream working tree. The upstream source is built unchanged;
  the only modifications (CSP `frame-ancestors`, `X-Frame-Options`, and a token-scrub `<script>`) are
  applied by `build.sh` to the **staged build output** (`openclaw-bundle/openclaw/dist/...`), never to
  the `openclaw/` source. (The upstream tree retains a few tracked `*.zip` test fixtures under
  `test/fixtures/**` — these are legitimate source, not release artifacts.)

## Marketplace metadata (UnifiedApp apps.js)

- **slug:** `openclaw`
- **name:** OpenClaw
- **category:** Assistants
- **kind:** `node-service`
- **version:** `1.0.0`

Current release: **PUBLISHED**

- **tag:** `openclaw-v1.0.0`
- **asset:** `openclaw-bundle-darwin-arm64.zip`
- **sha256:** `cb3dd7335b99381247236e0329f530b5bf217bddbcc3de3f744784dac7f3101b`
- **sizeBytes:** `671324197`

## Build a release

From the harness directory:

```bash
cd openclaw-bundle
NODE_PLATFORM=darwin-arm64 ./build.sh
```

What it does:

- `pnpm install` + `pnpm build` the upstream project at `../openclaw`, then stages `openclaw.mjs`,
  `package.json`, and `dist/` into `openclaw-bundle/openclaw/`, plus `node_modules/` copied with symlinks
  flattened (`rsync -aL`) and the `.pnpm` store dropped.
- Downloads the Node 24 (`v24.0.0`) runtime for the target platform into `openclaw-bundle/bin/node`
  (skipped if already present).
- Refreshes `app-sdk/index.js` from the sibling UnifiedApp workspace (see Build dependencies for the
  caveat), then patches the staged `dist/control-ui-*.js` (CSP `frame-ancestors` → Tauri origins,
  `X-Frame-Options` → `SAMEORIGIN`) and injects a token-scrub `<script>` into
  `dist/control-ui/index.html` so the gateway control UI can be iframed inside the Tauri WebView. The
  patch is asserted post-`sed`; a silent no-op aborts the build (catches upstream renames).
- Zips `manifest.json`, `start.mjs`, `config-template.json`, `bin/node`, `app-sdk/`, and `openclaw/`.

Output artifact: `/tmp/openclaw-bundle-darwin-arm64.zip` (the script also writes an
`apps.openclaw.json` sidecar with the computed `sha256` + `sizeBytes`).

> The platform is parameterized via `NODE_PLATFORM` (and `NODE_VERSION`); only `darwin-arm64` ships today.

Publish steps:

```bash
# 1. Upload the built zip to the release tag (rename to the published asset name)
gh release upload openclaw-v1.0.0 \
  /tmp/openclaw-bundle-darwin-arm64.zip#openclaw-bundle-darwin-arm64.zip

# 2. Update UnifiedApp apps/desktop/src/data/apps.js with the new sha256 + sizeBytes
#    for the openclaw bundle (values printed by build.sh / apps.openclaw.json).
```

## Build dependencies

Toolchain + network downloads:

- **pnpm** (preferred; falls back to `bun` for install, or `npx pnpm`). The `pnpm build` step always uses
  `pnpm` (or `npx pnpm`) because some plugin asset steps require it.
- **Node 24** runtime tarball downloaded from `nodejs.org/dist` and embedded as `bin/node`.
- Standard CLI tools: `curl`, `tar`, `rsync`, `zip`, `sed`, `awk`, `shasum`.

Cross-repo dependencies — two `../` paths into the sibling-repo workspace:

1. **`$SCRIPT_DIR/../openclaw`** (upstream source). **Preserved** by this migration: both subdirs are
   co-located under `apps/openclaw/`, so this path resolves here.
2. **`$SCRIPT_DIR/../../packages/app-sdk/src`** (the UnifiedApp `@unified/app-sdk` source). This pointed at
   `UnifiedApp/packages/app-sdk/src` and does **not** resolve after this migration — there is no
   `packages/app-sdk/` in this repo. That path is now **optional**: when present (building inside the
   UnifiedApp workspace) it refreshes `app-sdk/index.js`; when absent the build falls back to the committed
   `openclaw-bundle/app-sdk/index.js`, which is the copy that ships in the bundle.

   **This migration hardened `build.sh`** so a missing sibling path no longer breaks the build. Previously
   the path was resolved with an unguarded command substitution that, under `set -euo pipefail`, aborted
   the whole script before the intended fallback could run:

   ```bash
   # before — a missing dir makes `cd` exit non-zero and aborts the build:
   APP_SDK_SRC="$(cd "$SCRIPT_DIR/../../packages/app-sdk/src" && pwd)"

   # after — guarded; resolves only if the dir exists, else keeps the committed copy:
   APP_SDK_SRC=""
   if [ -d "$SCRIPT_DIR/../../packages/app-sdk/src" ]; then
     APP_SDK_SRC="$(cd "$SCRIPT_DIR/../../packages/app-sdk/src" && pwd)"
   fi
   ```

   So a standalone build in this repo now succeeds, shipping the committed `app-sdk/index.js`. To refresh
   that vendored copy, build inside the UnifiedApp workspace (or copy `packages/app-sdk/src/index.js`
   over it).

## What is NOT committed (regenerated by the build)

- `openclaw-bundle/bin/` — downloaded Node 24 runtime (~111 MB).
- `openclaw-bundle/openclaw/` — staged build output (dist + flattened `node_modules`, ~1.9 GB).
- `node_modules/` (anywhere) and `.bundle-build/`.
- The `*.zip` release archive (published as a GitHub Release, not committed).

(`*.zip` in `.gitignore` only matches untracked paths, so the upstream `openclaw/test/fixtures/**` test
fixtures that are already tracked remain in git.)

## What we changed vs upstream

Authored (new) files, all under `openclaw-bundle/`:

- `build.sh` — the bundle build + post-processing + zip script.
- `start.mjs` — the node-service wrapper entry. Launched by the desktop host (`OD_PORT`, `OD_DATA_DIR`,
  `UNIFIED_BROKER_URL/TOKEN`, etc.); it generates a per-data-dir gateway token, starts a loopback proxy
  that attaches broker-minted JWTs (via `app-sdk` `getAppToken()`) and forwards to unified-api as
  OpenClaw's `OPENAI_BASE_URL`, renders a safe `openclaw.json`, then spawns the OpenClaw gateway.
- `manifest.json` — marketplace service descriptor (`kind: node-service`, command `bin/node start.mjs`,
  `healthPath: /health`).
- `config-template.json` — the base gateway config rendered per-launch by `start.mjs`.
- `app-sdk/index.js` — vendored copy of the UnifiedApp `@unified/app-sdk` broker client (the working
  fallback for the unresolved cross-repo path above).

Patched upstream files — none in the source tree. The only upstream modifications are applied by
`build.sh` to the **staged build output** at bundle time:

- `openclaw/dist/control-ui-*.js` — CSP `frame-ancestors 'none'` (or a prior wildcard) rewritten to the
  Tauri origin allowlist, and `X-Frame-Options: DENY` → `SAMEORIGIN`.
- `openclaw/dist/control-ui/index.html` — token-scrub `<script>` injected before `</head>`.
