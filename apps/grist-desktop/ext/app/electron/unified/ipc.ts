/**
 * IPC bridge for the renderer-side UnifiedAI toolbar control.
 *
 * Exposes auth state + the model picker to the Grist web client (via the
 * contextBridge `window.unifiedAI` in preload.ts). After any state change the
 * main process broadcasts `unified:changed` so the toolbar updates live.
 */

import * as electron from "electron";
import log from "app/server/lib/log";
import { isUnifiedSignedIn, signInUnified, signOutUnified } from "./auth";
import { getActiveModel, setActiveModel } from "./proxy";
import { findModel, listModels, PickerModel } from "./models";
import { getProviderLogo } from "./_sdk";

export type UnifiedStatus = {
  signedIn: boolean;
  modelId: string | null;
  model: PickerModel | null;
};

async function statusPayload(): Promise<UnifiedStatus> {
  const signedIn = await isUnifiedSignedIn().catch(() => false);
  const modelId = getActiveModel();
  let model: PickerModel | null = null;
  if (modelId) {
    await listModels().catch(() => []); // ensure the catalog cache is warm
    model =
      findModel(modelId) ?? {
        id: modelId,
        name: modelId,
        author: "",
        icon: getProviderLogo(null, "light"),
        iconDark: getProviderLogo(null, "dark"),
      };
  }
  return { signedIn, modelId, model };
}

function broadcast(): void {
  for (const win of electron.BrowserWindow.getAllWindows()) {
    win.webContents.send("unified:changed");
  }
}

let registered = false;

/** Register the unified:* IPC handlers (idempotent). */
export function registerUnifiedIpc(): void {
  if (registered) {
    return;
  }
  registered = true;

  electron.ipcMain.handle("unified:status", () => statusPayload());
  electron.ipcMain.handle("unified:models", () => listModels().catch(() => []));
  electron.ipcMain.handle("unified:signIn", async () => {
    await signInUnified();
    broadcast();
    return statusPayload();
  });
  electron.ipcMain.handle("unified:signOut", async () => {
    await signOutUnified();
    broadcast();
    return statusPayload();
  });
  electron.ipcMain.handle("unified:setModel", async (_e, id: string) => {
    setActiveModel(id);
    broadcast();
    return statusPayload();
  });

  log.info("[unified] IPC handlers registered (status/models/signIn/signOut/setModel)");
}
