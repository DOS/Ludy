// SPDX-License-Identifier: AGPL-3.0-only
// Sandboxed CommonJS preload for Ludy Desktop's local Consent Window, Recording Pill, and hidden Capture Worker.
// Runs with contextIsolation: true and sandbox: true; exposes only typed IPC methods with zero Node/token/network access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ludyDesktopBridge', {
  consentInit: () => ipcRenderer.invoke('desktop-capture:consent-init'),
  consentRefreshWindows: () => ipcRenderer.invoke('desktop-capture:refresh-windows'),
  consentRefreshAgenda: () => ipcRenderer.invoke('desktop-capture:refresh-agenda'),
  consentCopyNotice: (language) => ipcRenderer.invoke('desktop-capture:copy-notice', language),
  consentStart: (draft) => ipcRenderer.invoke('desktop-capture:start', draft),
  consentCancel: () => ipcRenderer.invoke('desktop-capture:cancel'),
  onConsentState: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('desktop-capture:consent-state', listener);
    return () => ipcRenderer.removeListener('desktop-capture:consent-state', listener);
  },

  pillInit: () => ipcRenderer.invoke('desktop-capture:pill-init'),
  pillStop: () => ipcRenderer.invoke('desktop-capture:stop'),
  onPillUpdate: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('desktop-capture:pill-update', listener);
    return () => ipcRenderer.removeListener('desktop-capture:pill-update', listener);
  },

  onWorkerStart: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('desktop-capture:worker-start', listener);
    return () => ipcRenderer.removeListener('desktop-capture:worker-start', listener);
  },
  onWorkerStop: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('desktop-capture:worker-stop', listener);
    return () => ipcRenderer.removeListener('desktop-capture:worker-stop', listener);
  },
  onWorkerPcm: (cb) => {
    const listener = (_event, buffer) => cb(buffer);
    ipcRenderer.on('desktop-capture:worker-pcm', listener);
    return () => ipcRenderer.removeListener('desktop-capture:worker-pcm', listener);
  },
  workerReady: (result) => ipcRenderer.send('desktop-capture:worker-ready', result),
  workerStopped: () => ipcRenderer.send('desktop-capture:worker-stopped'),
  workerChunk: (chunk) => ipcRenderer.send('desktop-capture:worker-chunk', chunk),
  workerLevels: (levels) => ipcRenderer.send('desktop-capture:worker-levels', levels),
  workerUnexpectedEnd: (reason) => ipcRenderer.send('desktop-capture:worker-ended', reason),
});
