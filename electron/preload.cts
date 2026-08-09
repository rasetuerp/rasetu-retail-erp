import { contextBridge, ipcRenderer } from 'electron';

// Renderer-facing bridge. Channel names use the `rt:` prefix (RaSetu),
// mirrored in main.ts. Keep this list scoped to what v1 actually needs —
// see docs/SCOPE.md; add more only when a Day-N task in docs/SPRINT_PLAN.md needs it.
contextBridge.exposeInMainWorld('rasetu', {
  platform: process.platform,
  ping: () => ipcRenderer.invoke('rt:ping'),
  getAppInfo: () => ipcRenderer.invoke('rt:app-info'),
  getUpdateStatus: () => ipcRenderer.invoke('rt:update-status'),
  getBackendStatus: () => ipcRenderer.invoke('rt:backend-status'),
  restartBackend: () => ipcRenderer.invoke('rt:backend-restart'),
  checkForUpdates: () => ipcRenderer.invoke('rt:update-check'),
  installUpdate: () => ipcRenderer.invoke('rt:update-install'),
  onUpdateStatus: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('rt:update-status', listener);
    return () => ipcRenderer.removeListener('rt:update-status', listener);
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('rt:window-minimize'),
    toggleMaximize: () => ipcRenderer.invoke('rt:window-toggle-maximize'),
    close: () => ipcRenderer.invoke('rt:window-close'),
    getState: () => ipcRenderer.invoke('rt:window-state'),
  },
  getMachineId: () => ipcRenderer.invoke('rt:get-machine-id'),

  // Licensing (Section 8 / docs/COMMERCIAL.md; Round 4 — Supabase-issued
  // Ed25519 tokens, verified offline via electron/license-verify.ts)
  saveLicenseSnapshot: (snapshot: { licenseKey: string; machineId: string; validationToken: string; lastValidAt: string }) =>
    ipcRenderer.invoke('rt:license-save-snapshot', snapshot),
  clearLicenseSnapshot: () => ipcRenderer.invoke('rt:license-clear-snapshot'),
  getStartupLicenseStatus: () => ipcRenderer.invoke('rt:license-startup-status'),
  getLicenseSnapshot: () => ipcRenderer.invoke('rt:license-get-snapshot'),
  onLicenseBlocked: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('rt:license-blocked', listener);
    return () => ipcRenderer.removeListener('rt:license-blocked', listener);
  },

  // Printer (docs/ARCHITECTURE.md — TSC bridge ported as-is from GoBilling)
  printer: {
    listPrinters: () => ipcRenderer.invoke('rt:printer-list'),
    getDefaultPrinter: () => ipcRenderer.invoke('rt:printer-default'),
    getPrinterSettings: (printerName: string) => ipcRenderer.invoke('rt:printer-settings-get', printerName),
    savePrinterSettings: (printerName: string, settings: unknown) =>
      ipcRenderer.invoke('rt:printer-settings-save', printerName, settings),
    printLabel: (printerName: string, labelData: unknown) =>
      ipcRenderer.invoke('rt:printer-print-label', printerName, labelData),
    printBatch: (printerName: string, labels: unknown) =>
      ipcRenderer.invoke('rt:printer-print-batch', printerName, labels),
    printRaw: (printerName: string, rawData: unknown) =>
      ipcRenderer.invoke('rt:printer-print-raw', printerName, rawData),
    printTest: (printerName: string) => ipcRenderer.invoke('rt:printer-print-test', printerName),
    testPrinterConnection: (printerName: string) =>
      ipcRenderer.invoke('rt:printer-test-connection', printerName),

    // Round 23 — per-role (receipt/label/invoice) config, persisted to disk.
    getConfig: () => ipcRenderer.invoke('rt:printer-config-get'),
    saveConfig: (role: 'receipt' | 'label' | 'invoice', patch: unknown) =>
      ipcRenderer.invoke('rt:printer-config-save', role, patch),
    printA4: (html: string, printerName: string, silent: boolean) =>
      ipcRenderer.invoke('rt:printer-print-a4', html, printerName, silent),
  },

  // Round 7 — local + extra-folder + Cloudflare R2 database backups.
  // Scheduling (5min-after-launch, then every 6h) lives entirely in
  // main.ts; these are the user-facing controls (Settings → Backups).
  backup: {
    runNow: () => ipcRenderer.invoke('rt:backup-run-now'),
    offsiteBackupNow: () => ipcRenderer.invoke('rt:offsite-backup-now'),
    setOnlineBackup: (enabled: boolean) => ipcRenderer.invoke('rt:online-backup-set', enabled),
    getExtraFolders: () => ipcRenderer.invoke('rt:backup-extra-folders-get'),
    addExtraFolder: () => ipcRenderer.invoke('rt:backup-extra-folders-add'),
    removeExtraFolder: (folder: string) => ipcRenderer.invoke('rt:backup-extra-folders-remove', folder),
    exportTo: (companyId: string, backupId: string) => ipcRenderer.invoke('rt:backup-export-to', companyId, backupId),
    importExternal: (companyId: string) => ipcRenderer.invoke('rt:backup-import-external', companyId),
  },
});

console.info('[rasetu preload] bridge ready');
