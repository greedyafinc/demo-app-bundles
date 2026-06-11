/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UnifiedAI sign-in status surfaced to the renderer.
 *
 * `baseUrl`/`apiKey` describe the local loopback proxy the main process runs
 * for UnifiedAI providers (see process/unified/proxy.ts) — they are what the
 * provider form persists as base_url/api_key. They are present whenever the
 * proxy is up, regardless of sign-in state.
 */
export type UnifiedStatus = {
  signedIn: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  /** Gateway host the proxy forwards to (diagnostic display only). */
  gateway: string;
  /** Populated when the proxy failed to start or sign-in failed. */
  error?: string;
};
