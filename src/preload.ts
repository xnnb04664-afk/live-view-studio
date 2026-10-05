import { contextBridge, ipcRenderer } from "electron";

import type { DesktopBridge, PrivacyTarget } from "./types";

const desktopBridge: DesktopBridge = {
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    close: () => ipcRenderer.send("window:close"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    setFullscreen: (enabled: boolean) => ipcRenderer.invoke("window:set-fullscreen", enabled),
    setAlwaysOnTop: (enabled: boolean) => ipcRenderer.invoke("window:set-always-on-top", enabled),
    getState: () => ipcRenderer.invoke("window:get-state"),
  },
  saveSnapshot: (dataUrl: string) => ipcRenderer.invoke("snapshot:save", dataUrl),
  openSnapshotFolder: () => ipcRenderer.invoke("snapshot:open-folder"),
  openPrivacySettings: (target: PrivacyTarget) => ipcRenderer.invoke("system:open-privacy-settings", target),
  transfer: {
    getState: () => ipcRenderer.invoke("transfer:get-state"),
    ensureChannel: () => ipcRenderer.invoke("transfer:ensure-channel"),
    resetPairing: () => ipcRenderer.invoke("transfer:reset-pairing"),
    uploadSnapshot: (path: string) => ipcRenderer.invoke("transfer:upload-snapshot", path),
    retryPendingUploads: () => ipcRenderer.invoke("transfer:retry-pending"),
  },
};

contextBridge.exposeInMainWorld("desktop", desktopBridge);
