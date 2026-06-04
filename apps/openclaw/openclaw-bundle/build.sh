#!/usr/bin/env bash
# Build the OpenClaw marketplace bundle for a specific OS/arch target.
# Produces /tmp/openclaw-bundle-${NODE_PLATFORM}.zip with sha256 + size.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_SRC="$SCRIPT_DIR/../openclaw"
BUNDLE_DIR="$SCRIPT_DIR"

# Platform/arch are parameterized so other targets (darwin-x64, win32-x64,
# linux-x64) can be enabled later without rewriting the script. Today we only
# ship darwin-arm64; override via env to test other targets.
NODE_VERSION="${NODE_VERSION:-v24.0.0}"
NODE_PLATFORM="${NODE_PLATFORM:-darwin-arm64}"
OUT="/tmp/openclaw-bundle-${NODE_PLATFORM}.zip"
NODE_TARBALL="node-${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"

# ── 1. Build OpenClaw ──────────────────────────────────────────────────────

echo "==> Building OpenClaw from source…"
cd "$OPENCLAW_SRC"

if command -v pnpm &>/dev/null; then
  PNPM="pnpm"
elif command -v bun &>/dev/null; then
  PNPM="bun"
else
  PNPM="npx pnpm"
fi

echo "    Using $PNPM for install…"
$PNPM install 2>&1 | tail -5

# Build always needs pnpm for some steps (plugin asset scripts)
if command -v pnpm &>/dev/null; then
  pnpm build 2>&1 | tail -5
else
  npx pnpm build 2>&1 | tail -5
fi
echo "    ✓ OpenClaw built"

# ── 2. Stage built artifacts ───────────────────────────────────────────────

echo "==> Staging openclaw/ into bundle…"
DEST="$BUNDLE_DIR/openclaw"
rm -rf "$DEST"
mkdir -p "$DEST"

# Copy entry, dist, package.json
cp "$OPENCLAW_SRC/openclaw.mjs" "$DEST/"
cp "$OPENCLAW_SRC/package.json" "$DEST/"
rsync -a "$OPENCLAW_SRC/dist/" "$DEST/dist/"

# Copy node_modules with symlinks flattened (pnpm uses symlinks)
rsync -aL "$OPENCLAW_SRC/node_modules/" "$DEST/node_modules/"

# Drop the .pnpm store — it's huge and redundant after flattening
rm -rf "$DEST/node_modules/.pnpm"

# Copy docs/ and patches/ if present (OpenClaw references them)
[ -d "$OPENCLAW_SRC/docs" ] && rsync -a "$OPENCLAW_SRC/docs/" "$DEST/docs/"
[ -d "$OPENCLAW_SRC/patches" ] && rsync -a "$OPENCLAW_SRC/patches/" "$DEST/patches/"
[ -d "$OPENCLAW_SRC/skills" ] && rsync -a "$OPENCLAW_SRC/skills/" "$DEST/skills/"
[ -d "$OPENCLAW_SRC/scripts" ] && rsync -a "$OPENCLAW_SRC/scripts/" "$DEST/scripts/"

# Patch CSP frame-ancestors and X-Frame-Options to allow Tauri iframe embedding.
# Glob targets the server module (control-ui-BVjRAYrm.js, etc). Hashes in the
# filename change every build, so we glob and post-verify rather than name
# explicitly.
# Restrict frame-ancestors to Tauri origins only (not wildcard). The desktop
# WebView loads from tauri://localhost on macOS; the http/https variants cover
# Tauri's WebKit2GTK and WebView2 fallbacks. Add more origins here if other
# Tauri platforms are enabled later.
# Tauri webview origins across dev/prod + platform variants:
#   tauri://localhost          — macOS production
#   http(s)://tauri.localhost  — WebView2/WebKit2GTK production
#   http://localhost:1420      — Tauri dev (devUrl in tauri.conf.json)
#   http://localhost           — some Windows/Linux webviews report no port
FA_TARGETS="tauri://localhost http://tauri.localhost https://tauri.localhost http://localhost:1420 http://localhost"
CSP_PATCHED=0
XFO_PATCHED=0
for f in "$DEST"/dist/control-ui-*.js; do
  [ -f "$f" ] || continue
  sed -i '' "s|frame-ancestors 'none'|frame-ancestors $FA_TARGETS|g" "$f"
  # Re-patch a prior wildcard rewrite back to the narrow origin list, so
  # rebuilds after a wildcard hotfix self-correct.
  sed -i '' "s|frame-ancestors \*|frame-ancestors $FA_TARGETS|g" "$f"
  sed -i '' 's/res.setHeader("X-Frame-Options", "DENY")/res.setHeader("X-Frame-Options", "SAMEORIGIN")/g' "$f"
done
# Post-sed assertion: silent no-op = build failure. Catches upstream renames.
if grep -q "frame-ancestors tauri" "$DEST"/dist/control-ui-*.js 2>/dev/null; then CSP_PATCHED=1; fi
if grep -q 'X-Frame-Options", "SAMEORIGIN' "$DEST"/dist/control-ui-*.js 2>/dev/null; then XFO_PATCHED=1; fi
if [ "$CSP_PATCHED" -eq 0 ] || [ "$XFO_PATCHED" -eq 0 ]; then
  echo "    ✗ CSP/X-Frame-Options patch failed (CSP=$CSP_PATCHED XFO=$XFO_PATCHED) — upstream may have renamed the source. Update the sed patterns in build.sh." >&2
  exit 1
fi
echo "    ✓ CSP frame-ancestors and X-Frame-Options patched for Tauri embedding"

# Scrub gateway token from URL after control-ui boots so it doesn't linger in
# devtools history. control-ui reads location.hash synchronously during module
# init, so we delay the scrub past that.
HTML_FILE="$DEST/dist/control-ui/index.html"
if [ -f "$HTML_FILE" ] && ! grep -q "unified-token-scrub" "$HTML_FILE"; then
  SCRUB_TAG='<script>/*unified-token-scrub*/setTimeout(function(){try{if(location.hash.indexOf("token=")>=0)history.replaceState(null,"",location.pathname+location.search);}catch(e){}},800);</script>'
  # macOS sed: insert before </head>
  awk -v tag="$SCRUB_TAG" '{ gsub("</head>", tag "</head>"); print }' "$HTML_FILE" > "$HTML_FILE.tmp" && mv "$HTML_FILE.tmp" "$HTML_FILE"
  if ! grep -q "unified-token-scrub" "$HTML_FILE"; then
    echo "    ✗ token-scrub injection failed — </head> not found in $HTML_FILE" >&2
    exit 1
  fi
  echo "    ✓ token-scrub injected into control-ui/index.html"
fi

echo "    ✓ openclaw/ staged ($(du -sh "$DEST" | cut -f1))"

# ── 3. Download Node.js binary ─────────────────────────────────────────────

if [ ! -f "$BUNDLE_DIR/bin/node" ]; then
  echo "==> Downloading Node.js ${NODE_VERSION} (${NODE_PLATFORM})…"
  TMPTAR="/tmp/${NODE_TARBALL}"
  if [ ! -f "$TMPTAR" ]; then
    curl -fSL -o "$TMPTAR" "$NODE_URL"
  fi
  tar -xzf "$TMPTAR" -C /tmp/ "node-${NODE_VERSION}-${NODE_PLATFORM}/bin/node"
  cp "/tmp/node-${NODE_VERSION}-${NODE_PLATFORM}/bin/node" "$BUNDLE_DIR/bin/node"
  chmod +x "$BUNDLE_DIR/bin/node"
  rm -rf "/tmp/node-${NODE_VERSION}-${NODE_PLATFORM}"
  echo "    ✓ bin/node ($(du -sh "$BUNDLE_DIR/bin/node" | cut -f1))"
else
  echo "==> bin/node already present, skipping download"
fi

# ── 4. Copy app-sdk ────────────────────────────────────────────────────────

# In the UnifiedApp workspace this refreshes app-sdk/index.js from the
# @unified/app-sdk source. Built standalone (e.g. from demo-app-bundles) that
# sibling path is absent, so fall back to the committed app-sdk/index.js. Guard
# the cd: an unguarded `cd` in a command substitution fails the assignment and,
# under `set -euo pipefail`, aborts the build before this fallback is reached.
APP_SDK_SRC=""
if [ -d "$SCRIPT_DIR/../../packages/app-sdk/src" ]; then
  APP_SDK_SRC="$(cd "$SCRIPT_DIR/../../packages/app-sdk/src" && pwd)"
fi
if [ -n "$APP_SDK_SRC" ] && [ -f "$APP_SDK_SRC/index.js" ]; then
  cp "$APP_SDK_SRC/index.js" "$BUNDLE_DIR/app-sdk/index.js"
  echo "    ✓ app-sdk refreshed from $APP_SDK_SRC"
elif [ -f "$BUNDLE_DIR/app-sdk/index.js" ]; then
  echo "    ✓ app-sdk: using committed app-sdk/index.js (cross-repo source not present)"
else
  echo "    ✗ app-sdk/index.js missing and no source at $SCRIPT_DIR/../../packages/app-sdk/src" >&2
  exit 1
fi

# ── 5. Zip ─────────────────────────────────────────────────────────────────

echo "==> Creating bundle zip…"
rm -f "$OUT"
cd "$BUNDLE_DIR"
zip -qr "$OUT" \
  manifest.json \
  start.mjs \
  config-template.json \
  bin/node \
  app-sdk/ \
  openclaw/

SIZE=$(wc -c < "$OUT" | tr -d ' ')
SHA=$(shasum -a 256 "$OUT" | cut -d' ' -f1)

# Sidecar manifest so apps.js can be regenerated without hand-editing hashes.
SIDECAR="$BUNDLE_DIR/apps.openclaw.json"
cat > "$SIDECAR" <<EOF
{
  "slug": "openclaw",
  "platform": "${NODE_PLATFORM}",
  "bundle": {
    "version": "1.0.0",
    "sha256": "${SHA}",
    "sizeBytes": ${SIZE}
  }
}
EOF

echo ""
echo "════════════════════════════════════════════════════"
echo "  Bundle:   $OUT"
echo "  Sidecar:  $SIDECAR"
echo "  Platform: $NODE_PLATFORM"
echo "  Size:     $SIZE bytes ($(echo "scale=1; $SIZE/1048576" | bc)M)"
echo "  SHA256:   $SHA"
echo "════════════════════════════════════════════════════"
