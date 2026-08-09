// Shared ambient type for window.rasetu (electron/preload.ts's exposed
// bridge) — infrastructure, not a page (same exemption as api.ts/theme.ts).
// TypeScript requires every `declare global { interface Window { rasetu... } }`
// augmentation of the same property to match exactly, so this is the one
// place it's declared; pages/lib files consume it, none re-declare it.
export {};

// Round 23 — per-role printer config shape, mirrors electron/printer-config.ts
// (kept as a separate declaration rather than a cross-import since electron/
// and src/ compile under separate tsconfigs).
export type ThermalLayout = 'compact' | 'standard' | 'detailed' | 'receipt';
export type A4Layout = 'a4' | 'a5';
export type LabelPrinterSettings = {
  name: string;
  dpi: number;
  labelWidth: number;
  labelHeight: number;
  printAreaWidth?: number;
  printAreaHeight?: number;
  printAreaOffsetX?: number;
  printAreaOffsetY?: number;
  orientation?: string;
  gapLength: number;
  darknessFactor: number;
  autoGapDetection: boolean;
  marginTop: number;
  marginLeft: number;
  marginRight: number;
  marginBottom: number;
};
export type PrinterConfig = {
  receipt: { printerName: string; defaultLayout: ThermalLayout };
  label: LabelPrinterSettings;
  invoice: { printerName: string; defaultLayout: A4Layout; silent: boolean };
};

declare global {
  interface Window {
    rasetu?: {
      platform: string;
      ping: () => Promise<string>;
      getAppInfo: () => Promise<{ name: string; version: string }>;
      getUpdateStatus: () => Promise<unknown>;
      getBackendStatus: () => Promise<{ running: boolean }>;
      restartBackend: () => Promise<void>;
      checkForUpdates: () => Promise<unknown>;
      installUpdate: () => Promise<void>;
      onUpdateStatus: (callback: (payload: unknown) => void) => () => void;
      windowControls: {
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<void>;
        close: () => Promise<void>;
        getState: () => Promise<{ isMaximized: boolean }>;
      };
      getMachineId: () => Promise<string>;

      // Licensing (Round 4)
      saveLicenseSnapshot: (snapshot: {
        licenseKey: string;
        machineId: string;
        validationToken: string;
        lastValidAt: string;
      }) => Promise<boolean>;
      clearLicenseSnapshot: () => Promise<boolean>;
      getStartupLicenseStatus: () => Promise<
        | { hasValidLicense: false }
        | {
            hasValidLicense: true;
            license: { status: string; type: string; validUntil: string; amcExpiresOn: string | null };
            // lastValidAt (Round 9) — the offline-grace clock: days since this
            // timestamp is what getOfflineGraceInfo() in src/lib/license.ts
            // measures against the 7-day soft grace / validUntil hard cutoff.
            snapshot: { licenseKey: string; lastValidAt: string };
          }
      >;
      getLicenseSnapshot: () => Promise<{ licenseKey: string; machineId: string; validationToken: string; lastValidAt: string } | null>;
      onLicenseBlocked: (callback: (payload: unknown) => void) => () => void;

      printer: {
        listPrinters: () => Promise<unknown>;
        getDefaultPrinter: () => Promise<unknown>;
        getPrinterSettings: (printerName: string) => Promise<unknown>;
        savePrinterSettings: (printerName: string, settings: unknown) => Promise<unknown>;
        printLabel: (printerName: string, labelData: unknown) => Promise<{ success: boolean; message: string }>;
        printBatch: (printerName: string, labels: unknown) => Promise<{ success: boolean; message: string }>;
        printRaw: (printerName: string, rawData: string) => Promise<{ success: boolean; message: string; error?: string }>;
        printTest: (printerName: string) => Promise<unknown>;
        testPrinterConnection: (printerName: string) => Promise<unknown>;

        // Round 23 — per-role config (receipt/label/invoice), persisted to disk.
        getConfig: () => Promise<PrinterConfig>;
        saveConfig: (role: 'receipt' | 'label' | 'invoice', patch: unknown) => Promise<PrinterConfig>;
        printA4: (html: string, printerName: string, silent: boolean) => Promise<{ success: boolean }>;
      };

      backup: {
        runNow: () => Promise<{ ranAt: string }>;
        offsiteBackupNow: () => Promise<{ results: Array<{ companyId: string; ok: boolean; error?: string }> }>;
        setOnlineBackup: (enabled: boolean) => Promise<{ onlineBackupEnabled: boolean }>;
        getExtraFolders: () => Promise<string[]>;
        addExtraFolder: () => Promise<string[]>;
        removeExtraFolder: (folder: string) => Promise<string[]>;
        exportTo: (companyId: string, backupId: string) => Promise<{ exported: boolean; path?: string }>;
        importExternal: (companyId: string) => Promise<{ imported: boolean; backupId?: string }>;
      };
    };
  }
}
