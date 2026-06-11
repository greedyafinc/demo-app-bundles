#!/usr/bin/env bash
# Build the AionUi solo bundle for the UnifiedApp marketplace:
# a prebuilt AionUi.app (darwin-arm64) zipped with the .app at archive root.
#
# Deps: macOS (darwin-arm64), bun on PATH (also builds the @unifiedai/sdk git
# dependency in its prepare script), node, and network access to download the
# pinned aioncore backend binary from iOfficeAI/AionCore GitHub releases
# (version pinned via "aioncoreVersion" in package.json).
#
# Export APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID for a Developer-ID-signed build;
# without them signing identity discovery is disabled and the .app keeps its
# ad-hoc signatures (fine for the marketplace channel, which verifies sha256
# and strips quarantine on install).
set -euo pipefail
cd "$(dirname "$0")"

ARCH="${ARCH:-arm64}"
PLATFORM="darwin-${ARCH}"
APP_NAME="AionUi"
OUT_ZIP="aionui-desktop-bundle-${PLATFORM}.zip"

command -v bun >/dev/null 2>&1 || { echo "error: bun is required on PATH" >&2; exit 1; }

echo "==> Installing dependencies"
bun install

echo "==> Regenerating i18n key types"
bun run i18n:types

if [[ -z "${APPLE_ID:-}" ]]; then
  # No Apple credentials: skip identity discovery so electron-builder doesn't
  # half-sign with whatever cert it finds; Electron's ad-hoc signatures remain.
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

echo "==> Building ${APP_NAME}.app (${PLATFORM})"
# --dir: produce only the unpacked .app (skip the dmg/zip targets and their
# CI-retry logic). The script also downloads + stages the aioncore binary.
node scripts/build-with-builder.js "${ARCH}" --mac "--${ARCH}" --dir

APP="out/mac-${ARCH}/${APP_NAME}.app"
[[ -d "$APP" ]] || { echo "error: build output missing: $APP" >&2; exit 1; }

echo "==> Zipping ${OUT_ZIP}"
rm -f "$OUT_ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT_ZIP"

echo "==> Done"
echo "sha256:    $(shasum -a 256 "$OUT_ZIP" | cut -d' ' -f1)"
echo "sizeBytes: $(stat -f%z "$OUT_ZIP")"
