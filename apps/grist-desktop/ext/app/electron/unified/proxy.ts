/**
 * UnifiedAI loopback gateway proxy for Grist Desktop.
 *
 * Grist's AI Assistant ("Formula AI") is configured by three env vars read by
 * the grist-core server: ASSISTANT_CHAT_COMPLETION_ENDPOINT (a full
 * OpenAI-compatible chat-completions URL), ASSISTANT_API_KEY (sent as a Bearer
 * token), and ASSISTANT_MODEL. The server expects a *static* endpoint + key.
 * UnifiedAI auth is OAuth with short-lived, SDK-refreshed access tokens, so we
 * point the assistant at this loopback proxy instead:
 *
 *   ASSISTANT_CHAT_COMPLETION_ENDPOINT = http://127.0.0.1:<port>/v1/chat/completions
 *   ASSISTANT_API_KEY                  = <per-launch loopback secret>
 *
 * Per request the proxy validates the loopback secret, swaps in a fresh OAuth
 * access token, and forwards to the gateway's /api/v1/* surface (SSE streams
 * pass through via Node pipes). Real tokens never leave the main process.
 *
 * Unlike the persisted-provider apps, Grist reads ASSISTANT_* fresh on every
 * launch, so neither the port nor the secret needs to survive restarts: we
 * bind an ephemeral port and mint a random in-memory secret each launch.
 *
 * Implemented with node http/https (no global fetch) so it type-checks under
 * grist-core's es2017 / types:[] build.
 */

import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
import {
  ensureUnifiedSession,
  getUnifiedSdk,
  isUnifiedSignedIn,
  unifiedApiBase,
} from "./auth";

// Hop-by-hop / connection-level headers that must not be forwarded either way.
const STRIPPED_HEADERS = new Set([
  "authorization",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  "content-encoding",
]);

let secret: string | null = null;
let server: http.Server | null = null;
let listening: Promise<number> | null = null;

// The model the assistant should actually use. Grist bakes ASSISTANT_MODEL into
// every chat/completions request; the model picker sets this, and the proxy
// rewrites the request body's `model` field so the user's choice takes effect
// without restarting the grist-core server.
let activeModel: string | null = null;

/** Current active model id (what the proxy rewrites requests to). */
export function getActiveModel(): string | null {
  return activeModel;
}

/** Set the active model id (from the model picker). Null = leave Grist's choice. */
export function setActiveModel(modelId: string | null): void {
  activeModel = modelId && modelId.trim() ? modelId.trim() : null;
}

/** Per-launch loopback secret (in memory only). Doubles as ASSISTANT_API_KEY. */
export function getProxySecret(): string {
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
  }
  return secret;
}

/** Fixed proxy port when GRIST_UNIFIED_PROXY_PORT is set, else ephemeral (0). */
function proxyPort(): number {
  const fromEnv = Number(process.env.GRIST_UNIFIED_PROXY_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 0;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Forward a single request to the gateway and resolve with the upstream response. */
function forwardOnce(
  target: URL,
  method: string,
  headers: http.OutgoingHttpHeaders,
  body: Buffer | undefined,
  token: string
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === "https:";
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
      resolve
    );
    upstreamReq.on("error", reject);
    if (body && body.length > 0) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/v1/")) {
    sendJson(res, 404, { error: { message: "unknown path (expected /v1/*)" } });
    return;
  }

  const auth = req.headers.authorization ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer || !timingSafeEqualStr(bearer, getProxySecret())) {
    sendJson(res, 401, { error: { message: "invalid local proxy credential" } });
    return;
  }

  // Acquire a session if needed: handoff from a running UnifiedApp is silent;
  // a standalone launch falls back to a one-time browser PKCE sign-in.
  if (!(await isUnifiedSignedIn()) && !(await ensureUnifiedSession())) {
    sendJson(res, 401, {
      error: { message: "not signed in to UnifiedAI - use Help > Sign in to UnifiedAI" },
    });
    return;
  }

  const target = new URL(`${unifiedApiBase()}${url.pathname.slice("/v1".length)}${url.search}`);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || STRIPPED_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }

  const method = req.method ?? "GET";
  let body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);

  // Honor the model picker: rewrite the `model` field on chat/completions so the
  // user's selection wins over the ASSISTANT_MODEL Grist baked into the request.
  if (body && activeModel && url.pathname.endsWith("/chat/completions")) {
    try {
      const json = JSON.parse(body.toString("utf8"));
      json.model = activeModel;
      body = Buffer.from(JSON.stringify(json));
    } catch {
      // Non-JSON body — forward unchanged.
    }
  }

  const sdkClient = getUnifiedSdk();
  try {
    let upstream = await forwardOnce(target, method, headers, body, await sdkClient.accessToken());
    if (upstream.statusCode === 401) {
      upstream.resume(); // drain the rejected response before retrying
      upstream = await forwardOnce(target, method, headers, body, await sdkClient.refreshedAccessToken());
    }

    const outHeaders: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value === undefined || STRIPPED_HEADERS.has(name.toLowerCase())) continue;
      outHeaders[name] = value;
    }
    res.writeHead(upstream.statusCode ?? 502, outHeaders);
    // If Grist drops the connection mid-stream, tear down the upstream too so we
    // don't leak the gateway socket.
    res.on("close", () => upstream.destroy());
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
    server.on("error", (error) => {
      listening = null;
      server = null;
      reject(error);
    });
    server.listen(proxyPort(), "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address ? address.port : proxyPort());
    });
  });
  return listening;
}
