#!/usr/bin/env bash
# Build Grist Desktop (gristlabs/grist-desktop, an Electron wrapper that embeds
# grist-core) as a standalone macOS .app for the UnifiedApp solo-bundle channel,
# with Grist's AI Assistant routed through the UnifiedAI gateway.
#
# What it does:
#   - fetches the pinned grist-core into core/ (the upstream git submodule; we
#     vendor only the light grist-desktop tree, not heavy grist-core)
#   - yarn-installs the workspace (incl. the @unifiedai/sdk git dep, whose
#     prepare step builds with `bun`)
#   - runs upstream setup (Pyodide sandbox + self-contained Python) and build
#     (tsc -> core/_build, resolve-tspaths)
#   - esbuilds the SDK's node entry into a CommonJS shim the tsc/CJS build can
#     require at runtime (see ext/app/electron/unified/_sdk.d.ts for why)
#   - electron-builder --dir (ad-hoc signed unless APPLE_ID/APPLE_ID_PASSWORD/
#     APPLE_TEAM_ID are exported -> then signed + notarized)
#   - zips "Grist Desktop.app" (ditto, preserving resource forks/symlinks) and
#     prints sha256 + sizeBytes for the soloBundle registration
#
# Output: ./grist-desktop-bundle-darwin-arm64.zip
#
# Deps: macOS (darwin-arm64), Node 22, yarn, bun (on PATH), npx, git, make,
# curl, ditto. Network access (grist-core, Pyodide packages, CPython, Electron).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Pins — keep in sync with .upstream-sha.
GRIST_DESKTOP_SHA="ed392da33ab6bd9d5ab27101c3b1273da10fca06"   # tag v0.3.12
GRIST_CORE_SHA="586a286e47fffc07f16533fba4e66f6a5a44b689"     # core submodule @ v0.3.12

BUNDLE_VERSION="${BUNDLE_VERSION:-0.3.12}"
ARCH="${ARCH:-arm64}"
PLATFORM="darwin-${ARCH}"
APP_NAME="Grist Desktop"
OUT_ZIP="$SCRIPT_DIR/grist-desktop-bundle-${PLATFORM}.zip"

log() { printf "\033[1;36m[bundle]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[bundle]\033[0m %s\n" "$*" >&2; exit 1; }

for tool in node yarn bun npx git make curl ditto; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required on PATH"
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || log "WARNING: Node $NODE_MAJOR detected; grist-core expects Node 22 (.nvmrc v22.12.0)"

# 1. grist-core (vendored as a fetch, not committed). Idempotent.
if [ ! -f core/package.json ]; then
  log "Fetching grist-core @ ${GRIST_CORE_SHA} into core/ ..."
  rm -rf core
  git clone --filter=blob:none https://github.com/gristlabs/grist-core core
  git -C core checkout --detach "$GRIST_CORE_SHA"
else
  log "core/ already present (grist-core); skipping clone"
fi

# 2. Workspace deps (root + core + ext). Plain install: adding @unifiedai/sdk to
#    ext changes the tree, so the lockfile is not frozen.
log "Installing workspace deps (yarn)..."
yarn install

# 3. Ensure the @unifiedai/sdk node build exists (its prepare may be skipped on a
#    clean checkout). The git dep installs its own devDeps so bun build can run.
if [ ! -f node_modules/@unifiedai/sdk/dist/node/index.js ]; then
  log "Building @unifiedai/sdk (git dependency)..."
  # build:types runs tsc, so the SDK needs both @types/bun and typescript present.
  ( cd node_modules/@unifiedai/sdk && bun add -d @types/bun typescript && bun run build )
fi

# 4. Upstream setup: symlinks, self-contained Python, Pyodide sandbox.
log "Running upstream setup (Pyodide + Python; this is slow)..."
RUN_ARCH="$ARCH" yarn run setup

# 5. Upstream build: tsc --build (compiles ext, incl. our unified module) +
#    resolve-tspaths. Produces core/_build/**.
log "Building grist-core + ext (tsc)..."
yarn run build

# 6. Drop the CommonJS SDK shim next to the compiled unified module. grist-core
#    compiles to CJS with classic node resolution and cannot require the SDK's
#    ESM-behind-exports build, so we bundle the node entry to a standalone CJS
#    file that auth.js requires as ./_sdk at runtime.
SDK_OUT="core/_build/ext/app/electron/unified/_sdk.js"
[ -d "core/_build/ext/app/electron/unified" ] || die "compiled unified module missing — did tsc include ext/app/electron/unified?"
log "Bundling @unifiedai/sdk node entry -> $SDK_OUT ..."
# The SDK's node entry uses createRequire(import.meta.url); esbuild's cjs output
# would otherwise emit import_meta.url === undefined and throw at load. Define
# import.meta.url to the bundle's own file URL via a banner.
npx --yes esbuild@0.24.0 node_modules/@unifiedai/sdk/dist/node/index.js \
  --bundle --platform=node --format=cjs --target=node18 \
  --external:@napi-rs/keyring \
  --define:import.meta.url=__sdkImportMetaUrl \
  --banner:js='const __sdkImportMetaUrl=require("url").pathToFileURL(__filename).href;' \
  --outfile="$SDK_OUT"

# 7. Package the unpacked .app.
if [ -z "${APPLE_ID:-}" ]; then
  log "(no APPLE_ID — producing an ad-hoc signed, un-notarized build)"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi
log "Packaging ${APP_NAME}.app (${PLATFORM})..."
npx --yes electron-builder build --mac --"${ARCH}" --dir --publish never

APP_PATH="$SCRIPT_DIR/dist/mac-${ARCH}/${APP_NAME}.app"
[ -d "$APP_PATH" ] || APP_PATH="$SCRIPT_DIR/dist/mac/${APP_NAME}.app"
[ -d "$APP_PATH" ] || die "electron-builder did not produce ${APP_NAME}.app under dist/"

# 8. Zip with the .app at archive root.
log "Zipping (ditto, preserves bundle structure)..."
rm -f "$OUT_ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$OUT_ZIP"

SIZE_BYTES=$(wc -c < "$OUT_ZIP" | tr -d ' ')
SHA256=$(shasum -a 256 "$OUT_ZIP" | awk '{print $1}')

log "✓ Bundle ready: $OUT_ZIP"
log "  app:     $APP_PATH"
log "  size:    ${SIZE_BYTES} bytes"
log "  sha256:  ${SHA256}"
log "  version: ${BUNDLE_VERSION}"
echo
echo "soloBundle registration (UnifiedApp apps.js / unified-db app_solo_bundles):"
echo "    productName: '${APP_NAME}',"
echo "    identifier: 'com.getgrist.grist',"
echo "    version: '${BUNDLE_VERSION}',"
echo "    url: '<published-release-url>/grist-desktop-bundle-${PLATFORM}.zip',"
echo "    sha256: '${SHA256}',"
echo "    sizeBytes: ${SIZE_BYTES},"
