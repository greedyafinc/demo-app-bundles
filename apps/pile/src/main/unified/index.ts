/**
 * UnifiedAI integration for Pile.
 *
 * Routes Pile's AI reflections (and the semantic vector index) through the
 * UnifiedAI gateway on the user's subscription -- no OpenAI API key, no
 * separate login. `setupUnifiedAI()` is called from the Electron main process
 * in app.whenReady() *before* the window loads, so the pre-seeded settings are
 * in place when the renderer first reads them.
 *
 * Pile constructs its OpenAI client in the renderer from three persisted
 * settings -- `baseUrl`, the encrypted `aiKey`, and `model` (see
 * src/renderer/context/AIContext.js). We force `baseUrl` at the loopback proxy,
 * seed the proxy's per-launch secret as `aiKey` (so the renderer actually
 * constructs the client -- it skips setup when get-ai-key returns null and
 * sends that secret, which the proxy validates), and ensure `pileAIProvider`
 * is 'openai'. The embeddings path (src/main/utils/pileEmbeddings.js) reads the
 * same `baseUrl`, so it flows through the proxy too.
 *
 * See ./proxy and ./auth for the loopback proxy and OAuth details.
 */

import settings from 'electron-settings';
import { setKey } from '../utils/store';
import { startUnifiedProxy, getProxySecret } from './proxy';
import { unifiedApiHost } from './auth';

// Default catalog model for AI reflections. 'auto' lets the gateway's router
// pick a model -- the most zero-config choice. UNIFIED_DEFAULT_MODEL overrides.
const DEFAULT_MODEL = process.env.UNIFIED_DEFAULT_MODEL || 'auto';

// Pile's upstream default chat model; we only overwrite `model` while it is
// still this (or unset), so a user who picks a specific catalog model keeps it.
const UPSTREAM_DEFAULT_MODEL = 'gpt-4o';

/**
 * Start the loopback proxy and point Pile's AI at it.
 *
 * Best-effort: any failure is logged and leaves AI unconfigured rather than
 * blocking app startup. Set PILE_UNIFIED_DISABLE=1 to opt out entirely and let
 * Pile's own baseUrl/key settings apply (bring-your-own OpenAI key).
 */
export async function setupUnifiedAI(): Promise<void> {
  if (process.env.PILE_UNIFIED_DISABLE === '1') {
    console.log('[unified] PILE_UNIFIED_DISABLE=1 - leaving Pile AI settings untouched');
    return;
  }
  try {
    const port = await startUnifiedProxy();
    const secret = getProxySecret();

    // Force Pile's renderer OpenAI client through the proxy: that is the whole
    // point of this build ("powered by your Unified subscription").
    await settings.set('baseUrl', `http://127.0.0.1:${port}/v1`);
    await settings.set('pileAIProvider', 'openai');

    // Seed a default catalog model only while still on the upstream default /
    // unset, so an explicit user choice survives.
    const currentModel = await settings.get('model');
    if (!currentModel || currentModel === UPSTREAM_DEFAULT_MODEL) {
      await settings.set('model', DEFAULT_MODEL);
    }

    // Seed the per-launch proxy secret as the AI key. The renderer sends it as
    // the Bearer token; the proxy validates it and swaps in a real OAuth token.
    // Overwritten each launch (ephemeral port + secret).
    await setKey(secret);

    console.log(
      `[unified] Pile AI routed through UnifiedAI gateway ${unifiedApiHost()} ` +
        `(loopback proxy :${port}, model ${DEFAULT_MODEL})`,
    );
  } catch (err) {
    console.warn(`[unified] failed to start UnifiedAI proxy; Pile AI left unconfigured: ${err}`);
  }
}
