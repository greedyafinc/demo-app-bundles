#!/usr/bin/env bash
# Build a self-contained Vibe-Trading bundle (node-service kind) installable by
# the UnifiedApp marketplace. Mirrors open-design/build-bundle.sh, but embeds a
# relocatable CPython instead of Node:
#
#   - downloads a relocatable CPython (python-build-standalone, "install_only")
#   - builds the React/Vite frontend to frontend/dist (served same-origin)
#   - pip-installs all Python deps INTO the embedded interpreter
#   - stages agent/ + frontend/dist + launch.py + runtime/python
#   - writes manifest.json (kind: node-service, command: runtime/python/bin/python3)
#   - normalizes symlinks so none escape the bundle root (installer guard), zips it
#
# Output: ./vibe-trading-bundle-${NODE_PLATFORM}.zip  (+ printed sha256/bytes for apps.js)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_DIR="$SCRIPT_DIR/.bundle-build"
STAGE_DIR="$BUILD_DIR/stage"
BUNDLE_VERSION="0.1.9"

# Marketplace platform key (from the desktop's `platform_key` command).
NODE_PLATFORM="${NODE_PLATFORM:-darwin-arm64}"

# python-build-standalone: pick the matching "install_only" asset for the target.
# Bump PBS_RELEASE / PY_VERSION to the latest tag for your platform as needed.
PBS_RELEASE="${PBS_RELEASE:-20241016}"
PY_VERSION="${PY_VERSION:-3.11.10}"
case "$NODE_PLATFORM" in
  darwin-arm64) PBS_TRIPLE="aarch64-apple-darwin" ;;
  darwin-x64)   PBS_TRIPLE="x86_64-apple-darwin" ;;
  linux-x64)    PBS_TRIPLE="x86_64-unknown-linux-gnu" ;;
  linux-arm64)  PBS_TRIPLE="aarch64-unknown-linux-gnu" ;;
  *) echo "Unsupported NODE_PLATFORM: $NODE_PLATFORM" >&2; exit 1 ;;
esac
PBS_ASSET="cpython-${PY_VERSION}+${PBS_RELEASE}-${PBS_TRIPLE}-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${PBS_ASSET}"
PY_LOCAL_DIR="$BUILD_DIR/python-${PY_VERSION}-${PBS_TRIPLE}"

OUT_ZIP="$SCRIPT_DIR/vibe-trading-bundle-${NODE_PLATFORM}.zip"
# OUT_ZIP lives in this app dir — exactly where the desktop "Local" install
# resolves it: apps.js localUrl = file://${DEMO_BUNDLES_DIR}/apps/vibe-trading/<zip>.

log() { printf "\033[1;36m[bundle]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[bundle]\033[0m %s\n" "$*" >&2; exit 1; }

mkdir -p "$BUILD_DIR"

# ── 1. Download + unpack relocatable CPython (cached) ─────────────────────────
if [ ! -x "$PY_LOCAL_DIR/bin/python3" ]; then
  log "Downloading CPython ${PY_VERSION} (${PBS_TRIPLE})..."
  curl -fL --retry 3 -o "$BUILD_DIR/$PBS_ASSET" "$PBS_URL" \
    || die "download failed: $PBS_URL (bump PBS_RELEASE/PY_VERSION to a valid install_only asset)"
  log "Unpacking..."
  rm -rf "$PY_LOCAL_DIR"
  mkdir -p "$PY_LOCAL_DIR"
  # install_only tarballs extract to a top-level ``python/`` dir.
  tar -xzf "$BUILD_DIR/$PBS_ASSET" -C "$PY_LOCAL_DIR" --strip-components=1
fi
PYBIN="$PY_LOCAL_DIR/bin/python3"
[ -x "$PYBIN" ] || die "no python at $PYBIN"
log "Python $($PYBIN --version)"

# ── 2. Build the frontend (Vite static build → frontend/dist) ────────────────
log "Building frontend (npm ci + npm run build)..."
( cd "$SCRIPT_DIR/frontend" && npm ci --ignore-scripts && npm run build )
[ -d "$SCRIPT_DIR/frontend/dist" ] || die "frontend build did not produce frontend/dist"

# ── 3. Stage the bundle tree ─────────────────────────────────────────────────
log "Staging bundle..."
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# 3a. Embed the relocatable interpreter.
log "  - embedding CPython runtime..."
mkdir -p "$STAGE_DIR/runtime"
cp -R "$PY_LOCAL_DIR" "$STAGE_DIR/runtime/python"
chmod +x "$STAGE_DIR/runtime/python/bin/"python3* 2>/dev/null || true
STAGE_PYBIN="$STAGE_DIR/runtime/python/bin/python3"

# 3b. Install all third-party deps INTO the embedded interpreter (target-platform
# wheels). The app source itself is NOT installed — launch.py puts agent/ on
# sys.path so the tree stays relocatable.
log "  - installing Python deps into the embedded runtime (this can take a while)..."
"$STAGE_PYBIN" -m pip install --no-cache-dir --upgrade pip wheel >/dev/null
"$STAGE_PYBIN" -m pip install --no-cache-dir -r "$SCRIPT_DIR/agent/requirements.txt"

# 3c. App source (exclude tests, caches, local runtime data, secrets).
log "  - copying agent/ source..."
mkdir -p "$STAGE_DIR/agent"
rsync -a \
  --exclude '.env' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude 'tests/' \
  --exclude 'runs/' \
  --exclude 'sessions/' \
  --exclude 'uploads/' \
  --exclude '.swarm/' \
  "$SCRIPT_DIR/agent/" "$STAGE_DIR/agent/"

# 3d. Prebuilt frontend (served same-origin by api_server in prod mode).
log "  - copying frontend/dist..."
mkdir -p "$STAGE_DIR/frontend"
cp -R "$SCRIPT_DIR/frontend/dist" "$STAGE_DIR/frontend/dist"

# 3e. Service launcher.
cp "$SCRIPT_DIR/launch.py" "$STAGE_DIR/launch.py"

# 3f. Manifest (node-service kind, consumed by Tauri desktop_core/service.rs).
# readyTimeoutMs is generous: the first import pulls pandas/scipy/sklearn/langchain.
log "  - writing manifest.json..."
cat > "$STAGE_DIR/manifest.json" <<EOF
{
  "slug": "vibe-trading",
  "version": "${BUNDLE_VERSION}",
  "name": "Vibe-Trading",
  "kind": "node-service",
  "service": {
    "command": "runtime/python/bin/python3",
    "args": ["launch.py"],
    "workingDir": ".",
    "healthPath": "/health",
    "readyTimeoutMs": 90000,
    "env": {
      "PYTHONUNBUFFERED": "1",
      "PYTHONDONTWRITEBYTECODE": "1"
    }
  }
}
EOF

# 3g. Placeholder index.html so an older host's web-kind safety check still passes.
cat > "$STAGE_DIR/index.html" <<'EOF'
<!doctype html><meta charset="utf-8"><title>Vibe-Trading</title>
<p style="font-family:system-ui;padding:24px">Vibe-Trading requires the node-service runtime. Please update the host app.</p>
EOF

# 3h. Clamp any symlink whose target escapes the bundle root. python-build-standalone
# is symlink-light, but bin/python3 → python3.11 and a few lib links exist; the
# UnifiedApp installer rejects the whole archive on an escaping symlink.
log "  - normalizing symlinks..."
node "$SCRIPT_DIR/normalize-symlinks.mjs" "$STAGE_DIR"

# ── 4. Zip (preserve symlinks) ───────────────────────────────────────────────
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
echo "    url: '<published-release-url>/vibe-trading-bundle-${NODE_PLATFORM}.zip',"
echo "    localUrl: 'file://\${DEMO_BUNDLES_DIR}/apps/vibe-trading/vibe-trading-bundle-${NODE_PLATFORM}.zip',"
echo "    version: '${BUNDLE_VERSION}',"
echo "    sha256: '${SHA256}',"
echo "    sizeBytes: ${SIZE_BYTES},"
