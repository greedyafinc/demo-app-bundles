#!/usr/bin/env bash
# Build a self-contained Rowboat bundle (node-service kind) installable by the
# UnifiedApp marketplace. Mirrors open-design/build-bundle.sh (embedded Node)
# and hermes/build-bundle.sh (staging layout):
#
#   - downloads Node 24 (relocatable tarball) and embeds it as runtime/node
#   - npm-installs + tsc-builds the rowboatx server (cli/), incl. the
#     @unifiedai/sdk git dep (its prepare step needs `bun` on PATH)
#   - npm-installs + next-builds the dashboard (ui/, static export → ui/out)
#   - stages cli/dist + prod node_modules, ui/out, launch.mjs, manifest.json
#   - normalizes symlinks so none escape the bundle root (installer guard), zips
#
# Output: ./rowboat-bundle-${NODE_PLATFORM}.zip  (+ printed sha256/bytes for apps.js)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_DIR="$SCRIPT_DIR/.bundle-build"
STAGE_DIR="$BUILD_DIR/stage"
# Tracks the upstream rowboatx (apps/cli) package version this bundle was cut from.
BUNDLE_VERSION="${BUNDLE_VERSION:-0.16.0}"

NODE_VERSION="${NODE_VERSION:-24.11.0}"
NODE_PLATFORM="${NODE_PLATFORM:-darwin-arm64}"
NODE_TARBALL="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
NODE_LOCAL_DIR="$BUILD_DIR/node-v${NODE_VERSION}-${NODE_PLATFORM}"

OUT_ZIP="$SCRIPT_DIR/rowboat-bundle-${NODE_PLATFORM}.zip"
# OUT_ZIP lives in this app dir — exactly where the desktop "Local" install
# resolves it: apps.js localUrl = file://${DEMO_BUNDLES_DIR}/apps/rowboat/<zip>.

log() { printf "\033[1;36m[bundle]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[bundle]\033[0m %s\n" "$*" >&2; exit 1; }

command -v bun >/dev/null 2>&1 || die "bun is required on PATH (the @unifiedai/sdk git dep builds itself with bun in its prepare script)"

mkdir -p "$BUILD_DIR"

# ── 1. Download + unpack Node (cached) ───────────────────────────────────────
if [ ! -x "$NODE_LOCAL_DIR/bin/node" ]; then
  log "Downloading Node ${NODE_VERSION} for ${NODE_PLATFORM}..."
  curl -fL --retry 3 -o "$BUILD_DIR/$NODE_TARBALL" "$NODE_URL"
  log "Unpacking..."
  rm -rf "$NODE_LOCAL_DIR"
  mkdir -p "$NODE_LOCAL_DIR"
  tar -xzf "$BUILD_DIR/$NODE_TARBALL" -C "$NODE_LOCAL_DIR" --strip-components=1
fi
export PATH="$NODE_LOCAL_DIR/bin:$PATH"
export NPM_CONFIG_LOGLEVEL="warn"
log "Node $(node --version) / npm $(npm --version)"

# ── 2. Build the server (cli/) ───────────────────────────────────────────────
log "Installing cli deps (incl. @unifiedai/sdk git dep — first run takes a while)..."
( cd "$SCRIPT_DIR/cli" && npm install --no-audit --no-fund )
log "Building cli (tsc)..."
( cd "$SCRIPT_DIR/cli" && npm run build )
[ -f "$SCRIPT_DIR/cli/dist/server.js" ] || die "cli build did not produce dist/server.js"
[ -f "$SCRIPT_DIR/cli/dist/unified/auth.js" ] || die "cli build did not produce dist/unified/auth.js"

# ── 3. Build the dashboard (ui/, Next.js static export) ─────────────────────
log "Installing ui deps..."
( cd "$SCRIPT_DIR/ui" && npm install --no-audit --no-fund )
log "Building ui (next build, output: export)..."
( cd "$SCRIPT_DIR/ui" && npm run build )
[ -f "$SCRIPT_DIR/ui/out/index.html" ] || die "ui build did not produce out/index.html (check next.config.ts output:'export')"

# ── 4. Stage the bundle tree ─────────────────────────────────────────────────
log "Staging bundle..."
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# 4a. Server: dist + production node_modules. npm prune strips devDeps in
# place (typescript, @types/*) without re-running git-dep prepare scripts —
# the already-built @unifiedai/sdk dist survives.
log "  - pruning cli devDependencies..."
( cd "$SCRIPT_DIR/cli" && npm prune --omit=dev --no-audit --no-fund )
log "  - staging cli (dist + bin + prod node_modules)..."
mkdir -p "$STAGE_DIR/cli"
cp "$SCRIPT_DIR/cli/package.json" "$STAGE_DIR/cli/package.json"
cp -R "$SCRIPT_DIR/cli/dist" "$STAGE_DIR/cli/dist"
cp -R "$SCRIPT_DIR/cli/bin" "$STAGE_DIR/cli/bin"
cp -R "$SCRIPT_DIR/cli/node_modules" "$STAGE_DIR/cli/node_modules"

# 4b. Dashboard static export.
log "  - staging ui/out..."
mkdir -p "$STAGE_DIR/ui"
cp -R "$SCRIPT_DIR/ui/out" "$STAGE_DIR/ui/out"

# 4c. Embed the Node runtime.
log "  - embedding Node ${NODE_VERSION} runtime..."
mkdir -p "$STAGE_DIR/runtime"
cp -R "$NODE_LOCAL_DIR" "$STAGE_DIR/runtime/node"
chmod +x "$STAGE_DIR/runtime/node/bin/node"

# 4d. Service launcher + license.
cp "$SCRIPT_DIR/launch.mjs" "$STAGE_DIR/launch.mjs"
cp "$SCRIPT_DIR/LICENSE" "$STAGE_DIR/LICENSE"

# 4e. Manifest (node-service kind, consumed by Tauri desktop_core/service.rs).
log "  - writing manifest.json..."
cat > "$STAGE_DIR/manifest.json" <<EOF
{
  "slug": "rowboat",
  "version": "${BUNDLE_VERSION}",
  "name": "Rowboat",
  "kind": "node-service",
  "service": {
    "command": "runtime/node/bin/node",
    "args": ["launch.mjs"],
    "workingDir": ".",
    "healthPath": "/health",
    "readyTimeoutMs": 45000,
    "env": {
      "NODE_ENV": "production"
    }
  }
}
EOF

# 4f. Placeholder index.html so an older host's web-kind safety check passes.
# (The real UI is served by the service from ui/out.)
cat > "$STAGE_DIR/index.html" <<'EOF'
<!doctype html><meta charset="utf-8"><title>Rowboat</title>
<p style="font-family:system-ui;padding:24px">Rowboat requires the node-service runtime. Please update the host app.</p>
EOF

# 4g. Clamp any symlink whose target escapes the bundle root (npm/node ship
# .bin and corepack symlinks; the installer rejects the archive on a single
# escaping one).
log "  - normalizing symlinks..."
node "$SCRIPT_DIR/normalize-symlinks.mjs" "$STAGE_DIR"

# ── 5. Zip (preserve symlinks) ───────────────────────────────────────────────
log "Packaging zip (preserving symlinks)..."
rm -f "$OUT_ZIP"
( cd "$STAGE_DIR" && zip -qry "$OUT_ZIP" . )

SIZE_BYTES=$(wc -c < "$OUT_ZIP" | tr -d ' ')
SHA256=$(shasum -a 256 "$OUT_ZIP" | awk '{print $1}')

log "✓ Bundle ready: $OUT_ZIP"
log "  desktop 'Local' installs read this in-repo path via \${DEMO_BUNDLES_DIR}"
log "  size:   ${SIZE_BYTES} bytes"
log "  sha256: ${SHA256}"
log "  version: ${BUNDLE_VERSION}"
echo
echo "For a published/remote release, paste into apps/desktop/src/data/apps.js bundle:"
echo "    url: '<published-release-url>/rowboat-bundle-${NODE_PLATFORM}.zip',"
echo "    localUrl: 'file://\${DEMO_BUNDLES_DIR}/apps/rowboat/rowboat-bundle-${NODE_PLATFORM}.zip',"
echo "    version: '${BUNDLE_VERSION}',"
echo "    sha256: '${SHA256}',"
echo "    sizeBytes: ${SIZE_BYTES},"
