/**
 * Round 23 — persists the per-role printer configuration (Receipt / Label /
 * Invoice) to disk. Before this, electron/printer-api.ts's PrinterManager
 * only held settings in memory (`updateSettings()` never wrote to disk), so
 * every save was silently lost on the next app restart. Mirrors the exact
 * same direct-fs read/write pattern electron/main.ts already uses for
 * license-snapshot.json (licenseSnapshotPath()/readLicenseSnapshot()) —
 * this is per-device configuration, not per-company data, so it doesn't
 * belong in the backend's Setting table.
 */
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { PrinterSettings } from './printer-driver.js';

export type ThermalLayout = 'compact' | 'standard' | 'detailed' | 'receipt';
export type A4Layout = 'a4' | 'a5';
export type PrinterRole = 'receipt' | 'label';

export type PrinterConfig = {
  receipt: { printerName: string; defaultLayout: ThermalLayout };
  label: PrinterSettings;
  invoice: { printerName: string; defaultLayout: A4Layout; silent: boolean };
};

const DEFAULT_LABEL_SETTINGS: PrinterSettings = {
  name: '',
  dpi: 203,
  labelWidth: 101.6,
  labelHeight: 100,
  gapLength: 3.5,
  darknessFactor: 5,
  autoGapDetection: true,
  marginTop: 2,
  marginLeft: 2,
  marginRight: 2,
  marginBottom: 2,
};

export const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
  receipt: { printerName: '', defaultLayout: 'receipt' },
  label: DEFAULT_LABEL_SETTINGS,
  invoice: { printerName: '', defaultLayout: 'a4', silent: true },
};

function printerConfigPath(): string {
  return path.join(app.getPath('userData'), 'printer-config.json');
}

export function readPrinterConfig(): PrinterConfig {
  try {
    const stored = JSON.parse(fs.readFileSync(printerConfigPath(), 'utf8')) as Partial<PrinterConfig>;
    // Backfill any role a config saved before this round (or a future added
    // role) wouldn't have, same reasoning as receipt-settings.ts's zod
    // .default(...) backfill on the backend — a partially-shaped stored file
    // shouldn't crash every reader.
    return {
      receipt: { ...DEFAULT_PRINTER_CONFIG.receipt, ...stored.receipt },
      label: { ...DEFAULT_PRINTER_CONFIG.label, ...stored.label },
      invoice: { ...DEFAULT_PRINTER_CONFIG.invoice, ...stored.invoice },
    };
  } catch {
    return DEFAULT_PRINTER_CONFIG;
  }
}

export function writePrinterConfig(config: PrinterConfig): void {
  fs.mkdirSync(path.dirname(printerConfigPath()), { recursive: true });
  fs.writeFileSync(printerConfigPath(), JSON.stringify(config, null, 2));
}
