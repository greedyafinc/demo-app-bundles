import { App } from "app/client/ui/App";
import { HomeModel } from "app/client/models/HomeModel";

export type NewDocument = {
  path: string,
  id: string
}

/**
 * Allows the Grist client to call into electron.
 * See https://www.electronjs.org/docs/latest/tutorial/ipc
 */
interface IElectronAPI {

  // The Grist client can use these interfaces to request the electron main process to perform
  // certain tasks.
  createDoc: () => Promise<NewDocument>,
  importDoc: (uploadId: number) => Promise<NewDocument>,

  // The Grist client needs to call these interfaces to register callback functions for certain
  // events coming from the electron main process.
  onMainProcessImportDoc: (callback: (fileContents: Buffer, fileName: string) => void) => void

}

/** A model entry for the UnifiedAI picker (id + display + offline author icon). */
export type UnifiedPickerModel = {
  id: string,
  name: string,
  author: string,
  icon: string,
  iconDark: string,
};

/** UnifiedAI auth + active-model state for the toolbar control. */
export type UnifiedStatus = {
  signedIn: boolean,
  modelId: string | null,
  model: UnifiedPickerModel | null,
};

/** Bridge exposed by preload.ts as window.unifiedAI (Electron only). */
interface IUnifiedAI {
  status: () => Promise<UnifiedStatus>,
  models: () => Promise<UnifiedPickerModel[]>,
  signIn: () => Promise<UnifiedStatus>,
  signOut: () => Promise<UnifiedStatus>,
  setModel: (id: string) => Promise<UnifiedStatus>,
  // Subscribe to state changes; returns an unsubscribe function.
  onChange: (callback: () => void) => (() => void),
}

declare global {
  interface Window {
    electronAPI: IElectronAPI,
    unifiedAI?: IUnifiedAI,
    gristApp: App,
  }
}
