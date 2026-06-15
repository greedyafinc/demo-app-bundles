#!/usr/bin/env bash
# Build a self-contained Activepieces bundle (node-service kind) installable by the
# UnifiedApp marketplace. Mirrors Activepieces' own Dockerfile: embeds Node 24 +
# Bun, installs deps, builds web/engine/api/worker with turbo, trims pieces the way
# the image does, stages a runnable tree, and zips it.
#
# Single-machine runtime config (no external Postgres/Redis) is applied at launch
# by launch.mjs (AP_DB_TYPE=PGLITE + AP_REDIS_TYPE=MEMORY), not here.
#
# Output: ./activepieces-bundle-${NODE_PLATFORM}.zip  (+ printed sha256 + bytes for apps.js)
#
# Prerequisites on the build host: a C/C++ toolchain (macOS: Xcode Command Line
# Tools) and network access (Bun fetches prod deps + Activepieces fetches pieces).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_DIR="$SCRIPT_DIR/.bundle-build"
STAGE_DIR="$BUILD_DIR/stage"
NODE_VERSION="24.14.0"           # matches .nvmrc
BUN_VERSION="1.3.3"              # matches packageManager in package.json
NODE_PLATFORM="${NODE_PLATFORM:-darwin-arm64}"
BUNDLE_VERSION="0.85.2"          # upstream tag (.upstream-sha)
OUT_ZIP="$SCRIPT_DIR/activepieces-bundle-${NODE_PLATFORM}.zip"
# OUT_ZIP lives in this app dir — exactly where the desktop "Local" install resolves
# it: apps.js localUrl = file://${DEMO_BUNDLES_DIR}/apps/activepieces/<zip>.

NODE_TARBALL="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
NODE_LOCAL_DIR="$BUILD_DIR/node-v${NODE_VERSION}-${NODE_PLATFORM}"

case "$NODE_PLATFORM" in
  darwin-arm64) BUN_TARGET="bun-darwin-aarch64" ;;
  darwin-x64)   BUN_TARGET="bun-darwin-x64" ;;
  linux-x64)    BUN_TARGET="bun-linux-x64" ;;
  linux-arm64)  BUN_TARGET="bun-linux-aarch64" ;;
  *) echo "[bundle] unsupported NODE_PLATFORM=$NODE_PLATFORM" >&2; exit 1 ;;
esac
BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_TARGET}.zip"
BUN_LOCAL_DIR="$BUILD_DIR/${BUN_TARGET}"

log() { printf "\033[1;36m[bundle]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[bundle]\033[0m %s\n" "$*" >&2; exit 1; }

mkdir -p "$BUILD_DIR"

# ── 1. Download + unpack Node 24 (cached) ────────────────────────────────────
if [ ! -x "$NODE_LOCAL_DIR/bin/node" ]; then
  log "Downloading Node ${NODE_VERSION} for ${NODE_PLATFORM}..."
  curl -fL --retry 3 -o "$BUILD_DIR/$NODE_TARBALL" "$NODE_URL"
  rm -rf "$NODE_LOCAL_DIR"; mkdir -p "$NODE_LOCAL_DIR"
  tar -xzf "$BUILD_DIR/$NODE_TARBALL" -C "$NODE_LOCAL_DIR" --strip-components=1
fi
export PATH="$NODE_LOCAL_DIR/bin:$PATH"
log "Node $(node --version)"

# ── 2. Download + unpack Bun (cached) ────────────────────────────────────────
if [ ! -x "$BUN_LOCAL_DIR/bun" ]; then
  log "Downloading Bun ${BUN_VERSION} (${BUN_TARGET})..."
  curl -fL --retry 3 -o "$BUILD_DIR/${BUN_TARGET}.zip" "$BUN_URL"
  rm -rf "$BUN_LOCAL_DIR"; mkdir -p "$BUILD_DIR/.bununzip"
  unzip -qo "$BUILD_DIR/${BUN_TARGET}.zip" -d "$BUILD_DIR/.bununzip"
  mv "$BUILD_DIR/.bununzip/${BUN_TARGET}" "$BUN_LOCAL_DIR"
  chmod +x "$BUN_LOCAL_DIR/bun"; rm -rf "$BUILD_DIR/.bununzip"
fi
export PATH="$BUN_LOCAL_DIR:$PATH"
log "Bun $(bun --version)"

# ── 3. Install workspace deps + build (in-place; outputs are gitignored) ──────
log "Installing workspace deps with Bun (first run can take a few minutes)..."
bun install --frozen-lockfile

log "Building web, engine, api, worker (turbo)..."
node_modules/.bin/turbo run build \
  --filter=web --filter=@activepieces/engine --filter=api --filter=worker

[ -f "$SCRIPT_DIR/packages/server/api/dist/src/main.js" ]    || die "api build did not produce packages/server/api/dist/src/main.js"
[ -f "$SCRIPT_DIR/packages/server/worker/dist/src/index.js" ] || die "worker build did not produce packages/server/worker/dist/src/index.js"
[ -d "$SCRIPT_DIR/dist/packages/web" ]                        || die "web build did not produce dist/packages/web"
[ -d "$SCRIPT_DIR/dist/packages/engine" ]                    || die "engine build did not produce dist/packages/engine"

# Migration manifest (image-parity; used for tag-based rollback bookkeeping).
log "Generating migration manifest..."
node -e "const {getMigrations} = require('./packages/server/api/dist/src/app/database/postgres-connection'); process.stdout.write(JSON.stringify(getMigrations().map(M => new M().name)));" \
  > "$SCRIPT_DIR/packages/server/api/dist/src/migration-manifest.json" || log "migration-manifest generation skipped"

# ── 3b. Trim pieces + produce a lean production tree IN-PLACE ─────────────────
# Mirror the Dockerfile: trim to the 4 pieces the api imports directly (the other
# 400+ are fetched from the cloud registry at runtime via AP_PIECES_SYNC_MODE=
# OFFICIAL_AUTO, so bundling them is dead weight). Then regenerate the lockfile —
# a FAST prune because node_modules is already present (a from-scratch `bun install`
# on the trimmed workspace stalls) — and do a clean `--production` install, which
# drops the web's build-only devDeps (~halves node_modules) and recreates the
# workspace symlinks.
#
# NOTE: this MUTATES the working tree (removes pieces, rewrites bun.lock +
# node_modules). The script is therefore not re-runnable on a dirty tree —
# re-vendor (or `git restore`) the source for a clean rebuild.
log "Trimming pieces (keep slack, square, facebook-leads, intercom)..."
rm -rf "$SCRIPT_DIR/packages/pieces/core" "$SCRIPT_DIR/packages/pieces/custom"
find "$SCRIPT_DIR/packages/pieces/community" -mindepth 1 -maxdepth 1 -type d \
  ! -name slack ! -name square ! -name facebook-leads ! -name intercom \
  -exec rm -rf {} +

log "Regenerating lockfile for the trimmed workspace (prune)..."
rm -f "$SCRIPT_DIR/bun.lock"
bun install

log "Clean production install (drops build-only devDeps, recreates workspace links)..."
rm -rf "$SCRIPT_DIR/node_modules"
bun install --production

# bun puts workspace-package symlinks in the DEPENDING package's node_modules
# (packages/server/api/node_modules/@activepieces/piece-*), NOT the root — so the
# staging below MUST copy node_modules (an earlier `--exclude node_modules` rsync
# stripped these and the app crashed at boot with "Cannot find module ...piece-*").
for piece in slack square facebook-leads intercom; do
  [ -e "$SCRIPT_DIR/packages/server/api/node_modules/@activepieces/piece-${piece}" ] \
    || die "@activepieces/piece-${piece} not linked after install — the app would crash at boot"
done

# ── 4. Stage the run tree (mirrors the Dockerfile run stage) ─────────────────
log "Staging bundle..."
rm -rf "$STAGE_DIR"; mkdir -p "$STAGE_DIR"
for f in package.json .npmrc bun.lock bunfig.toml LICENSE turbo.json tsconfig.base.json; do
  [ -e "$SCRIPT_DIR/$f" ] && cp "$SCRIPT_DIR/$f" "$STAGE_DIR/$f"
done
log "  - copying packages/ WITH node_modules (carries the api workspace piece links)..."
rsync -a "$SCRIPT_DIR/packages/" "$STAGE_DIR/packages/"
log "  - copying root node_modules (hoisted prod deps)..."
rsync -a "$SCRIPT_DIR/node_modules/" "$STAGE_DIR/node_modules/"
log "  - copying root dist/packages/{web,engine}..."
mkdir -p "$STAGE_DIR/dist/packages"
cp -R "$SCRIPT_DIR/dist/packages/web"    "$STAGE_DIR/dist/packages/web"
cp -R "$SCRIPT_DIR/dist/packages/engine" "$STAGE_DIR/dist/packages/engine"

# Fail fast if the 4 api-imported pieces did not survive staging (the boot-crash).
for piece in slack square facebook-leads intercom; do
  [ -e "$STAGE_DIR/packages/server/api/node_modules/@activepieces/piece-${piece}" ] \
    || die "workspace piece @activepieces/piece-${piece} missing in stage — the app would crash at boot"
done
log "  - verified the 4 workspace piece links are present in the stage"

# ── 5. Embed the Node + Bun runtimes ─────────────────────────────────────────
log "  - embedding Node ${NODE_VERSION} + Bun ${BUN_VERSION} runtimes..."
mkdir -p "$STAGE_DIR/runtime"
cp -R "$NODE_LOCAL_DIR" "$STAGE_DIR/runtime/node"
chmod +x "$STAGE_DIR/runtime/node/bin/node"
mkdir -p "$STAGE_DIR/runtime/bun"
cp "$BUN_LOCAL_DIR/bun" "$STAGE_DIR/runtime/bun/bun"
chmod +x "$STAGE_DIR/runtime/bun/bun"

# Embed the ephemeral-redis binary. Activepieces' MEMORY queue spawns redis via
# redis-memory-server, which otherwise downloads the binary on first boot (network
# dependency, wiped on every update, ECONNREFUSED until it lands). Fetch it once at
# build time (redis-memory-server downloads to node_modules/.cache) and embed it;
# launch.mjs sets REDISMS_SYSTEM_BINARY to it so the runtime never downloads.
log "  - embedding redis binary (redis-memory-server systemBinary)..."
REDIS_BIN=$(find "$STAGE_DIR/node_modules/.cache/redis-memory-server" -name redis-server -type f 2>/dev/null | head -1)
if [ -z "$REDIS_BIN" ]; then
  ( cd "$STAGE_DIR" && "$NODE_LOCAL_DIR/bin/node" -e "const {RedisMemoryServer}=require('redis-memory-server');(async()=>{const s=new RedisMemoryServer();await s.start();await s.stop();})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})" )
  REDIS_BIN=$(find "$STAGE_DIR/node_modules/.cache/redis-memory-server" -name redis-server -type f | head -1)
fi
[ -n "$REDIS_BIN" ] || die "could not obtain a redis-server binary (redis-memory-server download failed)"
mkdir -p "$STAGE_DIR/runtime/redis"
cp "$REDIS_BIN" "$STAGE_DIR/runtime/redis/redis-server"
chmod +x "$STAGE_DIR/runtime/redis/redis-server"
rm -rf "$STAGE_DIR/node_modules/.cache/redis-memory-server"

# ── 6. Launcher + manifest + web-kind placeholder ────────────────────────────
log "  - copying launch.mjs + writing manifest.json..."
cp "$SCRIPT_DIR/launch.mjs" "$STAGE_DIR/launch.mjs"

cat > "$STAGE_DIR/manifest.json" <<EOF
{
  "slug": "activepieces",
  "version": "${BUNDLE_VERSION}",
  "name": "Activepieces",
  "sdkVersion": "1.1.0",
  "kind": "node-service",
  "service": {
    "command": "runtime/node/bin/node",
    "args": ["launch.mjs"],
    "workingDir": ".",
    "healthPath": "/api/v1/health",
    "readyTimeoutMs": 180000,
    "env": {
      "NODE_ENV": "production"
    }
  }
}
EOF

# Placeholder so an older host opening this bundle in web-kind iframe-fallback mode
# shows a useful message instead of a blank frame.
cat > "$STAGE_DIR/index.html" <<'EOF'
<!doctype html><meta charset="utf-8"><title>Activepieces</title>
<p style="font-family:system-ui;padding:24px">Activepieces requires the node-service runtime. Please update the host app.</p>
EOF

# ── 7. Normalize escaping symlinks (bun workspace self-links) ─────────────────
log "  - normalizing escaping symlinks..."
node "$SCRIPT_DIR/normalize-symlinks.mjs" "$STAGE_DIR"

# ── 8. Zip (preserve symlinks) ───────────────────────────────────────────────
log "Packaging zip (preserving symlinks)..."
rm -f "$OUT_ZIP"
( cd "$STAGE_DIR" && zip -qry "$OUT_ZIP" . )

SIZE_BYTES=$(wc -c < "$OUT_ZIP" | tr -d ' ')
SHA256=$(shasum -a 256 "$OUT_ZIP" | awk '{print $1}')

log "✓ Bundle ready: $OUT_ZIP"
log "  size:   ${SIZE_BYTES} bytes"
log "  sha256: ${SHA256}"
log "  version: ${BUNDLE_VERSION}"
echo
echo "Desktop 'Local' install reads this in-repo bundle via apps.js localUrl:"
echo "    file://\${DEMO_BUNDLES_DIR}/apps/activepieces/activepieces-bundle-${NODE_PLATFORM}.zip"
echo
echo "For a published/remote release, paste into UnifiedApp apps/desktop/src/data/apps.js bundle:"
echo "    version: '${BUNDLE_VERSION}',"
echo "    sha256: '${SHA256}',"
echo "    sizeBytes: ${SIZE_BYTES},"
