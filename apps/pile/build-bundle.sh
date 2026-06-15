#!/usr/bin/env bash
# Build Pile (UdaraJay/Pile, an Electron React Boilerplate journaling app) as a
# standalone macOS .app for the UnifiedApp solo-bundle channel, with Pile's AI
# reflections + semantic vector index routed through the UnifiedAI gateway.
#
# What it does:
#   - npm-installs the workspace (incl. the @unifiedai/sdk git dep, whose
#     `prepare` step builds the node entry with `bun`, externalizing the native
#     @napi-rs/keyring)
#   - ensures the @unifiedai/sdk node entry exists (dist/node/index.js); builds
#     it if a cached/linked install skipped `prepare`
#   - webpack-builds main + renderer (`npm run build` -> release/app/dist/**);
#     the main bundle includes src/main/unified (loopback proxy + SDK OAuth),
#     with @napi-rs/keyring marked external in webpack.config.base
#   - electron-builder --dir (ad-hoc signed unless APPLE_ID/APPLE_ID_PASS/
#     APPLE_TEAM_ID are exported with CI=true -> then signed + notarized)
#   - zips "Pile.app" (ditto, preserving resource forks/symlinks) and prints
#     sha256 + sizeBytes for the soloBundle registration
#
# Output: ./pile-bundle-darwin-arm64.zip
#
# Deps: macOS (darwin-arm64), Node 20+, npm, bun (on PATH — the SDK git dep
# builds with bun), npx, git, ditto. Network access (npm registry, the
# @unifiedai/sdk git dep, Electron download).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Pin — keep in sync with .upstream-sha.
PILE_SHA="234aa902f6a5b8b231b815501d5dac996feb8cdf"   # UdaraJay/Pile @ v1.0.0

BUNDLE_VERSION="${BUNDLE_VERSION:-1.0.0}"
ARCH="${ARCH:-arm64}"
PLATFORM="darwin-${ARCH}"
APP_NAME="Pile"
OUT_ZIP="$SCRIPT_DIR/pile-bundle-${PLATFORM}.zip"

log() { printf "\033[1;36m[bundle]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[bundle]\033[0m %s\n" "$*" >&2; exit 1; }

for tool in node npm bun npx git ditto; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required on PATH"
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || log "WARNING: Node $NODE_MAJOR detected; Pile expects Node 20+ (electron 33)"

# 1. Workspace deps. Plain install: adding @unifiedai/sdk changes the tree, and
#    Pile ships only a pnpm-lock; we install with npm to match its ERB scripts
#    (postinstall builds the renderer DLL via build:dll). --legacy-peer-deps is
#    required: upstream Pile pins react@19 while its dev-only
#    @testing-library/react@14 peers react@18 (harmless — test tooling only,
#    unused by the build).
log "Installing deps (npm)..."
npm install --legacy-peer-deps

# 2. Ensure the @unifiedai/sdk node build exists. npm runs the git dep's
#    `prepare` (bun run build) after installing its devDeps, which normally
#    produces dist/node/index.js; rebuild here if a cached/linked install
#    skipped it. The git dep installs its own devDeps so `bun run build` works.
if [ ! -f node_modules/@unifiedai/sdk/dist/node/index.js ]; then
  log "Building @unifiedai/sdk (git dependency)..."
  ( cd node_modules/@unifiedai/sdk && bun add -d @types/bun && bun run build )
fi
[ -f node_modules/@unifiedai/sdk/dist/node/index.js ] \
  || die "@unifiedai/sdk node entry missing (dist/node/index.js) — SDK build failed"

# 3. Build main + renderer (webpack prod -> release/app/dist/**). The main
#    bundle pulls in src/main/unified and the SDK node entry.
log "Building Pile (webpack)..."
npm run build

# 4. Package the unpacked .app.
if [ -z "${APPLE_ID:-}" ]; then
  log "(no APPLE_ID — producing an ad-hoc signed, un-notarized build)"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi
log "Packaging ${APP_NAME}.app (${PLATFORM})..."
npx --yes electron-builder build --mac --"${ARCH}" --dir --publish never

APP_PATH="$SCRIPT_DIR/release/build/mac-${ARCH}/${APP_NAME}.app"
[ -d "$APP_PATH" ] || APP_PATH="$SCRIPT_DIR/release/build/mac/${APP_NAME}.app"
[ -d "$APP_PATH" ] || die "electron-builder did not produce ${APP_NAME}.app under release/build/"

# 5. Zip with the .app at archive root.
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
echo "    identifier: 'com.greedyafinc.pile',"
echo "    version: '${BUNDLE_VERSION}',"
echo "    url: '<published-release-url>/pile-bundle-${PLATFORM}.zip',"
echo "    sha256: '${SHA256}',"
echo "    sizeBytes: ${SIZE_BYTES},"
