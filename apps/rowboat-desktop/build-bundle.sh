#!/usr/bin/env bash
# Build the Rowboat desktop app (Electron, upstream apps/x) as a standalone
# macOS .app for the UnifiedApp solo-bundle channel.
#
#   - pnpm-installs the nested workspace (incl. the @unifiedai/sdk git dep,
#     whose prepare step needs `bun` on PATH)
#   - builds shared → core → preload → renderer → main
#   - electron-forge package (ad-hoc signed unless APPLE_ID/APPLE_PASSWORD/
#     APPLE_TEAM_ID are exported — then signed + notarized)
#   - zips Rowboat.app (ditto, preserving resource forks/symlinks) and prints
#     sha256 + sizeBytes for the soloBundle registration
#
# Output: ./rowboat-desktop-bundle-darwin-arm64.zip
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUNDLE_VERSION="${BUNDLE_VERSION:-0.1.0}"   # upstream apps/main package version
ARCH="${ARCH:-arm64}"
OUT_ZIP="$SCRIPT_DIR/rowboat-desktop-bundle-darwin-${ARCH}.zip"

log() { printf "\033[1;36m[bundle]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[bundle]\033[0m %s\n" "$*" >&2; exit 1; }

command -v pnpm >/dev/null 2>&1 || die "pnpm is required (corepack enable pnpm)"
command -v bun >/dev/null 2>&1 || die "bun is required on PATH (the @unifiedai/sdk git dep builds itself with bun in its prepare script)"

log "Installing workspace deps (pnpm)..."
pnpm install --prefer-offline 2>&1 | tail -2

log "Building shared → core → preload..."
npm run deps >/dev/null

log "Building renderer (vite)..."
( cd apps/renderer && npm run build >/dev/null )

log "Building main (tsc + esbuild)..."
( cd apps/main && npm run build >/dev/null )

log "Packaging .app (electron-forge)..."
if [ -z "${APPLE_ID:-}" ]; then
  log "  (no APPLE_ID — producing an ad-hoc signed, un-notarized build)"
fi
( cd apps/main && npm run package )

APP_PATH="$SCRIPT_DIR/apps/main/out/Rowboat-darwin-${ARCH}/Rowboat.app"
[ -d "$APP_PATH" ] || die "forge did not produce $APP_PATH"

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
echo "    productName: 'Rowboat',"
echo "    identifier: 'com.greedyafinc.rowboat-desktop',"
echo "    version: '${BUNDLE_VERSION}',"
echo "    url: '<published-release-url>/rowboat-desktop-bundle-darwin-${ARCH}.zip',"
echo "    sha256: '${SHA256}',"
echo "    sizeBytes: ${SIZE_BYTES},"
