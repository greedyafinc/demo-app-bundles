/**
 * UnifiedAI loopback gateway proxy for Pile.
 *
 * Pile builds an OpenAI client in the *renderer* from three persisted settings:
 * `baseUrl` (an OpenAI-compatible base URL), the AI key (sent as a Bearer
 * token), and `model`. The renderer expects a *static* endpoint + key.
 * UnifiedAI auth is OAuth with short-lived, SDK-refreshed access tokens, so we
 * point Pile at this loopback proxy instead (see ./index for the pre-seed):
 *
 *   baseUrl = http://127.0.0.1:<port>/v1
 *   aiKey   = <per-launch loopback secret>
 *
 * Per request the proxy validates the loopback secret, swaps in a fresh OAuth
 * access token, and forwards to the gateway's /api/v1/* surface (SSE streams
 * pass through via Node pipes). Real tokens never leave the main process.
 *
 * Pile persists `baseUrl`/aiKey across launches, so ./index re-seeds them on
 * every startup to match the current launch's port + secret; the port is
 * ephemeral (or PILE_UNIFIED_PROXY_PORT) and the secret is random in-memory.
 *
 * Implemented with node http/https (no global fetch / DOM types) so it runs in
 * the Electron main process and bundles cleanly under webpack target
 * electron-main.
 */

import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import {
  ensureUnifiedSession,
  getUnifiedSdk,
  isUnifiedSignedIn,
  unifiedApiBase,
} from './auth';

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
  'content-encoding',
]);

let secret: string | null = null;
let server: http.Server | null = null;
let listening: Promise<number> | null = null;

/** Per-launch loopback secret (in memory only). Doubles as the renderer aiKey. */
export function getProxySecret(): string {
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
  }
  return secret;
}

/** Fixed proxy port when PILE_UNIFIED_PROXY_PORT is set, else ephemeral (0). */
function proxyPort(): number {
  const fromEnv = Number(process.env.PILE_UNIFIED_PROXY_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 0;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Forward a single request to the gateway and resolve with the upstream response. */
function forwardOnce(
  target: URL,
  method: string,
  headers: http.OutgoingHttpHeaders,
  body: Buffer | undefined,
  token: string,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const upstreamReq = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: { ...headers, authorization: `Bearer ${token}` },
      },
      resolve,
    );
    upstreamReq.on('error', reject);
    if (body && body.length > 0) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
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
  if (!bearer || !timingSafeEqualStr(bearer, getProxySecret())) {
    sendJson(res, 401, { error: { message: 'invalid local proxy credential' } });
    return;
  }

  // Acquire a session if needed: handoff from a running UnifiedApp is silent;
  // a standalone launch falls back to a one-time browser PKCE sign-in.
  if (!(await isUnifiedSignedIn()) && !(await ensureUnifiedSession())) {
    sendJson(res, 401, {
      error: { message: 'not signed in to UnifiedAI' },
    });
    return;
  }

  const target = new URL(`${unifiedApiBase()}${url.pathname.slice('/v1'.length)}${url.search}`);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || STRIPPED_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }

  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);

  const sdkClient = getUnifiedSdk();
  try {
    let upstream = await forwardOnce(target, method, headers, body, await sdkClient.accessToken());
    if (upstream.statusCode === 401) {
      upstream.resume(); // drain the rejected response before retrying
      upstream = await forwardOnce(
        target,
        method,
        headers,
        body,
        await sdkClient.refreshedAccessToken(),
      );
    }

    const outHeaders: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value === undefined || STRIPPED_HEADERS.has(name.toLowerCase())) continue;
      outHeaders[name] = value;
    }
    res.writeHead(upstream.statusCode ?? 502, outHeaders);
    // If Pile drops the connection mid-stream, tear down the upstream too so we
    // don't leak the gateway socket.
    res.on('close', () => upstream.destroy());
    upstream.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `UnifiedAI request failed: ${message}` } });
    } else {
      res.destroy();
    }
  }
}

/** Start the proxy (idempotent). Resolves with the bound port. */
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
