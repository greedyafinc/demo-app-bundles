/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UnifiedAI loopback gateway proxy.
 *
 * AionUi's LLM calls are made by the aioncore backend binary (and a few
 * in-process OpenAI clients), all of which expect a *static* OpenAI-compatible
 * provider: base_url + api_key. UnifiedAI auth is OAuth with short-lived,
 * SDK-refreshed access tokens — so a UnifiedAI provider is registered as
 *
 *   base_url = http://127.0.0.1:<port>/v1     api_key = <local proxy secret>
 *
 * and this proxy bridges the two: it validates the local secret, swaps in a
 * fresh OAuth access token, and forwards the request to the gateway's
 * /api/v1/* surface (streaming responses pass through). The real tokens never
 * leave the main process; the persisted provider config only ever holds the
 * loopback secret, which is useless off this machine.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { app } from 'electron';
import { getUnifiedSdk, isUnifiedSignedIn, unifiedApiBase } from './auth';

const DEFAULT_PORT = 25141;

function proxyPort(): number {
  const fromEnv = Number(process.env.AIONUI_UNIFIED_PROXY_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

function secretPath(): string {
  return path.join(app.getPath('userData'), 'unified', 'proxy-secret');
}

// Hop-by-hop / connection-level headers that must not be forwarded either way.
const STRIPPED_HEADERS = new Set([
  'authorization',
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
]);

let secret: string | null = null;
let server: http.Server | null = null;
let listening: Promise<number> | null = null;

/**
 * The secret doubles as the persisted provider api_key, so it must survive
 * restarts: generate once, store 0600, reuse thereafter.
 */
async function ensureSecret(): Promise<string> {
  if (secret) return secret;
  try {
    const existing = (await fs.readFile(secretPath(), 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      secret = existing;
      return secret;
    }
  } catch {
    // fall through and create
  }
  secret = crypto.randomBytes(32).toString('hex');
  await fs.mkdir(path.dirname(secretPath()), { recursive: true });
  await fs.writeFile(secretPath(), secret, { mode: 0o600 });
  return secret;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/v1/')) {
    sendJson(res, 404, { error: { message: 'unknown path (expected /v1/*)' } });
    return;
  }

  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const expected = await ensureSecret();
  if (!bearer || !timingSafeEqualStr(bearer, expected)) {
    sendJson(res, 401, { error: { message: 'invalid local proxy credential' } });
    return;
  }

  if (!(await isUnifiedSignedIn())) {
    sendJson(res, 401, { error: { message: 'not signed in to UnifiedAI — sign in from Settings → Models' } });
    return;
  }

  const target = `${unifiedApiBase()}${url.pathname.slice('/v1'.length)}${url.search}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || STRIPPED_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);

  const sdkClient = getUnifiedSdk();
  const send = async (token: string) => {
    headers.set('authorization', `Bearer ${token}`);
    return fetch(target, { method, headers, body: body as BodyInit | undefined });
  };

  try {
    let upstream = await send(await sdkClient.accessToken());
    if (upstream.status === 401) {
      upstream = await send(await sdkClient.refreshedAccessToken());
    }

    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!STRIPPED_HEADERS.has(name) && name !== 'content-encoding') outHeaders[name] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `UnifiedAI gateway unreachable: ${message}` } });
    } else {
      res.destroy();
    }
  }
}

/**
 * Start the proxy (idempotent). Resolves with the bound port.
 */
export function startUnifiedProxy(): Promise<number> {
  if (listening) return listening;
  listening = new Promise<number>((resolve, reject) => {
    server = http.createServer((req, res) => {
      void handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { error: { message: String(error) } });
      });
    });
    server.on('error', (error) => {
      listening = null;
      server = null;
      reject(error);
    });
    server.listen(proxyPort(), '127.0.0.1', () => {
      const address = server?.address();
      resolve(typeof address === 'object' && address ? address.port : proxyPort());
    });
  });
  return listening;
}

/** Provider config the renderer persists for the UnifiedAI platform entry. */
export async function getUnifiedProxyConfig(): Promise<{ baseUrl: string; apiKey: string }> {
  const port = await startUnifiedProxy();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: await ensureSecret() };
}
