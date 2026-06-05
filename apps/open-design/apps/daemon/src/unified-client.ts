// Shared UnifiedAI SDK client for the daemon.
//
// OpenDesign talks to the unified-api gateway through the official
// `@unifiedai/sdk` in trusted-token mode. The loopback broker (see
// unified-auth.ts) mints short-lived, app-scoped tokens; the SDK owns request
// dispatch, SSE streaming, the 401 -> refresh -> retry, and the typed error
// hierarchy — so the daemon no longer hand-rolls any of that.
//
// We import the BROWSER entry explicitly (`@unifiedai/sdk/browser`) rather than
// the package root: under Node the package's `node` export condition resolves
// to the OAuth build (pulls `@napi-rs/keyring`, PKCE, and a loopback listener),
// none of which a broker-authed daemon wants — it must never run its own OAuth.
// The browser build is pure web-standard fetch/ReadableStream, fully supported
// on the daemon's Node 24 runtime.

import { UnifiedAI } from '@unifiedai/sdk/browser';
import { getUnifiedToken, isUnifiedConfigured, unifiedApiBase } from './unified-auth.js';

/**
 * Trusted-token client whose post-401 refresh force-remints from the broker.
 *
 * The base SDK reuses the same `token` provider for both the initial request
 * and the refresh that follows a 401. In trusted-token mode that would replay
 * the still-cached broker token and 401 again. Overriding `refreshAccessToken`
 * to force a fresh mint preserves the force-on-401 behaviour the hand-rolled
 * `unifiedFetch` used to have, while letting the SDK drive the retry.
 */
class BrokerUnifiedAI extends UnifiedAI {
  protected override async refreshAccessToken(): Promise<string> {
    return getUnifiedToken({ force: true });
  }
}

let client: BrokerUnifiedAI | undefined;

/**
 * Lazily-constructed singleton UnifiedAI client, bound to the broker token
 * provider and the gateway base URL.
 *
 * The token provider yields an empty string when the broker isn't configured —
 * the SDK then sends no `Authorization` header, which is exactly what the
 * unauthenticated `GET /api/v1/models` endpoint wants. Authenticated surfaces
 * (chat, usage) only run inside the UnifiedApp host, where a token is minted.
 */
export function getUnifiedClient(): BrokerUnifiedAI {
  if (!client) {
    client = new BrokerUnifiedAI({
      apiUrl: unifiedApiBase(),
      token: () => (isUnifiedConfigured() ? getUnifiedToken() : Promise.resolve('')),
    });
  }
  return client;
}
