#!/usr/bin/env node
/**
 * UnifiedApp marketplace service entrypoint for Activepieces (`node-service` kind).
 *
 * The UnifiedApp desktop host (Tauri `desktop_core`) spawns this as a generic
 * executable per manifest.json:
 *
 *     "service": {
 *       "command": "runtime/node/bin/node",
 *       "args": ["launch.mjs"],
 *       "healthPath": "/api/v1/health",
 *       ...
 *     }
 *
 * Activepieces is a Fastify backend + React/Vite frontend that, in production,
 * serves the built frontend AND the API from a single port (AP_PORT) and runs an
 * out-of-process worker that polls the app over HTTP. We run it in its
 * single-machine configuration — embedded Postgres (PGLITE) + an in-memory queue
 * (MEMORY) — so there are no external Postgres/Redis dependencies.
 *
 * Three jobs:
 *
 *  1. Env bridge. Translate the host's OD_* contract into Activepieces' AP_* env:
 *     bind the host-allocated port, relocate all mutable state under the writable
 *     per-app data dir (the install tree is read-only), and relax CSP
 *     frame-ancestors so the desktop shell can iframe the app.
 *
 *  2. Process model (mirrors Activepieces' own docker-entrypoint.sh single
 *     container). Spawn TWO node children with a shared, stable AP_JWT_SECRET /
 *     AP_ENCRYPTION_KEY:
 *       - app:    packages/server/api/dist/src/main.js   (AP_CONTAINER_TYPE=APP)
 *                 binds AP_PORT, serves UI + API + the job broker.
 *       - worker: packages/server/worker/dist/src/index.js (AP_CONTAINER_TYPE=WORKER_AND_APP
 *                 so it polls http://127.0.0.1:AP_PORT/api/ and starts NO health
 *                 server of its own — avoiding a port clash with the app).
 *     The worker needs AP_WORKER_TOKEN (an HS256 JWT signed with AP_JWT_SECRET),
 *     which we mint exactly as docker-entrypoint.sh does.
 *
 *  3. Gateway auth (best-effort). Exchange the loopback broker secret for a
 *     short-lived, app-scoped UnifiedAI token and run a small loopback proxy that
 *     forwards to the Unified gateway's OpenAI-compatible surface with that token
 *     attached. Point an Activepieces AI provider's "Base URL" at this proxy to
 *     use AI on the user's Unified subscription (no provider API keys, and the
 *     app never sees a long-lived credential). See BUNDLING.md.
 *
 * Host-injected env (see desktop_core/src/service.rs + broker.rs):
 *   OD_PORT                   free port the host allocated — we MUST bind it
 *   OD_BIND_HOST              127.0.0.1
 *   OD_DATA_DIR               writable per-app data dir (install root is read-only)
 *   NO_OPEN                   "1" (the desktop opens the URL itself)
 *   UNIFIED_APP_SLUG          our marketplace slug ("activepieces")
 *   UNIFIED_BROKER_URL        loopback broker base url
 *   UNIFIED_BROKER_TOKEN      per-launch shared secret (x-broker-token header)
 *   UNIFIED_HOST_TRUST_TOKEN  proof we were started by the trusted host
 *
 * UNIFIED_API_URL is deliberately NOT injected by the host — we default it to the
 * production gateway and allow an override (e.g. http://localhost:3141 in dev).
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const log = (msg) => console.log(`[activepieces-launch] ${msg}`)

// ── Host contract ────────────────────────────────────────────────────────────
const BIND_HOST = process.env.OD_BIND_HOST || '127.0.0.1'
const PORT = String(process.env.OD_PORT || '3000')
const DATA_DIR = process.env.OD_DATA_DIR || path.join(BUNDLE_ROOT, '.data')
const SLUG = process.env.UNIFIED_APP_SLUG || 'activepieces'

// Unified gateway, OpenAI-compatible surface mounted at /api/v1. Default matches
// the other bundles (the desktop runs unified-api on loopback:3141 and does NOT
// inject a gateway URL). Override with UNIFIED_API_URL for a non-dev gateway.
const UNIFIED_API_URL = (process.env.UNIFIED_API_URL || 'http://localhost:3141').replace(/\/+$/, '')
const UNIFIED_API_BASE = UNIFIED_API_URL.endsWith('/api/v1') ? UNIFIED_API_URL : `${UNIFIED_API_URL}/api/v1`

// UnifiedApp desktop shell origins permitted to iframe this app (CSP
// frame-ancestors). The macOS production parent origin is the custom scheme
// tauri://localhost, which Activepieces' isValidOrigin() rejects — so this is
// applied via our AP_EMBED_FRAME_ANCESTORS source patch in server.ts, not the
// stock AP_ALLOWED_EMBED_ORIGINS path. Keep in sync with apps/openclaw.
const EMBED_FRAME_ANCESTORS =
  'tauri://localhost http://tauri.localhost https://tauri.localhost http://localhost:1420 http://localhost'

// Stable loopback port for the AI gateway proxy. Fixed (not ephemeral) so a saved
// Activepieces AI-provider base URL survives restarts. Override if it collides.
const AI_PROXY_PORT = Number(process.env.UNIFIED_AI_PROXY_PORT || 25152)

// Writable state dirs under the per-app data dir (install tree is read-only).
const CONFIG_PATH = path.join(DATA_DIR, 'config')
const CACHE_PATH = path.join(DATA_DIR, 'cache')
for (const dir of [DATA_DIR, CONFIG_PATH, CACHE_PATH]) fs.mkdirSync(dir, { recursive: true })

// ── Persisted secrets ────────────────────────────────────────────────────────
// AP_ENCRYPTION_KEY encrypts connection secrets in the PGLite DB; AP_JWT_SECRET
// signs sessions and the worker token. Both MUST be stable across restarts or the
// existing DB can no longer be decrypted / sessions are invalidated.
function loadOrCreateSecrets() {
  const file = path.join(DATA_DIR, 'secrets.json')
  let secrets = {}
  try {
    secrets = JSON.parse(fs.readFileSync(file, 'utf8')) || {}
  } catch {
    /* first run */
  }
  let changed = false
  // 32-char hex (16 bytes) — matches Activepieces' /^[A-Za-z0-9]{32}$/ check.
  if (!secrets.encryptionKey) { secrets.encryptionKey = crypto.randomBytes(16).toString('hex'); changed = true }
  if (!secrets.jwtSecret) { secrets.jwtSecret = crypto.randomBytes(32).toString('hex'); changed = true }
  // Password for the auto-provisioned local admin (server.ts local-autologin). 36
  // hex chars — within Activepieces' 8..64 policy. Persisted so sign-in is stable.
  if (!secrets.autoLoginPassword) { secrets.autoLoginPassword = crypto.randomBytes(18).toString('hex'); changed = true }
  if (changed) {
    try {
      fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 })
    } catch (e) {
      log(`could not persist secrets (will regenerate next launch): ${e}`)
    }
  }
  return secrets
}
const { encryptionKey, jwtSecret, autoLoginPassword } = loadOrCreateSecrets()

// ── Worker token (mirrors docker-entrypoint.sh AP_WORKER_TOKEN) ───────────────
const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function signWorkerToken() {
  const header = { alg: 'HS256', typ: 'JWT', kid: '1' }
  const iat = Math.floor(Date.now() / 1000)
  const payload = {
    id: crypto.randomUUID(),
    type: 'WORKER',
    iat,
    exp: iat + 100 * 365 * 24 * 60 * 60, // ~100y, like the upstream entrypoint
    iss: 'activepieces',
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = base64url(crypto.createHmac('sha256', jwtSecret).update(signingInput).digest())
  return `${signingInput}.${signature}`
}
const workerToken = signWorkerToken()

// ── Shared Activepieces env ───────────────────────────────────────────────────
const sharedEnv = {
  ...process.env,
  NODE_ENV: 'production',
  // Single-machine datastore: embedded Postgres + in-memory queue (no externals).
  AP_DB_TYPE: 'PGLITE',
  AP_REDIS_TYPE: 'MEMORY',
  AP_CONFIG_PATH: CONFIG_PATH,
  AP_CACHE_PATH: CACHE_PATH,
  // 'prod' is REQUIRED for the app to serve the built frontend (server.ts only
  // registers @fastify/static when AP_ENVIRONMENT !== 'dev').
  AP_ENVIRONMENT: 'prod',
  AP_EDITION: 'ce',
  AP_EXECUTION_MODE: 'UNSANDBOXED',
  AP_TELEMETRY_ENABLED: 'false',
  AP_FRONTEND_URL: `http://127.0.0.1:${PORT}`,
  AP_PORT: PORT,
  AP_JWT_SECRET: jwtSecret,
  AP_ENCRYPTION_KEY: encryptionKey,
  AP_WORKER_TOKEN: workerToken,
  // Activepieces' MEMORY queue spawns an EPHEMERAL redis via redis-memory-server,
  // which otherwise downloads the redis binary on first boot (a fragile network
  // dependency that's wiped on every update → ECONNREFUSED until it finishes). Point
  // it at the binary we embed at build time so it never downloads. getSystemPath just
  // access()-checks this, falling back to download if the path is missing.
  REDISMS_SYSTEM_BINARY: path.join(BUNDLE_ROOT, 'runtime', 'redis', 'redis-server'),
  // Consumed by our server.ts patch to allow the desktop shell to iframe the app.
  AP_EMBED_FRAME_ANCESTORS: EMBED_FRAME_ANCESTORS,
  // Local auto-login: provision/sign-in a single local admin and inject its token
  // into index.html so the bundle opens straight to the dashboard — no sign-in
  // screen. AP_LOCAL_AUTOLOGIN gates the authentication-service patch that makes a
  // Community sign-in return a full token (resolving/creating the platform) instead
  // of an onboarding token. A single-user local appliance; clear these to restore login.
  AP_LOCAL_AUTOLOGIN: 'true',
  AP_LOCAL_AUTOLOGIN_EMAIL: 'local@activepieces.local',
  AP_LOCAL_AUTOLOGIN_PASSWORD: autoLoginPassword,
  // Embedded runtimes on PATH: node (this) + bun (the worker shells out to `bun`
  // to install registry pieces at runtime — see worker/.../piece-installer.ts).
  PATH: [
    path.join(BUNDLE_ROOT, 'runtime', 'node', 'bin'),
    path.join(BUNDLE_ROOT, 'runtime', 'bun'),
    process.env.PATH || '',
  ].join(path.delimiter),
}

const NODE_BIN = path.join(BUNDLE_ROOT, 'runtime', 'node', 'bin', 'node')
const APP_ENTRY = path.join('packages', 'server', 'api', 'dist', 'src', 'main.js')
const WORKER_ENTRY = path.join('packages', 'server', 'worker', 'dist', 'src', 'index.js')

// ── Gateway auth + AI proxy ───────────────────────────────────────────────────
let currentToken = null

// Prefer OD_DATA_DIR/.broker.json (the desktop rewrites it on every spawn/reuse)
// over the spawn-time env, so a daemon reused across a desktop restart self-heals
// against rotated broker coords (vibe-trading pattern).
function brokerCoords() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '.broker.json'), 'utf8'))
    if (j.url && j.token) return { url: String(j.url).replace(/\/+$/, ''), token: j.token }
  } catch {
    /* fall through to env */
  }
  const url = (process.env.UNIFIED_BROKER_URL || '').replace(/\/+$/, '')
  const token = process.env.UNIFIED_BROKER_TOKEN || ''
  return url && token ? { url, token } : null
}

async function mintToken() {
  const coords = brokerCoords()
  if (!coords) return { token: null, expiresIn: 0 }
  try {
    const res = await fetch(`${coords.url}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-broker-token': coords.token },
      body: JSON.stringify({ app_slug: SLUG }),
    })
    if (!res.ok) {
      log(`broker token mint failed: HTTP ${res.status}`)
      return { token: null, expiresIn: 0 }
    }
    const data = await res.json()
    return data.token ? { token: data.token, expiresIn: Number(data.expires_in) || 300 } : { token: null, expiresIn: 0 }
  } catch (e) {
    log(`broker token mint error: ${e}`)
    return { token: null, expiresIn: 0 }
  }
}

function writeHostToken(token) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, '.token'), token)
  } catch {
    /* best-effort handoff file */
  }
}

async function refreshLoop(expiresIn) {
  for (;;) {
    await new Promise((r) => setTimeout(r, Math.max(30, expiresIn - 60) * 1000))
    const { token, expiresIn: ttl } = await mintToken()
    if (token) {
      currentToken = token
      writeHostToken(token)
      expiresIn = ttl
      log('refreshed Unified app token')
    } else {
      expiresIn = 120 // back off and retry sooner on failure
    }
  }
}

// Loopback proxy: forwards an OpenAI-compatible request to the Unified gateway
// with the freshly-minted app token attached. Point an Activepieces AI provider's
// Base URL at http://127.0.0.1:<AI_PROXY_PORT>/v1 to use the Unified subscription.
function startAiProxy() {
  const server = http.createServer((req, res) => {
    if (!currentToken) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Sign in to UnifiedApp to use AI on your Unified subscription.' } }))
      return
    }
    const subPath = (req.url || '/').replace(/^\/v1/, '') // accept base URL with or without /v1
    const target = new URL(UNIFIED_API_BASE + subPath)
    const transport = target.protocol === 'https:' ? https : http
    const headers = { ...req.headers, host: target.host, authorization: `Bearer ${currentToken}` }
    const upstream = transport.request(
      target,
      { method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Unified gateway error: ${e}` } }))
    })
    req.pipe(upstream)
  })
  server.on('error', (e) => {
    log(`AI gateway proxy could not bind 127.0.0.1:${AI_PROXY_PORT} (${e.code}); AI-on-subscription disabled`)
  })
  server.listen(AI_PROXY_PORT, '127.0.0.1', () => {
    const baseUrl = `http://127.0.0.1:${AI_PROXY_PORT}/v1`
    try {
      fs.writeFileSync(path.join(DATA_DIR, '.unified-ai-gateway.json'), JSON.stringify({ baseUrl }))
    } catch {
      /* discovery file is best-effort */
    }
    log(`AI gateway proxy → ${UNIFIED_API_BASE}; set an Activepieces AI provider Base URL to ${baseUrl}`)
  })
}

// ── Children ──────────────────────────────────────────────────────────────────
const children = []
let shuttingDown = false

function spawnChild(name, entry, extraEnv) {
  const child = spawn(NODE_BIN, ['--enable-source-maps', entry], {
    cwd: BUNDLE_ROOT, // server.ts resolves dist/packages/web from process.cwd()
    env: { ...sharedEnv, ...extraEnv },
    stdio: 'inherit',
  })
  children.push(child)
  child.on('exit', (code, signal) => {
    log(`${name} exited (code=${code}, signal=${signal})`)
    // The app is the service the host health-checks; if it dies, surface failure.
    if (!shuttingDown && name === 'app') shutdown(code ?? 1)
  })
  child.on('error', (e) => log(`${name} failed to start: ${e}`))
  return child
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 3000).unref()
}
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

async function main() {
  log(`Activepieces ${process.env.npm_package_version || ''} starting on ${BIND_HOST}:${PORT} (data=${DATA_DIR})`)

  const { token, expiresIn } = await mintToken()
  if (token) {
    currentToken = token
    writeHostToken(token)
    log(`acquired Unified app token (expires_in=${expiresIn}s) via broker`)
    refreshLoop(expiresIn).catch((e) => log(`token refresh loop stopped: ${e}`))
  } else {
    log('no broker token (running outside UnifiedApp?); AI gateway proxy will 401 until signed in')
  }
  startAiProxy()

  // app first (binds the port + runs migrations), then the worker (polls the app;
  // its socket client reconnects until the app is up, so ordering is not strict).
  spawnChild('app', APP_ENTRY, { AP_CONTAINER_TYPE: 'APP' })
  spawnChild('worker', WORKER_ENTRY, { AP_CONTAINER_TYPE: 'WORKER_AND_APP' })
}

main().catch((e) => {
  log(`fatal: ${e}`)
  process.exit(1)
})
