/**
 * UnifiedAI integration for Grist Desktop.
 *
 * Routes Grist's AI Assistant ("Formula AI") through the UnifiedAI gateway on
 * the user's subscription -- no API keys, no separate login. `setupUnifiedAI()`
 * is called from the Electron main process after config load and before the
 * grist-core server boots, so the ASSISTANT_* env vars are in place when the
 * server reads them.
 *
 * See ./proxy and ./auth for the loopback proxy and OAuth details.
 */

import log from "app/server/lib/log";
import { startUnifiedProxy, getProxySecret, setActiveModel } from "./proxy";
import { unifiedApiHost } from "./auth";
import { registerUnifiedIpc } from "./ipc";

export { signInUnified, signOutUnified, isUnifiedSignedIn } from "./auth";

// Default catalog model for the assistant. Must support OpenAI-style tool
// calling (the assistant uses tools). UNIFIED_DEFAULT_MODEL / ASSISTANT_MODEL
// override.
const DEFAULT_MODEL = "gpt-5.4";

/**
 * Start the loopback proxy and point Grist's AI Assistant at it.
 *
 * Best-effort: any failure is logged and leaves the assistant unconfigured
 * rather than blocking app startup. Set GRIST_UNIFIED_DISABLE=1 to opt out
 * entirely and let the upstream ASSISTANT_* / OPENAI_* configuration apply.
 */
export async function setupUnifiedAI(): Promise<void> {
  if (process.env.GRIST_UNIFIED_DISABLE === "1") {
    log.info("[unified] GRIST_UNIFIED_DISABLE=1 - leaving AI Assistant config untouched");
    return;
  }
  try {
    const port = await startUnifiedProxy();
    // Force the assistant through the proxy: that is the whole point of this
    // build ("powered by your Unified subscription"). The model is left to the
    // user if they set ASSISTANT_MODEL.
    process.env.ASSISTANT_CHAT_COMPLETION_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;
    process.env.ASSISTANT_API_KEY = getProxySecret();
    if (!process.env.ASSISTANT_MODEL) {
      process.env.ASSISTANT_MODEL = process.env.UNIFIED_DEFAULT_MODEL || DEFAULT_MODEL;
    }
    // Seed the proxy's active model so the picker shows the current choice and
    // requests are rewritten consistently from the first call.
    setActiveModel(process.env.ASSISTANT_MODEL);
    // Expose auth + model picker to the renderer toolbar.
    registerUnifiedIpc();
    log.info(
      `[unified] AI Assistant routed through UnifiedAI gateway ${unifiedApiHost()} ` +
        `(loopback proxy :${port}, model ${process.env.ASSISTANT_MODEL})`
    );
  } catch (err) {
    log.warn(`[unified] failed to start UnifiedAI proxy; AI Assistant left unconfigured: ${err}`);
  }
}
