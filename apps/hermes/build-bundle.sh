#!/usr/bin/env bash
# Build a self-contained Hermes Web UI bundle (node-service kind) installable by
# the UnifiedApp marketplace. Mirrors open-design/build-bundle.sh and
# vibe-trading/build-bundle.sh, but embeds a relocatable CPython instead of Node
# and has NO frontend build step (Hermes WebUI is vanilla JS — "no build step, no
# bundler", README.md) so static/ ships as-is:
#
#   - downloads a relocatable CPython (python-build-standalone, "install_only")
#   - pip-installs the (tiny) Python deps INTO the embedded interpreter
#   - stages server.py + api/ + static/ + launch.py + runtime/python at bundle root
#   - bakes api/_version.py (the bundle has no .git for `git describe`)
#   - writes manifest.json (kind: node-service, command: runtime/python/bin/python3)
#   - normalizes symlinks so none escape the bundle root (installer guard), zips it
#
# Output: ./hermes-webui-bundle-${NODE_PLATFORM}.zip  (+ printed sha256/bytes for apps.js)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_DIR="$SCRIPT_DIR/.bundle-build"
STAGE_DIR="$BUILD_DIR/stage"
# Tracks the upstream Hermes WebUI release this bundle was cut from (git tag v0.51.247).
BUNDLE_VERSION="${BUNDLE_VERSION:-0.51.247}"

# Marketplace platform key (from the desktop's `platform_key` command).
NODE_PLATFORM="${NODE_PLATFORM:-darwin-arm64}"

# python-build-standalone: pick the matching "install_only" asset for the target.
# Bump PBS_RELEASE / PY_VERSION to the latest tag for your platform if the pin 404s.
PBS_RELEASE="${PBS_RELEASE:-20241016}"
PY_VERSION="${PY_VERSION:-3.12.7}"
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

OUT_ZIP="$SCRIPT_DIR/hermes-webui-bundle-${NODE_PLATFORM}.zip"
# OUT_ZIP lives in this app dir — exactly where the desktop "Local" install
# resolves it: apps.js localUrl = file://${DEMO_BUNDLES_DIR}/apps/hermes/<zip>.

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

# ── 2. Stage the bundle tree ─────────────────────────────────────────────────
log "Staging bundle..."
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# 2a. Embed the relocatable interpreter.
log "  - embedding CPython runtime..."
mkdir -p "$STAGE_DIR/runtime"
cp -R "$PY_LOCAL_DIR" "$STAGE_DIR/runtime/python"
chmod +x "$STAGE_DIR/runtime/python/bin/"python3* 2>/dev/null || true
STAGE_PYBIN="$STAGE_DIR/runtime/python/bin/python3"

# 2b. Install third-party deps INTO the embedded interpreter (pyyaml + cryptography;
# cryptography ships a prebuilt wheel for macOS/Linux so no compiler is needed). The
# app source itself is NOT pip-installed — launch.py runs server.py from the tree.
log "  - installing Python deps into the embedded runtime..."
"$STAGE_PYBIN" -m pip install --no-cache-dir --upgrade pip wheel >/dev/null
"$STAGE_PYBIN" -m pip install --no-cache-dir -r "$SCRIPT_DIR/requirements.txt"

# 2b-agent. Fat co-bundle: ship the Hermes Agent so chat works on install. Install its
# runtime deps INTO the embedded interpreter (the WebUI imports `run_agent` in-process)
# and stage the agent source; launch.py points HERMES_WEBUI_AGENT_DIR at it. Set
# INCLUDE_AGENT=0 to build the lean UI-only bundle instead.
INCLUDE_AGENT="${INCLUDE_AGENT:-1}"
AGENT_REPO="${AGENT_REPO:-https://github.com/NousResearch/hermes-agent.git}"
AGENT_SRC="$BUILD_DIR/hermes-agent"
if [ "$INCLUDE_AGENT" = "1" ]; then
  if [ ! -f "$AGENT_SRC/run_agent.py" ]; then
    log "  - cloning Hermes Agent (shallow)..."
    rm -rf "$AGENT_SRC"
    git clone --depth 1 "$AGENT_REPO" "$AGENT_SRC" >/dev/null 2>&1 || die "agent clone failed: $AGENT_REPO"
  fi
  AGENT_SHA="$(git -C "$AGENT_SRC" rev-parse HEAD 2>/dev/null || echo unknown)"
  AGENT_VER="$(grep -m1 -E '^version = ' "$AGENT_SRC/pyproject.toml" | sed -E 's/.*"([^"]+)".*/\1/' || echo unknown)"
  log "  - installing Hermes Agent runtime deps (v${AGENT_VER}, sha ${AGENT_SHA:0:12}) into embedded python..."
  # Install ONLY the project's runtime dependencies (not the package itself, which would
  # also copy its skills/ data_files into the prefix). The agent's own modules load from
  # the staged source dir on sys.path (HERMES_WEBUI_AGENT_DIR), exactly like a dev checkout.
  "$STAGE_PYBIN" - "$AGENT_SRC/pyproject.toml" > "$BUILD_DIR/agent-reqs.txt" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as f:
    data = tomllib.load(f)
for dep in data.get("project", {}).get("dependencies", []):
    print(dep)
PY
  "$STAGE_PYBIN" -m pip install --no-cache-dir -r "$BUILD_DIR/agent-reqs.txt"
  log "  - staging Hermes Agent source (trimmed)..."
  mkdir -p "$STAGE_DIR/hermes-agent"
  # NOTE: leading '/' anchors each exclude to the agent root. An UNANCHORED name
  # (e.g. 'web/') would match at ANY depth and wrongly strip needed subpackages like
  # plugins/web/ (breaks tools.web_tools). Only the hygiene patterns stay unanchored.
  rsync -a \
    --exclude '.git/' --exclude '__pycache__/' --exclude '*.pyc' \
    --exclude '.venv/' --exclude 'venv/' --exclude 'node_modules/' \
    --exclude '/tests/' --exclude '/docs/' --exclude '/website/' --exclude '/web/' \
    --exclude '/ui-tui/' --exclude '/tui_gateway/' --exclude '/datagen-config-examples/' \
    --exclude '/infographic/' --exclude '/nix/' --exclude '/packaging/' --exclude '/plans/' \
    --exclude '/.github/' \
    "$AGENT_SRC/" "$STAGE_DIR/hermes-agent/"
  printf '%s\n' "$AGENT_SHA" > "$STAGE_DIR/hermes-agent/.bundled-sha"
else
  log "  - INCLUDE_AGENT=0 → lean UI-only bundle (no Hermes Agent; chat needs an external agent)"
fi

# 2b-sdk. Refresh the vendored uni-sdk browser bundle that powers the model picker
# (Unified catalog + brand logos), if the sibling uni-sdk repo + bun are available.
# Otherwise the committed static/vendor/unified-sdk.js is used as-is.
UNI_SDK_DIR="${UNI_SDK_DIR:-$SCRIPT_DIR/../../../uni-sdk}"
if [ -f "$UNI_SDK_DIR/src/core/client.ts" ] && command -v bun >/dev/null 2>&1; then
  log "  - rebuilding vendored uni-sdk browser bundle (model picker)..."
  mkdir -p "$SCRIPT_DIR/static/vendor"
  cat > "$UNI_SDK_DIR/.hermes-picker-entry.ts" <<'TS'
export { UnifiedAI } from "./src/core/client";
export { getModelLogo, getProviderLogo, listProviderLogos } from "./src/resources/logos";
TS
  ( cd "$UNI_SDK_DIR" && bun build .hermes-picker-entry.ts --target browser --format esm --minify \
      --outfile "$SCRIPT_DIR/static/vendor/unified-sdk.js" ) \
    || log "  (uni-sdk rebuild failed; using committed static/vendor/unified-sdk.js)"
  rm -f "$UNI_SDK_DIR/.hermes-picker-entry.ts"
fi
[ -f "$SCRIPT_DIR/static/vendor/unified-sdk.js" ] || die "missing static/vendor/unified-sdk.js (uni-sdk picker bundle)"

# 2c. App source. Hermes WebUI's runtime surface is just server.py + api/ + static/
# (api/config.py: REPO_ROOT = api/.. ; _INDEX_HTML_PATH = REPO_ROOT/static/index.html).
log "  - copying server.py + api/ + static/..."
cp "$SCRIPT_DIR/server.py" "$STAGE_DIR/server.py"
mkdir -p "$STAGE_DIR/api" "$STAGE_DIR/static"
rsync -a --exclude '__pycache__/' --exclude '*.pyc' "$SCRIPT_DIR/api/" "$STAGE_DIR/api/"
rsync -a --exclude '__pycache__/' --exclude '*.pyc' "$SCRIPT_DIR/static/" "$STAGE_DIR/static/"
# License for redistribution.
[ -f "$SCRIPT_DIR/LICENSE" ] && cp "$SCRIPT_DIR/LICENSE" "$STAGE_DIR/LICENSE" || true

# 2d. Bake the version. The bundle has no .git, so api/updates.py's `git describe`
# returns None and falls back to api/_version.py (api/updates.py ~226-246).
log "  - baking api/_version.py (${BUNDLE_VERSION})..."
cat > "$STAGE_DIR/api/_version.py" <<EOF
# Generated by build-bundle.sh — version baked in for the .git-less marketplace bundle.
__version__ = 'v${BUNDLE_VERSION}'
EOF

# 2e. Service launcher.
cp "$SCRIPT_DIR/launch.py" "$STAGE_DIR/launch.py"

# 2f. Manifest (node-service kind, consumed by Tauri desktop_core/service.rs). Hermes's
# imports are light (stdlib + pyyaml), so the default 30s readiness window is plenty;
# 45s leaves headroom for a cold filesystem. healthPath /health returns 200 without an
# agent (shallow check = streams-lock heartbeat; only /health?deep=1 probes the agent).
log "  - writing manifest.json..."
cat > "$STAGE_DIR/manifest.json" <<EOF
{
  "slug": "hermes",
  "version": "${BUNDLE_VERSION}",
  "name": "Hermes Web UI",
  "kind": "node-service",
  "service": {
    "command": "runtime/python/bin/python3",
    "args": ["launch.py"],
    "workingDir": ".",
    "healthPath": "/health",
    "readyTimeoutMs": 90000,
    "env": {
      "PYTHONUNBUFFERED": "1",
      "PYTHONDONTWRITEBYTECODE": "1",
      "NO_OPEN": "1",
      "HERMES_WEBUI_AUTO_INSTALL": "0"
    }
  }
}
EOF

# 2g. Placeholder index.html so an older host's web-kind safety check still passes.
# (The real UI is served by the service from static/index.html.)
cat > "$STAGE_DIR/index.html" <<'EOF'
<!doctype html><meta charset="utf-8"><title>Hermes Web UI</title>
<p style="font-family:system-ui;padding:24px">Hermes Web UI requires the node-service runtime. Please update the host app.</p>
EOF

# 2h. Clamp any symlink whose target escapes the bundle root. python-build-standalone
# is symlink-light (bin/python3 → python3.12 and a few internal lib links), but the
# UnifiedApp installer rejects the whole archive on a single escaping symlink.
log "  - normalizing symlinks..."
node "$SCRIPT_DIR/normalize-symlinks.mjs" "$STAGE_DIR"

# ── 3. Zip (preserve symlinks) ───────────────────────────────────────────────
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
echo "    url: '<published-release-url>/hermes-webui-bundle-${NODE_PLATFORM}.zip',"
echo "    localUrl: 'file://\${DEMO_BUNDLES_DIR}/apps/hermes/hermes-webui-bundle-${NODE_PLATFORM}.zip',"
echo "    version: '${BUNDLE_VERSION}',"
echo "    sha256: '${SHA256}',"
echo "    sizeBytes: ${SIZE_BYTES},"
