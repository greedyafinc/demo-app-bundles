/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UnifiedAI bridge module.
 *
 * Stays IPC (not the HTTP bridge): the main process owns the OAuth session
 * (@unifiedai/sdk + file keychain) and the loopback gateway proxy, both of
 * which must never be exposed to the aioncore backend or the renderer beyond
 * the status snapshot below.
 */

import { ipcBridge } from '@/common';
import type { UnifiedStatus } from '@/common/types/provider/unifiedTypes';
import { getUnifiedProxyConfig, isUnifiedSignedIn, signInUnified, signOutUnified, unifiedApiHost } from '../unified';

async function buildStatus(): Promise<UnifiedStatus> {
  const gateway = unifiedApiHost();
  try {
    const [{ baseUrl, apiKey }, signedIn] = await Promise.all([getUnifiedProxyConfig(), isUnifiedSignedIn()]);
    return { signedIn, baseUrl, apiKey, gateway };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { signedIn: false, baseUrl: null, apiKey: null, gateway, error: message };
  }
}

export function initUnifiedBridge(): void {
  ipcBridge.unified.status.provider(() => buildStatus());

  ipcBridge.unified.signIn.provider(async () => {
    try {
      await signInUnified();
    } catch (error) {
      const status = await buildStatus();
      return { ...status, error: error instanceof Error ? error.message : String(error) };
    }
    return buildStatus();
  });

  ipcBridge.unified.signOut.provider(async () => {
    await signOutUnified();
  });

  // Bring the proxy up eagerly: providers persisted in a previous session may
  // route through it as soon as the aioncore backend starts serving chats.
  void getUnifiedProxyConfig().catch((error: unknown) => {
    console.error('[UnifiedAI] loopback proxy failed to start:', error);
  });
}
