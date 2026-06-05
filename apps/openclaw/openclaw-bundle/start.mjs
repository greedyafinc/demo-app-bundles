#!/usr/bin/env node
// Wrapper entry point for the OpenClaw node-service bundle.
// Launched by the UnifiedApp desktop via service.rs with env:
//   OD_PORT, OD_DATA_DIR, UNIFIED_BROKER_URL, UNIFIED_BROKER_TOKEN, UNIFIED_APP_SLUG

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OD_PORT = process.env.OD_PORT;
const OD_DATA_DIR = process.env.OD_DATA_DIR;
const UNIFIED_API_URL = process.env.UNIFIED_API_URL || 'http://localhost:3141';

if (!OD_PORT || !OD_DATA_DIR) {
  process.stderr.write('[openclaw-wrapper] Missing OD_PORT or OD_DATA_DIR\n');
  process.exit(1);
}

// ── Gateway token (for iframe auth) ────────────────────────────────────────

const tokenPath = join(OD_DATA_DIR, '.token');

function loadOrCreateGatewayToken() {
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing.length > 0) return existing;
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, 'utf8');
  return token;
}

const gatewayToken = loadOrCreateGatewayToken();

// ── Broker-backed provider proxy ───────────────────────────────────────────
// OpenClaw hits this local proxy as its OPENAI_BASE_URL. The proxy attaches a
// fresh broker-managed JWT (via @unified/app-sdk getAppToken) and forwards to
// the real unified provider API.

let getAppToken;
const hasBroker = !!(process.env.UNIFIED_BROKER_URL && process.env.UNIFIED_BROKER_TOKEN);

if (hasBroker) {
  const sdk = await import('./app-sdk/index.js');
  getAppToken = sdk.getAppToken;
}

function startProviderProxy() {
  return new Promise((resolve, reject) => {
    const proxy = createServer(async (req, res) => {
      if (!getAppToken) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="UnifiedApp"',
        });
        res.end(JSON.stringify({
          error: {
            message: 'Sign in to UnifiedApp to enable AI features.',
            type: 'unified_app_signed_out',
            code: 'signed_out',
          },
        }));
        return;
      }

      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const token = await getAppToken();
          const targetUrl = `${UNIFIED_API_URL}${req.url}`;
          const headers = { ...req.headers, authorization: `Bearer ${token}` };
          delete headers.host;
          delete headers['content-length'];

          const body = Buffer.concat(chunks);
          const upstream = await fetch(targetUrl, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
          });

          res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
          const respBody = Buffer.from(await upstream.arrayBuffer());
          res.end(respBody);
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
      });
    });

    proxy.listen(0, '127.0.0.1', () => {
      const port = proxy.address().port;
      process.stderr.write(`[openclaw-wrapper] provider proxy on 127.0.0.1:${port}\n`);
      resolve(port);
    });
    proxy.on('error', reject);
  });
}

// ── Render safe openclaw.json ──────────────────────────────────────────────

function renderConfig(proxyPort) {
  const templatePath = join(__dirname, 'config-template.json');
  const config = JSON.parse(readFileSync(templatePath, 'utf8'));

  config.gateway.port = parseInt(OD_PORT, 10);
  config.gateway.auth.token = gatewayToken;

  // Only relax device-auth when the trusted desktop host launched us. A bundle
  // started directly (e.g., a user finds the bin/ and runs start.mjs by hand)
  // never sees UNIFIED_HOST_TRUST_TOKEN and keeps device-auth enforced. The
  // token itself is generated per-launch by the desktop's broker and only
  // inherited by child processes it spawns — equivalent to a signed JWT on
  // loopback without the dependency cost.
  if (process.env.UNIFIED_HOST_TRUST_TOKEN && process.env.UNIFIED_HOST_TRUST_TOKEN.length >= 32) {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
  }

  const configPath = join(OD_DATA_DIR, 'openclaw.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}

// ── Main ───────────────────────────────────────────────────────────────────

// Always start the proxy. When signed out, it returns 401 with a clear
// "sign in to UnifiedApp" message that OpenClaw surfaces to the user.
const proxyPort = await startProviderProxy();
renderConfig(proxyPort);

const nodeBin = join(__dirname, 'bin', 'node');
const clawEntry = join(__dirname, 'openclaw', 'openclaw.mjs');
const args = [clawEntry, 'gateway', 'run', '--port', OD_PORT, '--bind', 'loopback'];

const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: OD_DATA_DIR,
  OPENCLAW_HOME: OD_DATA_DIR,
};

env.OPENAI_BASE_URL = `http://127.0.0.1:${proxyPort}`;
// Prefixed with sk- so providers that validate key shape accept it. The proxy
// ignores this and substitutes a broker-issued JWT before forwarding upstream.
env.OPENAI_API_KEY = 'sk-unified-app-proxy';

process.stderr.write(`[openclaw-wrapper] spawning gateway on port ${OD_PORT}\n`);

const child = spawn(nodeBin, args, {
  stdio: 'inherit',
  env,
  cwd: join(__dirname, 'openclaw'),
});

child.on('exit', (code, signal) => {
  process.stderr.write(`[openclaw-wrapper] gateway exited code=${code} signal=${signal}\n`);
  process.exit(code ?? 1);
});

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
