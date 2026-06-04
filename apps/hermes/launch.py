#!/usr/bin/env python3
"""UnifiedApp marketplace service entrypoint for Hermes Web UI (`node-service` kind).

The UnifiedApp desktop host (Tauri `desktop_core`) spawns this exactly the way it
spawns OpenDesign's Node daemon — `service.command` is a generic executable, so an
embedded Python interpreter is fine (see desktop_core/src/service.rs: the command is
run as an arbitrary within-guarded executable, NOT node-only):

    manifest.json:
      "service": {
        "command": "runtime/python/bin/python3",
        "args": ["launch.py"],
        "healthPath": "/health",
        ...
      }

Two jobs:

1. **Env bridge.** Hermes WebUI reads its own `HERMES_WEBUI_*` env (api/config.py);
   the host injects OpenDesign-flavored `OD_*` names. We translate them so the server
   binds the host-allocated port and writes its mutable state under the writable
   per-app data dir (the install tree is read-only).

2. **Gateway auth (best-effort).** Hermes WebUI itself makes NO model calls — it is a
   thin UI over a separate Hermes Agent (run_agent.py), which is what actually calls
   providers. That agent's `openai-api` provider reads the generic `OPENAI_BASE_URL` /
   `OPENAI_API_KEY` (api/config.py ~3686, api/providers.py). So when we run inside the
   desktop we exchange the loopback broker secret for a short-lived, app-scoped
   UnifiedAI token and export those vars: any Hermes Agent this UI spawns then routes
   through the Unified gateway on the user's subscription, never seeing a long-lived
   credential. With no agent present the server still boots and `/health` is green; the
   UI just reports "agent not available" until one is configured.

Host-injected env (see desktop_core/src/service.rs + broker.rs):
  OD_PORT                   free port the host allocated — we MUST bind it
  OD_BIND_HOST              127.0.0.1
  OD_DATA_DIR               writable per-app data dir (install root is read-only)
  NO_OPEN                   "1" (the desktop opens the URL itself)
  UNIFIED_APP_SLUG          our marketplace slug ("hermes")
  UNIFIED_BROKER_URL        loopback broker base url        (broker path)
  UNIFIED_BROKER_TOKEN      per-launch shared secret        (x-broker-token header)
  UNIFIED_HOST_TRUST_TOKEN  proof we were started by the trusted host

`UNIFIED_API_URL` is deliberately NOT injected by the host — we default it to the
production gateway and allow an override (e.g. http://localhost:3141 in dev).
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

BUNDLE_ROOT = Path(__file__).resolve().parent
# Present only in the "fat" co-bundle (build-bundle.sh INCLUDE_AGENT=1): the full
# NousResearch/hermes-agent checkout, with its deps installed into runtime/python.
AGENT_DIR = BUNDLE_ROOT / "hermes-agent"

# Unified gateway, OpenAI-compatible surface mounted under /api/v1 (chat/completions,
# responses, models, ...). Default matches OpenDesign's daemon (apps/daemon/src/unified-auth.ts:
# `process.env.UNIFIED_API_URL || 'http://localhost:3141'`) — the desktop runs unified-api on
# loopback:3141 and does NOT inject a gateway URL, so apps default it. Override with
# UNIFIED_API_URL for a non-dev gateway (e.g. https://api.unifiedai.app).
DEFAULT_UNIFIED_API_HOST = "http://localhost:3141"
# Sentinel marking a config.yaml WE seeded — lets us self-heal a stale gateway base_url
# (e.g. after a dev↔prod switch) without touching a config the user has taken over.
_MANAGED_SENTINEL = "unified-managed-gateway"
# Default model the bundled agent chats with out of the box. A CONCRETE catalog id
# (not "auto"): hermes resolves capabilities from the model id, and unified-api's `auto`
# is currently a fixed stub. Override with UNIFIED_DEFAULT_MODEL. The user can switch
# models in-app afterward (Settings → LLM, list populated from the gateway).
DEFAULT_GATEWAY_MODEL = "gpt-5.4"


def _log(msg: str) -> None:
    print(f"[hermes-launch] {msg}", flush=True)


def _unified_api_base() -> str:
    """OpenAI-compatible base URL the Hermes Agent's openai-api provider should target."""
    host = (os.environ.get("UNIFIED_API_URL") or DEFAULT_UNIFIED_API_HOST).rstrip("/")
    # Accept either a bare host or one that already includes the /api/v1 suffix.
    return host if host.endswith("/api/v1") else f"{host}/api/v1"


def _mint_token() -> tuple[str | None, int]:
    """Exchange the broker shared-secret for a short-lived app-scoped token.

    Mirrors desktop_core/src/broker.rs: POST {UNIFIED_BROKER_URL}/token with header
    `x-broker-token` and JSON body {"app_slug": slug}. Returns (token, expires_in),
    or (None, 0) when no broker is present (running outside the desktop).
    """
    broker_url = os.environ.get("UNIFIED_BROKER_URL", "").rstrip("/")
    broker_tok = os.environ.get("UNIFIED_BROKER_TOKEN", "")
    slug = os.environ.get("UNIFIED_APP_SLUG", "hermes")
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
    """Point the Hermes Agent's openai-api provider at the gateway with the minted
    token. The agent re-reads these per provider build, so updating them in-process
    refreshes credentials for subsequent agent runs without a restart."""
    base = _unified_api_base()
    os.environ["UNIFIED_API_BASE_URL"] = base
    os.environ["UNIFIED_API_KEY"] = token
    os.environ["OPENAI_API_KEY"] = token
    os.environ["OPENAI_BASE_URL"] = base
    os.environ["OPENAI_API_BASE"] = base


def _write_host_token(token: str) -> None:
    """The host may read OD_DATA_DIR/.token back after the health-check to hand to the
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


def _wire_bundled_agent(data_dir: str) -> Path | None:
    """If the Hermes Agent is co-bundled, point the WebUI at it. Returns the writable
    HERMES_HOME path (used later to seed gateway config), or None if no agent is present.

    - HERMES_WEBUI_AGENT_DIR → the bundled checkout (api/config.py `_discover_agent_dir`
      honors this first and appends it to sys.path so `from run_agent import AIAgent`
      resolves; the agent's deps are already installed in runtime/python by build-bundle.sh).
    - HERMES_HOME → a writable dir under the host's per-app data dir (the install tree is
      read-only; the agent writes config/skills-state here).
    """
    if not (AGENT_DIR / "run_agent.py").exists():
        return None
    os.environ.setdefault("HERMES_WEBUI_AGENT_DIR", str(AGENT_DIR))
    hermes_home = Path(data_dir) / "hermes"
    os.environ.setdefault("HERMES_HOME", str(hermes_home))
    try:
        hermes_home.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        _log(f"could not create HERMES_HOME: {exc}")
    _log(f"bundled Hermes Agent wired (dir={AGENT_DIR}, home={hermes_home})")
    return hermes_home


def _seed_gateway_config(hermes_home: Path) -> None:
    """Make the bundled agent chat through the Unified gateway out of the box — the
    Hermes analogue of OpenDesign's seamless `auto` experience.

    We register a first-class `custom` provider named "Unified" pointing at the gateway's
    OpenAI-compatible surface. Custom providers use the `openai_chat` transport
    (hermes_cli/providers.py default) → POST {base}/chat/completions, the same battle-tested
    endpoint OpenDesign uses, and (unlike `openai-api`'s `codex_responses`/`/responses`
    transport) it accepts `auto` so the gateway auto-routes the model. The api_key is read
    from env `${UNIFIED_API_KEY}` at REQUEST time (api/config.py `resolve_custom_provider_connection`
    supports the `${ENV}` form), so the launcher's ~5-min token-refresh loop keeps it fresh
    without rewriting this file. We only seed when running inside UnifiedApp (a broker token
    was minted); standalone installs fall through to the WebUI's normal onboarding.

    Idempotent: never overwrites an existing config.yaml (respects a user's own choices).
    """
    cfg = hermes_home / "config.yaml"
    base = _unified_api_base()
    model = os.environ.get("UNIFIED_DEFAULT_MODEL", "").strip() or DEFAULT_GATEWAY_MODEL

    # Self-heal: if we already seeded this config but the gateway base_url is stale (the
    # #1 "stuck on loading" cause — a WebUI model/onboarding probe hangs on an unreachable
    # gateway), correct just the base_url line(s) and leave everything else (incl. the
    # user's in-app model choice) untouched. A config we did NOT seed is never modified.
    if cfg.exists():
        try:
            existing = cfg.read_text()
        except OSError as exc:
            _log(f"could not read existing config: {exc}")
            return
        if _MANAGED_SENTINEL not in existing:
            return  # user-owned config — respect it
        fixed = re.sub(r'(\n[ \t]*base_url:[ \t]*)"[^"]*"', rf'\g<1>"{base}"', existing)
        if fixed != existing:
            try:
                cfg.write_text(fixed)
                _log(f"healed stale gateway base_url → {base} in {cfg}")
            except OSError as exc:
                _log(f"could not heal gateway config: {exc}")
        return

    try:
        # api_mode: chat_completions is explicit so the agent never auto-detects the
        # transport from the URL (runtime_provider.py:_detect_api_mode_for_url) — it always
        # POSTs {base}/chat/completions (the surface unified-api's auto-router + catalog use).
        cfg.write_text(
            f"# Seeded by the UnifiedApp launcher ({_MANAGED_SENTINEL}) — route the Hermes\n"
            "# Agent through the Unified gateway (unified-api), the OpenAI-compatible surface\n"
            "# OpenDesign uses. api_key is read from env ${UNIFIED_API_KEY} per request, so the\n"
            "# launcher's token-refresh loop keeps it fresh without rewriting this file.\n"
            "# Delete this file to reset to first-run defaults.\n"
            "custom_providers:\n"
            "  - name: Unified\n"
            f'    base_url: "{base}"\n'
            '    api_key: "${UNIFIED_API_KEY}"\n'
            "    api_mode: chat_completions\n"
            f"    models:\n      - {model}\n"
            "model:\n"
            "  provider: custom:unified\n"
            f"  default: {model}\n"
            f'  base_url: "{base}"\n'
            '  api_key: "${UNIFIED_API_KEY}"\n'
            "  api_mode: chat_completions\n"
        )
        _log(f"seeded gateway config (provider=custom:unified, model={model}, base={base}) at {cfg}")
    except OSError as exc:
        _log(f"could not seed gateway config: {exc}")


def _refresh_loop(expires_in: int) -> None:
    """Re-mint the short-lived (~5 min) app token before it expires. Runs in a daemon
    thread sharing this process's os.environ with the HTTP server / agent subprocesses."""
    while True:
        time.sleep(max(30, expires_in - 60))
        token, ttl = _mint_token()
        if token:
            _apply_token(token)
            _write_host_token(token)
            expires_in = ttl
            _log("refreshed Unified app token")
        else:
            expires_in = 120  # back off and retry sooner on failure


def main() -> int:
    # Make the bundled app source (server.py + api/) importable. launch.py lives at the
    # bundle root alongside server.py, so the root is already sys.path[0]; insert
    # defensively in case this is ever imported rather than run as __main__.
    if str(BUNDLE_ROOT) not in sys.path:
        sys.path.insert(0, str(BUNDLE_ROOT))

    host = os.environ.get("OD_BIND_HOST", "127.0.0.1")
    port = os.environ.get("OD_PORT", "8787")

    # ── Env bridge: OD_* (host) → HERMES_WEBUI_* (api/config.py reads these at import) ──
    # MUST be set before `import server`, which imports api.config and snapshots HOST/PORT.
    os.environ["HERMES_WEBUI_HOST"] = host
    os.environ["HERMES_WEBUI_PORT"] = str(port)

    # Relocate the WebUI's own mutable state (sessions/settings/auth json) under the
    # host's writable per-app data dir; the install tree is read-only.
    data_dir = os.environ.get("OD_DATA_DIR") or str(BUNDLE_ROOT)
    os.environ.setdefault("HERMES_WEBUI_STATE_DIR", str(Path(data_dir) / "webui"))

    # Co-bundled agent (fat bundle): wire it + sandbox HERMES_HOME. If absent (lean
    # UI-only bundle), leave HERMES_HOME at its default (~/.hermes) so the UI can still
    # auto-discover a user's externally-installed Hermes Agent. Gateway config is seeded
    # below, only once a broker token confirms we're inside UnifiedApp.
    agent_home = _wire_bundled_agent(data_dir)

    # Never pop a browser from inside the desktop shell, and never silently curl|bash the
    # heavy Hermes Agent installer at startup (the agent is co-bundled / opt-in only).
    os.environ.setdefault("NO_OPEN", "1")
    os.environ.setdefault("HERMES_WEBUI_AUTO_INSTALL", "0")
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    # The desktop marketplace renders installed apps in a loopback iframe (AppHost.vue);
    # allow framing so X-Frame-Options: DENY doesn't refuse the embed (see api/helpers.py).
    os.environ.setdefault("HERMES_WEBUI_ALLOW_FRAMING", "1")

    # ── Gateway auth (only when launched by the trusted desktop host) ──
    token, expires_in = _mint_token()
    if token:
        _apply_token(token)
        _write_host_token(token)
        _log(f"acquired Unified app token (expires_in={expires_in}s) via broker")
        threading.Thread(target=_refresh_loop, args=(expires_in,), daemon=True).start()
        # Seamless chat (OpenDesign-style): with the gateway token in hand, point the
        # bundled agent at the Unified gateway and skip the first-run wizard so the app
        # lands straight in a working chat. Only when an agent is actually bundled.
        if agent_home is not None:
            _seed_gateway_config(agent_home)
            os.environ.setdefault("HERMES_WEBUI_SKIP_ONBOARDING", "1")
    else:
        _log("no broker token (running outside UnifiedApp?); agent LLM creds left to user config")

    _log(
        f"serving on {host}:{port} (state={os.environ['HERMES_WEBUI_STATE_DIR']}, "
        f"agent={'bundled' if agent_home else 'external/none'})"
    )

    import server  # imported AFTER env is wired so api.config snapshots the right host/port

    server.main()  # blocks in ThreadingHTTPServer.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
