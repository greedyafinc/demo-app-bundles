// UnifiedAI auth + gateway client for the Rowboat desktop app.
//
// Unlike the marketplace node-service bundle (which authenticates through the
// UnifiedApp desktop host's loopback broker), this app runs STANDALONE — so it
// uses @unifiedai/sdk's node OAuth flow: keychain-cached tokens → handoff from
// a running UnifiedApp desktop → browser PKCE sign-in. The user signs in once
// with their UnifiedAI account; rotation/refresh is SDK-managed.
//
// Two consumers:
//   - the `unified` model-provider flavor (models.ts): an OpenAI-compatible
//     provider against the gateway whose per-request fetch injects a fresh
//     access token (and retries once on 401 after an SDK refresh);
//   - the model catalog (listUnifiedModels) and sign-in/out IPC surface.
//
// Token storage: the SDK's default OS-keychain adapter needs @napi-rs/keyring,
// a native module the esbuild-bundled main process can't ship. We pass a
// file-backed adapter instead (0600 JSON under WorkDir/config) — the same
// posture as Rowboat's own OAuth repo, which keeps Google/Rowboat tokens in a
// plain JSON file in the same directory.

import fs from "node:fs/promises";
import path from "node:path";
import { UnifiedAI, type KeychainAdapter } from "@unifiedai/sdk/node";
import type { TokenSet } from "@unifiedai/sdk/node";
import { WorkDir } from "../config/config.js";

// OAuth client id this app is registered as on the platform (oauth_clients).
// Override with UNIFIED_CLIENT_ID; the SDK also honors UNIFIEDAI_CLIENT_ID.
const DEFAULT_CLIENT_ID = "rowboat-desktop";

const TOKENS_PATH = path.join(WorkDir, "config", "unified-tokens.json");

/** Gateway host (no trailing slash, no /api/v1). UNIFIED_API_URL overrides. */
export function unifiedApiHost(): string {
    const raw = process.env.UNIFIED_API_URL || "http://localhost:3141";
    return raw.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

/** OpenAI-compatible base URL (chat/completions + models live here). */
export function unifiedApiBase(): string {
    return `${unifiedApiHost()}/api/v1`;
}

// ── File-backed keychain (matches the app's existing token-storage posture) ──

type TokenFile = Record<string, TokenSet>;

async function readTokenFile(): Promise<TokenFile> {
    try {
        return JSON.parse(await fs.readFile(TOKENS_PATH, "utf8")) as TokenFile;
    } catch {
        return {};
    }
}

async function writeTokenFile(data: TokenFile): Promise<void> {
    await fs.mkdir(path.dirname(TOKENS_PATH), { recursive: true });
    await fs.writeFile(TOKENS_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
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

// ── SDK client ───────────────────────────────────────────────────────────────

// The base client keeps token access protected (the documented subclass seam);
// the `unified` provider flavor needs raw bearer tokens for its fetch wrapper.
class RowboatUnifiedAI extends UnifiedAI {
    async accessToken(): Promise<string> {
        await this.bootstrap();
        return this.getInitialAccessToken();
    }
    refreshedAccessToken(): Promise<string> {
        return this.refreshAccessToken();
    }
}

let sdk: RowboatUnifiedAI | null = null;

export function getUnifiedSdk(): RowboatUnifiedAI {
    if (!sdk) {
        sdk = new RowboatUnifiedAI({
            apiUrl: unifiedApiHost(),
            appId: process.env.UNIFIED_CLIENT_ID || DEFAULT_CLIENT_ID,
            keychain: fileKeychain,
        });
    }
    return sdk;
}

// ── Sign-in surface (wired to IPC by apps/main) ──────────────────────────────

/** True when a cached/handoff session exists (no interactive sign-in needed). */
export async function isUnifiedSignedIn(): Promise<boolean> {
    try {
        const data = await readTokenFile();
        const clientId = process.env.UNIFIED_CLIENT_ID || DEFAULT_CLIENT_ID;
        return Boolean(data[clientId]);
    } catch {
        return false;
    }
}

/**
 * Interactive sign-in: keychain → UnifiedApp-desktop handoff → browser PKCE
 * (opens the system browser on the platform's consent page).
 */
export async function signInUnified(): Promise<{ signedIn: boolean }> {
    await getUnifiedSdk().bootstrap();
    return { signedIn: true };
}

export async function signOutUnified(): Promise<void> {
    await getUnifiedSdk().signOut();
}

/** Gateway model catalog (with author metadata) for pickers. */
export async function listUnifiedModels() {
    return getUnifiedSdk().models.list({ include: ["author"] });
}

// ── Per-request authed fetch for the `unified` provider flavor ──────────────

export const unifiedFetch: typeof globalThis.fetch = async (input, init) => {
    const client = getUnifiedSdk();
    const send = async (token: string) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        return fetch(input, { ...init, headers });
    };
    let res = await send(await client.accessToken());
    if (res.status === 401) {
        res = await send(await client.refreshedAccessToken());
    }
    return res;
};
