#!/usr/bin/env bash
# Build a self-contained OpenDesign bundle (node-service kind) installable by
# the UnifiedApp marketplace. Downloads Node 24, installs deps, builds daemon
# and web, stages a complete runtime tree, and zips it.
#
# Output: ./opendesign-bundle-${NODE_PLATFORM}.zip  (plus printed sha256 + bytes for apps.js)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_DIR="$SCRIPT_DIR/.bundle-build"
STAGE_DIR="$BUILD_DIR/stage"
NODE_VERSION="24.11.0"
NODE_PLATFORM="${NODE_PLATFORM:-darwin-arm64}"
NODE_TARBALL="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
NODE_LOCAL_DIR="$BUILD_DIR/node-v${NODE_VERSION}-${NODE_PLATFORM}"
OUT_ZIP="$SCRIPT_DIR/opendesign-bundle-${NODE_PLATFORM}.zip"
# Desktop marketplace "Local" installs read this fixed path (the `localUrl` in
# apps/desktop/src/data/apps.js). We copy the freshly-built zip here at the end
# so toggling Local + (re)installing OpenDesign picks up this build.
LOCAL_DEST="/tmp/opendesign-bundle-${NODE_PLATFORM}.zip"
BUNDLE_VERSION="1.1.0"

log() { printf "\033[1;36m[bundle]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[bundle]\033[0m %s\n" "$*" >&2; exit 1; }

mkdir -p "$BUILD_DIR"

# ── 1. Download + unpack Node 24 (cached) ────────────────────────────────────
if [ ! -x "$NODE_LOCAL_DIR/bin/node" ]; then
  log "Downloading Node ${NODE_VERSION} for ${NODE_PLATFORM}..."
  curl -fL --retry 3 -o "$BUILD_DIR/$NODE_TARBALL" "$NODE_URL"
  log "Unpacking..."
  rm -rf "$NODE_LOCAL_DIR"
  mkdir -p "$NODE_LOCAL_DIR"
  tar -xzf "$BUILD_DIR/$NODE_TARBALL" -C "$NODE_LOCAL_DIR" --strip-components=1
fi
log "Node $($NODE_LOCAL_DIR/bin/node --version)"

# Add downloaded node to PATH for the rest of the script.
export PATH="$NODE_LOCAL_DIR/bin:$PATH"
export NPM_CONFIG_LOGLEVEL="warn"

# ── 2. Activate pnpm 10.33.2 via corepack (matches package.json) ─────────────
if ! command -v pnpm >/dev/null 2>&1; then
  log "Enabling corepack pnpm..."
  corepack enable --install-directory "$NODE_LOCAL_DIR/bin" pnpm
  corepack prepare pnpm@10.33.2 --activate
fi
log "pnpm $(pnpm --version)"

# ── 3. Install workspace deps and build daemon + web ─────────────────────────
log "Installing workspace deps (this can take a few minutes the first time)..."
pnpm install --prefer-offline

log "Building daemon..."
pnpm --filter @open-design/daemon... build

log "Building web (Next.js static export)..."
pnpm --filter @open-design/web build

[ -f "$SCRIPT_DIR/apps/daemon/dist/cli.js" ] || die "daemon build did not produce dist/cli.js"
[ -d "$SCRIPT_DIR/apps/web/out" ] || die "web build did not produce apps/web/out (check next.config.ts output:'export')"

# ── 4. Stage bundle tree ─────────────────────────────────────────────────────
log "Staging bundle..."
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# 4a. Daemon: use `pnpm deploy` to materialize a self-contained tree with all
# workspace deps resolved as real packages and prod-only externals installed.
log "  - deploying daemon (with native better-sqlite3 binding)..."
pnpm --filter @open-design/daemon deploy --prod --legacy "$STAGE_DIR/apps/daemon"

# 4b. Web: copy the Next.js static export.
log "  - copying web/out..."
mkdir -p "$STAGE_DIR/apps/web"
cp -R "$SCRIPT_DIR/apps/web/out" "$STAGE_DIR/apps/web/out"

# 4c. Resource directories the daemon reads from PROJECT_ROOT (see server.ts).
log "  - copying resource dirs (skills, design-systems, design-templates, craft, frames, prompt-templates, plugins, community-pets)..."
for dir in skills design-systems design-templates craft prompt-templates; do
  if [ -d "$SCRIPT_DIR/$dir" ]; then
    cp -R "$SCRIPT_DIR/$dir" "$STAGE_DIR/$dir"
  fi
done
mkdir -p "$STAGE_DIR/assets"
[ -d "$SCRIPT_DIR/assets/frames" ] && cp -R "$SCRIPT_DIR/assets/frames" "$STAGE_DIR/assets/frames" || true
[ -d "$SCRIPT_DIR/assets/community-pets" ] && cp -R "$SCRIPT_DIR/assets/community-pets" "$STAGE_DIR/assets/community-pets" || true
[ -d "$SCRIPT_DIR/plugins" ] && cp -R "$SCRIPT_DIR/plugins" "$STAGE_DIR/plugins" || true

# 4d. Embed the Node 24 runtime so the daemon has an interpreter at runtime.
log "  - embedding Node ${NODE_VERSION} runtime..."
mkdir -p "$STAGE_DIR/runtime"
cp -R "$NODE_LOCAL_DIR" "$STAGE_DIR/runtime/node"
chmod +x "$STAGE_DIR/runtime/node/bin/node"

# 4e. Manifest (node-service kind, consumed by Tauri service.rs).
log "  - writing manifest.json..."
cat > "$STAGE_DIR/manifest.json" <<EOF
{
  "slug": "opendesign",
  "version": "${BUNDLE_VERSION}",
  "name": "OpenDesign",
  "sdkVersion": "1.1.0",
  "kind": "node-service",
  "service": {
    "command": "runtime/node/bin/node",
    "args": ["apps/daemon/dist/cli.js", "--no-open"],
    "workingDir": ".",
    "healthPath": "/api/app-config",
    "readyTimeoutMs": 45000,
    "env": {
      "NODE_ENV": "production"
    }
  }
}
EOF

# 4f. Placeholder index.html so the installer's web-kind safety check passes
# even when an older client opens this bundle in iframe-fallback mode.
cat > "$STAGE_DIR/index.html" <<'EOF'
<!doctype html><meta charset="utf-8"><title>OpenDesign</title>
<p style="font-family:system-ui;padding:24px">OpenDesign requires the node-service runtime. Please update the host app.</p>
EOF

# 4g. Normalize symlinks so none escape the bundle root. `pnpm deploy --legacy`
# copies workspace self-links (e.g. .pnpm/node_modules/@open-design/daemon) with
# a `../` depth from the ORIGINAL monorepo layout; in the shallower bundle they
# climb above root, and the UnifiedApp installer's containment guard rejects the
# whole archive ("Unsafe symlink target in archive"). Clamp + rewrite them.
log "  - normalizing escaping symlinks..."
node "$SCRIPT_DIR/normalize-symlinks.mjs" "$STAGE_DIR"

# ── 5. Zip ───────────────────────────────────────────────────────────────────
# Preserve pnpm's symlink layout. The Rust extractor handles zip entries whose
# unix mode marks them as symlinks; flattening would either break transitive
# require() resolution or duplicate every shared dep on disk.
log "Packaging zip (preserving symlinks)..."
rm -f "$OUT_ZIP"
( cd "$STAGE_DIR" && zip -qry "$OUT_ZIP" . )

SIZE_BYTES=$(wc -c < "$OUT_ZIP" | tr -d ' ')
SHA256=$(shasum -a 256 "$OUT_ZIP" | awk '{print $1}')

# Copy to the fixed path the desktop's local-install `localUrl` points at, so a
# Marketplace "Local" install of OpenDesign consumes this build directly.
cp -f "$OUT_ZIP" "$LOCAL_DEST"

log "✓ Bundle ready: $OUT_ZIP"
log "  copied to: $LOCAL_DEST (used by desktop 'Local' installs)"
log "  size:   ${SIZE_BYTES} bytes"
log "  sha256: ${SHA256}"
log "  version: ${BUNDLE_VERSION}"
echo
echo "Desktop 'Local' install reads ${LOCAL_DEST} (apps.js localUrl) — already in sync."
echo
echo "For a published/remote release, paste into apps/desktop/src/data/apps.js bundle:"
echo "    url: 'file://${OUT_ZIP}',"
echo "    version: '${BUNDLE_VERSION}',"
echo "    sha256: '${SHA256}',"
echo "    sizeBytes: ${SIZE_BYTES},"
