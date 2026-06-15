// Broker auth client for the UnifiedAI platform.
//
// Rowboat ships as a UnifiedApp marketplace `node-service`: when launched
// inside the UnifiedApp desktop host, the loopback broker injects three env
// vars —
//
//   UNIFIED_BROKER_URL    e.g. http://127.0.0.1:54321
//   UNIFIED_BROKER_TOKEN  per-launch shared secret
//   UNIFIED_APP_SLUG      this bundle's slug ("rowboat")
//
// `getUnifiedToken()` POSTs to the broker and receives a short-lived
// app-scoped JWT (sub = signed-in user, app = slug) signed by base-api and
// trusted by unified-api. Rowboat therefore authenticates the user with zero
// manual setup and never sees the user's long-lived credentials.
//
// Ported from OpenDesign's daemon (apps/daemon/src/unified-auth.ts) — the
// reference Node implementation of this contract.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Refresh the cached token this many ms before its real expiry so a request
// never races a rollover. unified-api caps internal-JWT age at ~5 min.
const REFRESH_MARGIN_MS = 30_000;

let cached: { token: string; expiresAt: number } | null = null;

/** True when the broker env the desktop host injects is present. */
export function isUnifiedConfigured(): boolean {
    return Boolean(
        process.env.UNIFIED_BROKER_URL &&
            process.env.UNIFIED_BROKER_TOKEN &&
            process.env.UNIFIED_APP_SLUG,
    );
}

/**
 * Host base URL of the unified-api gateway (no trailing slash, no /api/v1).
 * The desktop host injects broker coords but NOT a gateway URL, so apps
 * default it to the dev gateway on loopback:3141 (OpenDesign/Hermes parity).
 * Override with UNIFIED_API_URL for a non-dev gateway.
 */
export function unifiedApiHost(): string {
    const raw = process.env.UNIFIED_API_URL || "http://localhost:3141";
    return raw.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

/** OpenAI-compatible base URL (the surface chat/completions + models live on). */
export function unifiedApiBase(): string {
    return `${unifiedApiHost()}/api/v1`;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `${name} is not set — Rowboat is not running inside the UnifiedApp desktop host`,
        );
    }
    return value;
}

/**
 * Current loopback-broker coordinates (url, shared-secret).
 *
 * Re-read from `$OD_DATA_DIR/.broker.json` — which the desktop host rewrites
 * on every spawn AND reuse — falling back to the env injected at spawn time.
 * The broker URL + secret rotate on every desktop launch, so a service reused
 * across a desktop restart holds stale env coords; re-reading the file each
 * mint lets it self-heal without a restart (same fix as OpenDesign's daemon).
 */
function brokerCoords(): { url: string; token: string } {
    const dataDir = process.env.OD_DATA_DIR;
    if (dataDir) {
        try {
            const raw = JSON.parse(readFileSync(join(dataDir, ".broker.json"), "utf8")) as {
                url?: string;
                token?: string;
            };
            const url = (raw.url ?? "").replace(/\/+$/, "");
            const token = raw.token ?? "";
            if (url && token) return { url, token };
        } catch {
            // missing/partial file → fall back to the spawn-time env
        }
    }
    return {
        url: requireEnv("UNIFIED_BROKER_URL").replace(/\/+$/, ""),
        token: requireEnv("UNIFIED_BROKER_TOKEN"),
    };
}

/**
 * Mint (or return a cached) app-scoped access token from the loopback broker.
 * Cached until shortly before expiry; `force` bypasses the cache for the
 * one-shot retry after a 401.
 */
export async function getUnifiedToken({ force = false }: { force?: boolean } = {}): Promise<string> {
    const now = Date.now();
    if (!force && cached && cached.expiresAt - REFRESH_MARGIN_MS > now) {
        return cached.token;
    }

    const { url: brokerUrl, token: brokerToken } = brokerCoords();
    const slug = requireEnv("UNIFIED_APP_SLUG");

    const res = await fetch(`${brokerUrl}/token`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-broker-token": brokerToken,
        },
        body: JSON.stringify({ app_slug: slug }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`UnifiedAI broker token fetch failed: ${res.status} ${text}`.trim());
    }

    const body = (await res.json()) as { token: string; expires_in: number };
    cached = {
        token: body.token,
        expiresAt: now + body.expires_in * 1000,
    };
    return cached.token;
}

/**
 * `fetch` wrapper that authenticates every request with a fresh broker token
 * (overriding whatever Authorization the caller set) and retries exactly once
 * on 401 with a force-minted token. This is what the `unified` model-provider
 * flavor plugs into `createOpenAICompatible({ fetch })`, so the ~5-min token
 * rotation is invisible to the AI SDK: each LLM call reads the current token.
 */
export const unifiedFetch: typeof globalThis.fetch = async (input, init) => {
    const send = async (token: string) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        return fetch(input, { ...init, headers });
    };
    let res = await send(await getUnifiedToken());
    if (res.status === 401) {
        res = await send(await getUnifiedToken({ force: true }));
    }
    return res;
};
