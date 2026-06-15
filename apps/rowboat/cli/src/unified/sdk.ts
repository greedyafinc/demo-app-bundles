// UnifiedAI SDK client (@unifiedai/sdk) in trusted-token mode.
//
// The SDK is the typed client for the platform surface beyond raw
// chat/completions — model catalog (with author/provider metadata), usage,
// files, etc. We run it in trusted-token mode with the broker-token provider
// from ./auth.js: every SDK request resolves a fresh app-scoped token, and the
// SDK's own 401-refresh path re-invokes the provider once before failing.
//
// NOTE: imported from the browser entry deliberately. The /node entry adds
// OAuth (loopback PKCE + OS keychain via @napi-rs/keyring) which a bundled
// marketplace app must never use — auth comes from the host's broker. The
// browser entry is dependency-free and works fine on Node ≥ 20 (same pattern
// as OpenDesign's daemon).

import { UnifiedAI } from "@unifiedai/sdk/browser";
import { getUnifiedToken, isUnifiedConfigured, unifiedApiHost } from "./auth.js";

let sdk: UnifiedAI | null = null;

/**
 * Lazily-constructed UnifiedAI client, or null when running outside the
 * UnifiedApp desktop host (no broker env → no way to authenticate).
 */
export function getUnifiedSdk(): UnifiedAI | null {
    if (!isUnifiedConfigured()) return null;
    if (!sdk) {
        sdk = new UnifiedAI({
            apiUrl: unifiedApiHost(),
            token: () => getUnifiedToken(),
        });
    }
    return sdk;
}
