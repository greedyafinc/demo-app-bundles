import { contextBridge, ipcRenderer } from 'electron';

// Use electron's context bridge to expose a limited API to the renderer process (which runs app/client).
// Only expose what is necessary. See https://www.electronjs.org/docs/latest/tutorial/context-isolation
// If anything gets added to electronAPI, app/client/electronAPI.d.ts needs to be updated with the typing.
contextBridge.exposeInMainWorld("electronAPI", {
  createDoc: () => ipcRenderer.invoke("create-document"),
  importDoc: (uploadId: number) => ipcRenderer.invoke("import-document", uploadId),
  onMainProcessImportDoc: (callback: (fileContents: Buffer, fileName: string) => void) => {
    ipcRenderer.on("import-document",
      (_event, fileContents: Buffer, fileName: string) => callback(fileContents, fileName));
    return;
  },
});

// UnifiedAI: auth state + AI-model picker for the toolbar control (see
// app/client/ui/UnifiedAIMenu.ts). Mirrors the unified:* ipcMain handlers.
contextBridge.exposeInMainWorld("unifiedAI", {
  status: () => ipcRenderer.invoke("unified:status"),
  models: () => ipcRenderer.invoke("unified:models"),
  signIn: () => ipcRenderer.invoke("unified:signIn"),
  signOut: () => ipcRenderer.invoke("unified:signOut"),
  setModel: (id: string) => ipcRenderer.invoke("unified:setModel", id),
  // Subscribe to main-process state changes; returns an unsubscribe function.
  onChange: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("unified:changed", listener);
    return () => ipcRenderer.removeListener("unified:changed", listener);
  },
});

process.once('loaded', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).isRunningUnderElectron = true;
});
