#!/usr/bin/env python3
"""UnifiedApp marketplace service entrypoint for Vibe-Trading (`node-service` kind).

The UnifiedApp desktop host (Tauri `desktop_core`) spawns this exactly the way it
spawns OpenDesign's Node daemon — `service.command` is a generic executable, so a
Python interpreter is fine:

    manifest.json:
      "service": {
        "command": "runtime/python/bin/python3",
        "args": ["launch.py"],
        "healthPath": "/health",
        ...
      }

This launcher is the Python analogue of OpenDesign's hand-vendored broker client
(`apps/daemon/src/unified-auth.ts`): it exchanges the loopback broker secret for a
short-lived, app-scoped UnifiedAI token and points Vibe-Trading's OpenAI-compatible
LLM client (langchain-openai) at the Unified gateway. The user's long-lived
credential never reaches this process.

Host-injected env (see desktop_core/src/service.rs + broker.rs):
  OD_PORT                   free port the host allocated — we MUST bind it
  OD_BIND_HOST              127.0.0.1
  OD_DATA_DIR               writable per-app data dir (install root is read-only)
  NO_OPEN                   "1" (the desktop opens the URL itself)
  UNIFIED_APP_SLUG          our marketplace slug ("vibe-trading")
  UNIFIED_BROKER_URL        loopback broker base url        (broker path)
  UNIFIED_BROKER_TOKEN      per-launch shared secret        (x-broker-token header)
  UNIFIED_HOST_TRUST_TOKEN  proof we were started by the trusted host

`UNIFIED_API_URL` is deliberately NOT injected by the host — we default it to the
local dev gateway (loopback:3141, where the desktop runs unified-api) and allow an
override (e.g. https://api.unifiedai.app for a non-dev gateway). This mirrors the
Hermes bundle's launcher.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

BUNDLE_ROOT = Path(__file__).resolve().parent
AGENT_DIR = BUNDLE_ROOT / "agent"
FRONTEND_DIST = BUNDLE_ROOT / "frontend" / "dist"

# Unified gateway, OpenAI-compatible surface mounted under /api/v1 (chat/completions,
# models, embeddings, images, audio). The desktop runs unified-api on loopback:3141 and
# does NOT inject a gateway URL (see the UNIFIED_API_URL note above), so apps default it
# here. Override with UNIFIED_API_URL for a non-dev gateway (e.g. https://api.unifiedai.app).
DEFAULT_UNIFIED_API_HOST = "http://localhost:3141"
# `auto` lets the gateway pick a concrete model; the user can change it in-app
# (Settings → LLM) afterwards. LANGCHAIN_MODEL_NAME is required or build_llm raises.
DEFAULT_MODEL = "auto"


def _log(msg: str) -> None:
    print(f"[vibe-launch] {msg}", flush=True)


def _unified_api_base() -> str:
    """OpenAI-compatible base URL langchain-openai should target."""
    host = (os.environ.get("UNIFIED_API_URL") or DEFAULT_UNIFIED_API_HOST).rstrip("/")
    # Accept either a bare host or one that already includes the /api/v1 suffix.
    return host if host.endswith("/api/v1") else f"{host}/api/v1"


def _broker_coords() -> tuple[str, str]:
    """Current loopback-broker (url, shared-secret).

    Read from OD_DATA_DIR/.broker.json (which the desktop host rewrites on every
    spawn AND reuse) first, falling back to the env injected at spawn time. This is
    what lets a daemon REUSED across a desktop restart — or kept alive by a sibling
    process that has since quit (cross-process shell⇄solo reuse) — keep re-minting
    against the LIVE broker. The broker URL+secret rotate per desktop launch, so a
    reused daemon's *env* coords go stale and minting fails forever ("Connection
    refused" → the app token expires → every model call 401s "Invalid or expired
    JWT"). The host rewrites the file with the live coords, so the next refresh
    self-heals (~30s) without restarting the daemon.
    """
    data_dir = os.environ.get("OD_DATA_DIR", "")
    if data_dir:
        try:
            raw = json.loads((Path(data_dir) / ".broker.json").read_text())
            url = (raw.get("url") or "").rstrip("/")
            tok = raw.get("token") or ""
            if url and tok:
                return url, tok
        except (OSError, ValueError):
            pass  # missing/partial file → fall back to the spawn-time env
    return (
        os.environ.get("UNIFIED_BROKER_URL", "").rstrip("/"),
        os.environ.get("UNIFIED_BROKER_TOKEN", ""),
    )


def _mint_token() -> tuple[str | None, int]:
    """Exchange the broker shared-secret for a short-lived app-scoped token.

    Mirrors desktop_core/src/broker.rs: POST {broker_url}/token with header
    `x-broker-token` and JSON body {"app_slug": slug}. Returns (token, expires_in),
    or (None, 0) when no broker is present (running outside the desktop). Broker
    coords are re-read every call (see `_broker_coords`) so a rotated broker is
    picked up without a restart.
    """
    broker_url, broker_tok = _broker_coords()
    slug = os.environ.get("UNIFIED_APP_SLUG", "vibe-trading")
    if not broker_url or not broker_tok:
        return None, 0
    req = urllib.request.Request(
        f"{broker_url}/token",
        data=json.dumps({"app_slug": slug}).encode(),
        method="POST",
        headers={"content-type": "application/json", "x-broker-token": broker_tok},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        token = data.get("token")
        return (token, int(data.get("expires_in") or 300)) if token else (None, 0)
    except (urllib.error.URLError, ValueError, OSError) as exc:
        _log(f"broker token mint failed: {exc}")
        return None, 0


def _apply_token(token: str) -> None:
    """Point the UnifiedAI provider — and the generic OPENAI_* vars langchain-openai
    actually reads — at the gateway with the freshly minted token."""
    base = _unified_api_base()
    os.environ["UNIFIED_API_BASE_URL"] = base
    os.environ["UNIFIED_API_KEY"] = token
    # llm.py build_llm() re-reads these on every call, so updating them in-process
    # refreshes the token for subsequent agent runs without a restart.
    os.environ["OPENAI_API_KEY"] = token
    os.environ["OPENAI_BASE_URL"] = base
    os.environ["OPENAI_API_BASE"] = base


def _write_host_token(token: str) -> None:
    """The host reads OD_DATA_DIR/.token back after health-check to hand to the
    webview (parity with OpenDesign's `read_app_token`). Best-effort."""
    data_dir = os.environ.get("OD_DATA_DIR", "")
    if not data_dir:
        return
    try:
        d = Path(data_dir)
        d.mkdir(parents=True, exist_ok=True)
        (d / ".token").write_text(token)
    except OSError as exc:
        _log(f"could not write host token file: {exc}")


def _refresh_loop(expires_in: int) -> None:
    """Re-mint the short-lived (~5 min) app token before it expires. Runs in a
    daemon thread sharing this process's os.environ with the FastAPI app."""
    while True:
        time.sleep(max(30, expires_in - 60))
        token, ttl = _mint_token()
        if token:
            _apply_token(token)
            _write_host_token(token)
            expires_in = ttl
            _log("refreshed Unified app token")
        else:
            # Retry soon (sleep floor is 30s) so a rotated broker — written to
            # .broker.json by the host on restart/reuse — is picked up quickly and
            # the daemon stops 401ing. 90 → next sleep max(30, 90-60) = 30s.
            expires_in = 90


def main() -> int:
    # Make the bundle's app source importable WITHOUT a (non-relocatable) editable
    # install — only third-party deps live in the embedded interpreter.
    sys.path.insert(0, str(AGENT_DIR))

    host = os.environ.get("OD_BIND_HOST", "127.0.0.1")
    port = os.environ.get("OD_PORT", "8899")

    # Relocate writable runtime state + locate the prebuilt frontend, since the
    # install tree is read-only. These MUST be set before importing api_server,
    # which resolves them at module import time.
    os.environ.setdefault("VIBE_TRADING_DATA_DIR", os.environ.get("OD_DATA_DIR", str(AGENT_DIR)))
    if FRONTEND_DIST.exists():
        os.environ.setdefault("VIBE_TRADING_FRONTEND_DIST", str(FRONTEND_DIST))
    # Loopback-only FastAPI auth (empty key = dev/loopback mode). The desktop reaches
    # us over loopback and the SPA is served same-origin, so no API key is needed.
    os.environ.setdefault("API_AUTH_KEY", "")
    os.environ["PYTHONUNBUFFERED"] = "1"

    # We were launched by the UnifiedApp desktop host, so the LLM is "managed":
    # the broker supplies the credential and the in-app settings hide the
    # provider/key controls for an OpenDesign-style zero-config experience
    # (api_server._is_managed reads this flag).
    os.environ.setdefault("VIBE_TRADING_MANAGED", "1")
    # Default to the Unified gateway provider. Kept as a default (not a hard set)
    # so someone running this entrypoint by hand can still override via real env.
    os.environ.setdefault("LANGCHAIN_PROVIDER", "unifiedai")
    os.environ.setdefault("LANGCHAIN_MODEL_NAME", DEFAULT_MODEL)
    os.environ.setdefault("UNIFIED_API_BASE_URL", _unified_api_base())

    token, expires_in = _mint_token()
    if token:
        _apply_token(token)
        _write_host_token(token)
        _log(f"acquired Unified app token (expires_in={expires_in}s) via broker")
        threading.Thread(target=_refresh_loop, args=(expires_in,), daemon=True).start()
    else:
        _log("no broker token (running outside UnifiedApp?); LLM creds left to .env / in-app settings")

    _log(f"serving on {host}:{port} (data={os.environ['VIBE_TRADING_DATA_DIR']})")
    from api_server import serve_main  # imported after env is wired

    return serve_main(["--host", host, "--port", str(port)])


if __name__ == "__main__":
    raise SystemExit(main())
