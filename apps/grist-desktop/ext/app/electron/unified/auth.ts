/**
 * UnifiedAI auth for Grist Desktop.
 *
 * Uses @unifiedai/sdk's node OAuth flow: keychain-cached tokens -> handoff from
 * a running UnifiedApp desktop -> browser PKCE sign-in. The user signs in once
 * with their UnifiedAI account; rotation/refresh is SDK-managed. In the common
 * marketplace case (UnifiedApp is running) the handoff makes sign-in silent.
 *
 * Token storage: the SDK's default OS-keychain adapter needs @napi-rs/keyring,
 * a native module the bundled main process doesn't ship. We pass a file-backed
 * adapter instead (0600 JSON under <userData>/unified/).
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as electron from "electron";
// Local CommonJS shim for @unifiedai/sdk/node — see _sdk.d.ts for why the SDK
// is not imported directly (classic node resolution + CommonJS emit vs the
// SDK's ESM-behind-exports). build-bundle.sh produces the runtime _sdk.js.
import { UnifiedAI, type KeychainAdapter, type TokenSet } from "./_sdk";

// OAuth client id this app is registered as on the platform (oauth_clients).
// Override with UNIFIED_CLIENT_ID; the SDK also honors UNIFIEDAI_CLIENT_ID.
const DEFAULT_CLIENT_ID = "grist-desktop";

// The web client origin hosting the /oauth/authorize consent page in the
// local dev stack (the Quasar dev server). UNIFIEDAI_WEB_BASE overrides.
const DEFAULT_DEV_WEB_BASE = "http://localhost:9000";

// After a failed/canceled sign-in, back off all acquisition attempts for a
// while so a stream of assistant requests can't open a stack of browser tabs.
// An already-cached session still short-circuits via isUnifiedSignedIn() before
// this gate, so the backoff only suppresses fresh bootstrap attempts.
const INTERACTIVE_COOLDOWN_MS = 30_000;

function unifiedDir(): string {
  return path.join(electron.app.getPath("userData"), "unified");
}

function tokensPath(): string {
  return path.join(unifiedDir(), "tokens.json");
}

/** Gateway host (no trailing slash, no /api/v1). UNIFIED_API_URL overrides. */
export function unifiedApiHost(): string {
  const raw = process.env.UNIFIED_API_URL || "http://localhost:3141";
  return raw.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

/** OpenAI-compatible base URL on the gateway (chat/completions, models ...). */
export function unifiedApiBase(): string {
  return `${unifiedApiHost()}/api/v1`;
}

export function unifiedClientId(): string {
  return process.env.UNIFIED_CLIENT_ID || DEFAULT_CLIENT_ID;
}

// -- File-backed keychain ----------------------------------------------------

type TokenFile = Record<string, TokenSet>;

async function readTokenFile(): Promise<TokenFile> {
  try {
    return JSON.parse(await fs.readFile(tokensPath(), "utf8")) as TokenFile;
  } catch {
    return {};
  }
}

async function writeTokenFile(data: TokenFile): Promise<void> {
  await fs.mkdir(unifiedDir(), { recursive: true });
  await fs.writeFile(tokensPath(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

const fileKeychain: KeychainAdapter = {
  async get(clientId) {
    const data = await readTokenFile();
    return data[clientId] ?? null;
  },
  async set(clientId, tokens) {
    const data = await readTokenFile();
    data[clientId] = tokens;
    await writeTokenFile(data);
  },
  async clear(clientId) {
    const data = await readTokenFile();
    delete data[clientId];
    await writeTokenFile(data);
  },
};

// -- SDK client --------------------------------------------------------------

// The base client keeps token access protected (the documented subclass seam);
// the loopback proxy needs raw bearer tokens to inject into forwarded requests.
class GristUnifiedAI extends UnifiedAI {
  async accessToken(): Promise<string> {
    await this.bootstrap();
    return this.getInitialAccessToken();
  }
  refreshedAccessToken(): Promise<string> {
    return this.refreshAccessToken();
  }
}

let sdk: GristUnifiedAI | null = null;

/** True when the configured gateway is the local dev stack (loopback). */
function isLocalGateway(): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(unifiedApiHost());
}

export function getUnifiedSdk(): GristUnifiedAI {
  if (!sdk) {
    // The SDK's baked-in OAuth endpoints point at production
    // (web.unifiedai.app / api.unifiedai.app). When the gateway is the local
    // dev stack -- the default, and a Finder-launched .app gets no env vars --
    // derive the dev endpoints instead: the authorize consent page lives on
    // the web client (:9000) and the token endpoint on the gateway itself.
    // Explicit UNIFIEDAI_* env always wins.
    const webBase = (process.env.UNIFIEDAI_WEB_BASE || DEFAULT_DEV_WEB_BASE).replace(/\/+$/, "");
    const local = isLocalGateway();
    sdk = new GristUnifiedAI({
      apiUrl: unifiedApiHost(),
      appId: unifiedClientId(),
      keychain: fileKeychain,
      authorizeUrl: process.env.UNIFIEDAI_AUTHORIZE_URL || (local ? `${webBase}/oauth/authorize` : undefined),
      tokenUrl: process.env.UNIFIEDAI_TOKEN_URL || (local ? `${unifiedApiHost()}/oauth/token` : undefined),
    });
  }
  return sdk;
}

// -- Sign-in surface (used by the proxy and the app menu) --------------------

/** True when a cached session exists (no interactive sign-in needed). */
export async function isUnifiedSignedIn(): Promise<boolean> {
  try {
    const data = await readTokenFile();
    return Boolean(data[unifiedClientId()]);
  } catch {
    return false;
  }
}

/**
 * Interactive sign-in: keychain -> UnifiedApp-desktop handoff -> browser PKCE
 * (opens the system browser on the platform's consent page).
 */
export async function signInUnified(): Promise<void> {
  await getUnifiedSdk().bootstrap();
}

export async function signOutUnified(): Promise<void> {
  // signOut() revokes + wipes the keychain on the live instance, which stays
  // reusable; don't null the singleton (that would strand an in-flight bootstrap
  // and the ensureUnifiedSession state still referencing it).
  await getUnifiedSdk().signOut();
  lastInteractiveFailure = 0;
}

// -- Lazy session acquisition (single-flight, cooldown-guarded) --------------

let sessionPromise: Promise<void> | null = null;
let lastInteractiveFailure = 0;

/**
 * Ensure there is a usable session, acquiring one if needed. Single-flights so
 * concurrent assistant requests share one sign-in attempt, and backs off after
 * a failed interactive prompt to avoid opening a stack of browser tabs.
 * Returns whether a session is available afterwards.
 */
export async function ensureUnifiedSession(): Promise<boolean> {
  if (await isUnifiedSignedIn()) {
    return true;
  }
  if (Date.now() - lastInteractiveFailure < INTERACTIVE_COOLDOWN_MS) {
    return false;
  }
  if (!sessionPromise) {
    sessionPromise = signInUnified().finally(() => {
      sessionPromise = null;
    });
  }
  try {
    await sessionPromise;
  } catch {
    lastInteractiveFailure = Date.now();
  }
  return isUnifiedSignedIn();
}
