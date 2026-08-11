import { app, BrowserWindow, ipcMain, Menu, dialog } from 'electron';
import electronUpdater, { type Logger } from 'electron-updater';
const { autoUpdater } = electronUpdater;
import nodeMachineId from 'node-machine-id';
const { machineIdSync } = nodeMachineId;
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, type ChildProcess } from 'node:child_process';

import { getPrinterManager, initializePrinterManager } from './printer-api.js';
import { verifyValidationToken } from './license-verify.js';
import { readPrinterConfig, writePrinterConfig, type PrinterRole, type PrinterConfig } from './printer-config.js';

// v1-scoped main process. Covers: window lifecycle, backend process, printer IPC,
// license IPC, auto-update, and (Round 7) local/extra-folder/R2 database backups.

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let allowCloseAfterBackupPrompt = false;

const SUPABASE_URL = 'https://doopelkfucwiogrylysj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Fp4R_QUz_d_Hzs0pBA2eKw_986nPQzz';

function isBrokenPipeError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'EPIPE';
}

function swallowBrokenPipe(error: unknown) {
  if (!isBrokenPipeError(error)) throw error;
}

process.stdout?.on('error', swallowBrokenPipe);
process.stderr?.on('error', swallowBrokenPipe);

function mainLogPath() {
  return path.join(app.getPath('userData'), 'main.log');
}

function writeMainLog(level: string, message?: unknown) {
  try {
    fs.mkdirSync(path.dirname(mainLogPath()), { recursive: true });
    const text = message instanceof Error ? `${message.stack ?? message.message}` : typeof message === 'string' ? message : JSON.stringify(message);
    fs.appendFileSync(mainLogPath(), `[${new Date().toISOString()}] [${level}] ${text ?? ''}\n`);
  } catch {
    // Logging must never crash the packaged desktop app.
  }
}

function refreshEventsPath() {
  return path.join(app.getPath('userData'), 'diagnostics', 'refresh-events.jsonl');
}

function appendRefreshEvent(event: { source: string; route: string; suspectedFreeze: boolean; backendRunning: boolean }) {
  try {
    const filePath = refreshEventsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = {
      ...event,
      appVersion: app.getVersion(),
      platform: process.platform,
      createdAt: new Date().toISOString(),
    };
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
  } catch (err) {
    writeMainLog('warn', err);
  }
}

const fileLogger: Logger = {
  info: (message?: unknown) => writeMainLog('info', message),
  warn: (message?: unknown) => writeMainLog('warn', message),
  error: (message?: unknown) => writeMainLog('error', message),
  debug: (message: string) => writeMainLog('debug', message),
};

autoUpdater.logger = fileLogger;

function backendSecretPath() {
  return path.join(app.getPath('userData'), 'backend-secret.key');
}

function readOrCreateBackendSecret() {
  const secretPath = backendSecretPath();
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // First run: create a per-install JWT signing secret below.
  }

  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

function startBackend() {
  const backendEntry = isDev
    ? path.join(process.cwd(), 'backend', 'dist', 'index.js')
    : path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'dist', 'index.js');

  const logPath = path.join(app.getPath('userData'), 'backend.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');

  backendProcess = spawn(process.execPath, [backendEntry], {
    // Round 4: one catalog DB + one file per company, rooted under the OS
    // per-user data directory rather than inside the app bundle (see
    // backend/src/db/company-registry.ts).
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      RASETU_DATA_DIR: app.getPath('userData'),
      JWT_SECRET: process.env.JWT_SECRET ?? readOrCreateBackendSecret(),
      JWT_TTL_HOURS: process.env.JWT_TTL_HOURS ?? '12',
      SUPABASE_URL: process.env.SUPABASE_URL ?? SUPABASE_URL,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? SUPABASE_ANON_KEY,
    },
    stdio: ['ignore', logFd, logFd],
  });

  backendProcess.on('exit', (code) => {
    fs.closeSync(logFd);
    mainWindow?.webContents.send('rt:backend-status', { running: false, code });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    frame: false,
    // Packaged builds get their icon from electron-builder's win.icon
    // (embedded in the .exe); dev mode needs it set explicitly here or the
    // unpackaged window shows Electron's default icon instead of RaSetu's.
    ...(isDev ? { icon: path.join(process.cwd(), 'assets', 'icon.ico') } : {}),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);

  const frontendUrl = isDev
    ? 'http://localhost:5183'
    : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}`;
  void mainWindow.loadURL(frontendUrl);

  mainWindow.on('close', (event) => {
    if (allowCloseAfterBackupPrompt) return;
    const settings = readBackupSettings();
    if (!settings.backupBeforeClose || !isBackupDue(settings) || backupRuntimeState.running) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'question',
      buttons: ['Backup then close', 'Close without backup', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Backup due',
      message: 'A scheduled backup is due. Run backup before closing RaSetu?',
      detail: 'The backup runs in the background and the app will close safely when it finishes.',
    });
    if (choice === 2) return;
    if (choice === 1) {
      allowCloseAfterBackupPrompt = true;
      mainWindow?.close();
      return;
    }
    void runScheduledBackupCycle('close').finally(() => {
      writeBackupSettings({ ...readBackupSettings(), lastScheduledRunKey: backupRunKey(settings) });
      allowCloseAfterBackupPrompt = true;
      mainWindow?.close();
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startBackend();
  initializePrinterManager();
  createWindow();

  if (!isDev) {
    void autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      writeMainLog('warn', err);
      mainWindow?.webContents.send('rt:update-status', {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Round 7 — background backup cycle (local + extra folders + opt-in R2)
  // and license re-validation, on GoBilling's own proven cadence: first run
  // 5 minutes after launch (so a quick in-and-out session doesn't churn disk
  // for nothing), then every 6h (backups) / 4h (license). Each tick is
  // independent and swallows its own errors — see runScheduledBackupCycle's
  // and runLicenseRevalidation's own try/catch.
  setTimeout(() => {
    void runBackupSchedulerTick('startup');
    void runLicenseRevalidation();
  }, BACKUP_STARTUP_DELAY_MS);
  setInterval(() => void runBackupSchedulerTick('timer'), BACKUP_SCHEDULER_TICK_MS);
  setInterval(() => void runLicenseRevalidation(), LICENSE_CHECK_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  backendProcess?.kill();
  if (process.platform !== 'darwin') app.quit();
});

// ---------- window controls ----------
ipcMain.handle('rt:window-minimize', () => mainWindow?.minimize());
ipcMain.handle('rt:window-toggle-maximize', () =>
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()
);
ipcMain.handle('rt:window-close', () => mainWindow?.close());
ipcMain.handle('rt:window-state', () => ({
  isMaximized: mainWindow?.isMaximized() ?? false,
}));

// ---------- app / backend / update status ----------
ipcMain.handle('rt:ping', () => 'pong');
ipcMain.handle('rt:app-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
}));
ipcMain.handle('rt:backend-status', () => ({ running: backendProcess !== null && !backendProcess.killed }));
ipcMain.handle('rt:backend-restart', () => {
  backendProcess?.kill();
  startBackend();
});
ipcMain.handle('rt:app-refresh', (_event, payload?: { source?: string; route?: string; suspectedFreeze?: boolean }) => {
  const backendRunning = backendProcess !== null && !backendProcess.killed;
  appendRefreshEvent({
    source: payload?.source ?? 'manual',
    route: payload?.route ?? '',
    suspectedFreeze: Boolean(payload?.suspectedFreeze),
    backendRunning,
  });
  backendProcess?.kill();
  startBackend();
  return { loggedAt: new Date().toISOString(), backendRestarted: true };
});
ipcMain.handle('rt:update-check', async () => {
  try {
    return await autoUpdater.checkForUpdates();
  } catch (err) {
    writeMainLog('warn', err);
    return {
      updateInfo: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});
ipcMain.handle('rt:update-install', () => autoUpdater.quitAndInstall());
ipcMain.handle('rt:get-machine-id', () => machineIdSync(true));

// Must be kept in sync with src/lib/license.ts's identical constants — main.ts
// needs its own copy for the background license-revalidation and R2-backup
// calls below (Node/Electron main process, can't import renderer-side modules).
const LICENSE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
const LICENSE_ANON_KEY = SUPABASE_ANON_KEY;

// ---------- licensing (docs/COMMERCIAL.md, Round 4) ----------
// One license per installed copy (machine), not per company — gates the
// whole app before even the company picker. Stored as a local JSON
// snapshot (not a DB row): license state is machine-level, independent of
// which/how-many companies exist. See docs/plan Round 4 design decision #2.
type LicenseSnapshot = {
  licenseKey: string;
  machineId: string;
  validationToken: string;
  lastValidAt: string;
};

function licenseSnapshotPath() {
  return path.join(app.getPath('userData'), 'license-snapshot.json');
}

function readLicenseSnapshot(): LicenseSnapshot | null {
  try {
    return JSON.parse(fs.readFileSync(licenseSnapshotPath(), 'utf8')) as LicenseSnapshot;
  } catch {
    return null;
  }
}

ipcMain.handle('rt:license-verify-token', (_event, token: string) => verifyValidationToken(token));

ipcMain.handle('rt:license-save-snapshot', (_event, snapshot: LicenseSnapshot) => {
  fs.mkdirSync(path.dirname(licenseSnapshotPath()), { recursive: true });
  fs.writeFileSync(licenseSnapshotPath(), JSON.stringify(snapshot, null, 2));
  return true;
});

ipcMain.handle('rt:license-clear-snapshot', () => {
  try {
    fs.unlinkSync(licenseSnapshotPath());
  } catch {
    // already gone — fine
  }
  return true;
});

ipcMain.handle('rt:license-get-snapshot', () => readLicenseSnapshot());

// Offline-first startup check: verify the cached token's own signature +
// expiry (no network round trip) — this IS the offline grace period, sized
// by the Edge Function's token TTL (30 days), not a separate mechanism.
ipcMain.handle('rt:license-startup-status', () => {
  const snapshot = readLicenseSnapshot();
  if (!snapshot) return { hasValidLicense: false };

  const verified = verifyValidationToken(snapshot.validationToken);
  if (!verified || verified.validUntil < new Date() || verified.status === 'BLOCKED') {
    return { hasValidLicense: false };
  }

  return { hasValidLicense: true, license: verified, snapshot };
});

// ---------- printer bridge (docs/ARCHITECTURE.md — ported from GoBilling) ----------
// Round 23 — receipts and labels are now two separately-configured printers.
// `printerName` args from the bridge are repurposed as a role selector
// ('receipt' | anything else treated as 'label') rather than being ignored;
// printLabel/printBatch are always label-domain and printRaw is always
// receipt-domain, so those don't need the caller to pass a role at all.
function resolveRole(printerName: string | undefined): PrinterRole {
  return printerName === 'receipt' ? 'receipt' : 'label';
}

ipcMain.handle('rt:printer-list', async () => getPrinterManager('label').listSystemPrinters());
ipcMain.handle('rt:printer-default', async () => getPrinterManager('label').getSettings());
ipcMain.handle('rt:printer-settings-get', async (_event, printerName: string) =>
  getPrinterManager(resolveRole(printerName)).getSettings()
);
ipcMain.handle('rt:printer-settings-save', async (_event, printerName: string, settings) =>
  getPrinterManager(resolveRole(printerName)).updateSettings(settings)
);
ipcMain.handle('rt:printer-print-label', async (_event, _printerName: string, labelData) =>
  getPrinterManager('label').printLabel(labelData.template, labelData.data, labelData.copies ?? 1)
);
// Round 5 — Bulk Stock Entry's "print labels for this batch" action.
// printer-api.ts's printBatch() already existed (loops printLabel per item,
// aggregates a success count) but was never exposed through this bridge.
ipcMain.handle('rt:printer-print-batch', async (_event, _printerName: string, labels) => getPrinterManager('label').printBatch(labels));
ipcMain.handle('rt:printer-print-raw', async (_event, _printerName: string, rawData) =>
  getPrinterManager('receipt').printRawCommands(rawData)
);
ipcMain.handle('rt:printer-print-test', async (_event, printerName: string) =>
  getPrinterManager(resolveRole(printerName)).printTestLabel()
);
ipcMain.handle('rt:printer-test-connection', async (_event, printerName: string) =>
  getPrinterManager(resolveRole(printerName)).testConnection()
);

// Round 23 — the full 3-role config (receipt/label/invoice), including the
// fields (defaultLayout, invoice.silent) that live outside PrinterManager's
// TSPL-oriented PrinterSettings shape entirely. Label's own printer name +
// TSPL settings still round-trip through rt:printer-settings-save above (so
// its live PrinterManager instance updates immediately); this save path is
// for the receipt/invoice sections and for label's non-PrinterManager fields.
ipcMain.handle('rt:printer-config-get', async () => readPrinterConfig());
ipcMain.handle('rt:printer-config-save', async (_event, role: keyof PrinterConfig, patch: Record<string, unknown>) => {
  const config = readPrinterConfig();
  if (role === 'receipt') {
    config.receipt = { ...config.receipt, ...patch } as PrinterConfig['receipt'];
  } else if (role === 'label') {
    config.label = { ...config.label, ...patch } as PrinterConfig['label'];
  } else {
    config.invoice = { ...config.invoice, ...patch } as PrinterConfig['invoice'];
  }
  writePrinterConfig(config);
  // Keep the receipt PrinterManager's in-memory printer name in sync so a
  // saved name takes effect without requiring an app restart (label already
  // does this via updateSettings(); receipt has no equivalent settings UI).
  if (role === 'receipt' && typeof patch.printerName === 'string') {
    getPrinterManager('receipt').updateSettings({ name: patch.printerName });
  }
  return config;
});

// Round 23 — A4/A5 invoices used to always fall through to the renderer's
// plain window.open()+print(), which always shows the OS print dialog and
// has no way to target a specific printer. This loads the already-built
// invoice HTML into a hidden, throwaway window and prints it directly.
ipcMain.handle('rt:printer-print-a4', async (_event, html: string, printerName: string, silent: boolean) => {
  const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise<void>((resolve, reject) => {
      printWindow.webContents.print(
        { silent, deviceName: printerName || undefined, printBackground: true },
        (success, errorType) => {
          if (success) resolve();
          else reject(new Error(errorType || 'Print failed'));
        }
      );
    });
    return { success: true };
  } finally {
    printWindow.destroy();
  }
});

autoUpdater.on('update-available', () => mainWindow?.webContents.send('rt:update-status', { status: 'available' }));
autoUpdater.on('update-downloaded', () => mainWindow?.webContents.send('rt:update-status', { status: 'downloaded' }));
autoUpdater.on('error', (err) => {
  writeMainLog('warn', err);
  mainWindow?.webContents.send('rt:update-status', {
    status: 'error',
    message: err instanceof Error ? err.message : String(err),
  });
});

// ---------- backups (Round 7) ----------
// Electron owns SCHEDULED backups end-to-end, directly at the filesystem
// level (local copy, extra-folder copy, R2 upload) — this runs regardless of
// whether anyone is logged into the renderer, so it can't go through the
// backend's authenticated HTTP API. It writes the SAME on-disk manifest
// format backend/src/routes/backups.ts reads (id/companyId/reason/sha256/
// sizeBytes/createdAt), so the Settings UI's backup list shows both kinds
// together. Anything the logged-in user explicitly triggers (manual backup,
// restore, list) goes through that authenticated backend API instead — this
// file only provides thin native-dialog utilities for those (folder/file
// pickers), never duplicates the restore logic itself.
const BACKUP_STARTUP_DELAY_MS = 5 * 60 * 1000;
const BACKUP_SCHEDULER_TICK_MS = 60 * 1000;
const LICENSE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const LOCAL_KEEP_LATEST = 2;
const EXTRA_FOLDER_KEEP_LATEST = 2;

type BackupManifestLite = {
  id: string;
  companyId: string;
  reason: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
};

type BackupSettings = {
  onlineBackupEnabled: boolean;
  extraFolders: string[];
  scheduleEnabled: boolean;
  frequency: 'daily' | 'weekly';
  time: string;
  weekday: number;
  backupBeforeClose: boolean;
  paused: boolean;
  lastScheduledRunKey?: string;
};
type BackupRuntimeState = {
  running: boolean;
  mode: 'idle' | 'manual' | 'scheduled' | 'close';
  startedAt?: string;
  finishedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  currentCompanyId?: string;
  pauseRequested: boolean;
};
type OffsiteBackupState = { lastUploadAt?: string; fileName?: string; bytes?: number; databaseHash?: string };

const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  onlineBackupEnabled: false,
  extraFolders: [],
  scheduleEnabled: true,
  frequency: 'daily',
  time: '19:00',
  weekday: 1,
  backupBeforeClose: true,
  paused: false,
};
const backupRuntimeState: BackupRuntimeState = { running: false, mode: 'idle', pauseRequested: false };

function companiesDataDir() {
  return path.join(app.getPath('userData'), 'companies');
}
function backupsRootDir() {
  return path.join(app.getPath('userData'), 'backups');
}
function companyBackupDir(companyId: string) {
  return path.join(backupsRootDir(), companyId);
}
function backupSettingsPath() {
  return path.join(app.getPath('userData'), 'backup-settings.json');
}
function offsiteBackupStatePath(companyId: string) {
  return path.join(companyBackupDir(companyId), 'offsite-backup-state.json');
}

function readBackupSettings(): BackupSettings {
  try {
    return { ...DEFAULT_BACKUP_SETTINGS, ...JSON.parse(fs.readFileSync(backupSettingsPath(), 'utf8')) };
  } catch {
    return DEFAULT_BACKUP_SETTINGS;
  }
}
function writeBackupSettings(settings: BackupSettings) {
  fs.mkdirSync(path.dirname(backupSettingsPath()), { recursive: true });
  fs.writeFileSync(backupSettingsPath(), JSON.stringify(settings, null, 2));
}

function readOffsiteState(companyId: string): OffsiteBackupState {
  try {
    return JSON.parse(fs.readFileSync(offsiteBackupStatePath(companyId), 'utf8'));
  } catch {
    return {};
  }
}
function writeOffsiteState(companyId: string, state: OffsiteBackupState) {
  fs.mkdirSync(path.dirname(offsiteBackupStatePath(companyId)), { recursive: true });
  fs.writeFileSync(offsiteBackupStatePath(companyId), JSON.stringify(state, null, 2));
}

function isoStampSafe() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Directory-scan fallback (pre-Round-9 behavior) — internal companies only, used when the backend can't be reached so a backend hiccup degrades to "internal only" rather than skipping every company's backup. */
function listCompanyDbFilesFromDisk(): Array<{ companyId: string; dbPath: string }> {
  const dir = companiesDataDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ companyId: f.replace(/\.db$/, ''), dbPath: path.join(dir, f) }));
}

/**
 * Every company currently reachable on this machine — internal (fixed
 * <userData>/companies/<id>.db) or external (Round 9: on a removable/external
 * drive, only counted if that drive is plugged in right now). Asks the
 * backend rather than scanning a fixed folder, since companies can now live
 * elsewhere and only the backend can resolve an external company's current
 * path (drivelist/PowerShell volume lookups are intentionally backend-only —
 * see backend/src/lib/drives.ts). Falls back to the old directory-scan (which
 * only ever covered internal companies anyway) if the backend isn't
 * reachable, so one destination failing never blocks the others — same
 * philosophy as this file's per-destination try/catch in
 * runScheduledBackupCycle below.
 */
async function listCompanyDbFiles(): Promise<Array<{ companyId: string; dbPath: string }>> {
  try {
    const res = await fetch('http://localhost:4100/companies');
    if (!res.ok) return listCompanyDbFilesFromDisk();
    const payload = (await res.json()) as { companies?: Array<{ id: string; resolvedDbPath?: string }> };
    if (!payload.companies) return listCompanyDbFilesFromDisk();
    return payload.companies
      .filter((c) => c.resolvedDbPath)
      .map((c) => ({ companyId: c.id, dbPath: c.resolvedDbPath! }));
  } catch {
    return listCompanyDbFilesFromDisk();
  }
}

async function createLocalBackup(companyId: string, dbPath: string, reason: string): Promise<BackupManifestLite> {
  const dir = companyBackupDir(companyId);
  await fs.promises.mkdir(dir, { recursive: true });
  const id = `rasetu-${reason}-${isoStampSafe()}`;
  const backupPath = path.join(dir, `${id}.db`);
  await fs.promises.copyFile(dbPath, backupPath);
  const stat = await fs.promises.stat(backupPath);
  const manifest: BackupManifestLite = {
    id,
    companyId,
    reason,
    sha256: await sha256File(backupPath),
    sizeBytes: stat.size,
    createdAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(path.join(dir, `${id}.manifest.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}

function pruneAutomatedBackups(companyId: string, keepLatest: number) {
  const dir = companyBackupDir(companyId);
  if (!fs.existsSync(dir)) return;
  const automated = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.manifest.json') && f !== 'offsite-backup-state.json')
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as BackupManifestLite)
    .filter((m) => m.reason !== 'manual')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const m of automated.slice(keepLatest)) {
    fs.rmSync(path.join(dir, `${m.id}.db`), { force: true });
    fs.rmSync(path.join(dir, `${m.id}.manifest.json`), { force: true });
  }
}

function pruneExtraFolderCopies(folder: string, companyId: string, keepLatest: number) {
  if (!fs.existsSync(folder)) return;
  const prefix = `rasetu-backup-${companyId}-`;
  const files = fs
    .readdirSync(folder)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
    .sort()
    .reverse();
  for (const f of files.slice(keepLatest)) {
    try {
      fs.rmSync(path.join(folder, f), { force: true });
    } catch {
      // folder might be a cloud-sync mount with a file mid-sync — tolerate silently, matches GoBilling's own behavior
    }
  }
}

/** Gzips + uploads a backup file to Cloudflare R2 via the backup-upload Supabase Edge Function (presigned PUT URL). Skips if unchanged since the last upload. */
async function uploadToR2(companyId: string, backupFilePath: string): Promise<void> {
  const snapshot = readLicenseSnapshot();
  if (!snapshot) throw new Error('No active license — cloud backup needs an activated license');

  const gz = zlib.gzipSync(fs.readFileSync(backupFilePath));
  const hash = crypto.createHash('sha256').update(gz).digest('hex');

  const state = readOffsiteState(companyId);
  if (state.databaseHash === hash) return; // nothing changed since the last upload — save bandwidth

  const fileName = `${companyId}-${isoStampSafe()}.db.gz`;
  const res = await fetch(`${LICENSE_FUNCTIONS_URL}/backup-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LICENSE_ANON_KEY}` },
    body: JSON.stringify({ key: snapshot.licenseKey, machineId: snapshot.machineId, companyId, fileName, sizeBytes: gz.length }),
  });
  const payload = (await res.json().catch(() => ({}))) as { data?: { uploadUrl?: string; fileName?: string }; message?: string };
  if (!res.ok || !payload.data?.uploadUrl) throw new Error(payload.message ?? 'Failed to get an upload URL for cloud backup');

  const putRes = await fetch(payload.data.uploadUrl, { method: 'PUT', body: gz, headers: { 'Content-Type': 'application/gzip' } });
  if (!putRes.ok) throw new Error(`Cloud backup upload failed with status ${putRes.status}`);

  writeOffsiteState(companyId, { lastUploadAt: new Date().toISOString(), fileName: payload.data.fileName ?? fileName, bytes: gz.length, databaseHash: hash });
}

function backupRunKey(settings: BackupSettings, date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return settings.frequency === 'weekly' ? `${day}-w${settings.weekday}` : day;
}

function isBackupDue(settings: BackupSettings, now = new Date()): boolean {
  if (!settings.scheduleEnabled || settings.paused) return false;
  if (settings.frequency === 'weekly' && now.getDay() !== settings.weekday) return false;
  const [hour, minute] = settings.time.split(':').map((n) => Number(n));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const due = new Date(now);
  due.setHours(hour, minute, 0, 0);
  return now >= due && settings.lastScheduledRunKey !== backupRunKey(settings, now);
}

function publishBackupStatus() {
  mainWindow?.webContents.send('rt:backup-status', { settings: readBackupSettings(), state: backupRuntimeState });
}

/** Local backup + every configured extra folder + opt-in R2 upload, for every company on this machine. Each destination is independent; one failing destination must never block the others. */
async function runScheduledBackupCycle(mode: 'manual' | 'scheduled' | 'close' = 'scheduled'): Promise<void> {
  if (backupRuntimeState.running) return;
  const settings = readBackupSettings();
  backupRuntimeState.running = true;
  backupRuntimeState.mode = mode;
  backupRuntimeState.startedAt = new Date().toISOString();
  backupRuntimeState.finishedAt = undefined;
  backupRuntimeState.lastError = undefined;
  backupRuntimeState.pauseRequested = false;
  publishBackupStatus();

  for (const { companyId, dbPath } of await listCompanyDbFiles()) {
    if (backupRuntimeState.pauseRequested || readBackupSettings().paused) break;
    backupRuntimeState.currentCompanyId = companyId;
    publishBackupStatus();
    try {
      const manifest = await createLocalBackup(companyId, dbPath, mode === 'manual' ? 'manual' : 'scheduled');
      pruneAutomatedBackups(companyId, LOCAL_KEEP_LATEST);
      const backupFilePath = path.join(companyBackupDir(companyId), `${manifest.id}.db`);

      for (const folder of settings.extraFolders) {
        if (backupRuntimeState.pauseRequested || readBackupSettings().paused) break;
        try {
          await fs.promises.mkdir(folder, { recursive: true });
          await fs.promises.copyFile(backupFilePath, path.join(folder, `rasetu-backup-${companyId}-${isoStampSafe()}.db`));
          pruneExtraFolderCopies(folder, companyId, EXTRA_FOLDER_KEEP_LATEST);
        } catch (err) {
          console.error('[backup] extra-folder copy failed', folder, err);
        }
      }

      if (settings.onlineBackupEnabled && !backupRuntimeState.pauseRequested && !readBackupSettings().paused) {
        try {
          await uploadToR2(companyId, backupFilePath);
        } catch (err) {
          console.error('[backup] R2 upload failed', companyId, err);
        }
      }
    } catch (err) {
      backupRuntimeState.lastError = err instanceof Error ? err.message : String(err);
      console.error('[backup] scheduled backup failed for company', companyId, err);
    }
  }

  backupRuntimeState.running = false;
  backupRuntimeState.mode = 'idle';
  backupRuntimeState.currentCompanyId = undefined;
  backupRuntimeState.finishedAt = new Date().toISOString();
  if (!backupRuntimeState.lastError) backupRuntimeState.lastSuccessAt = backupRuntimeState.finishedAt;
  publishBackupStatus();
}

async function runBackupSchedulerTick(_source: 'startup' | 'timer') {
  const settings = readBackupSettings();
  if (!isBackupDue(settings)) return;
  await runScheduledBackupCycle('scheduled');
  writeBackupSettings({ ...readBackupSettings(), lastScheduledRunKey: backupRunKey(settings) });
}
/** Best-effort background license re-check, mirrors src/lib/license.ts's revalidateLicenseInBackground() but from the main process so it can broadcast rt:license-blocked if a check newly blocks the app. */
async function runLicenseRevalidation(): Promise<void> {
  const snapshot = readLicenseSnapshot();
  if (!snapshot) return;

  try {
    const res = await fetch(`${LICENSE_FUNCTIONS_URL}/license-validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LICENSE_ANON_KEY}` },
      body: JSON.stringify({ key: snapshot.licenseKey, machineId: snapshot.machineId }),
    });
    const payload = (await res.json().catch(() => ({}))) as { data?: { ok?: boolean; validationToken?: string }; valid?: boolean };
    const ok = payload.data?.ok ?? payload.valid ?? false;
    if (!res.ok || !ok || !payload.data?.validationToken) return; // offline or a transient failure — leave the last-known-good snapshot in place

    fs.writeFileSync(
      licenseSnapshotPath(),
      JSON.stringify({ ...snapshot, validationToken: payload.data.validationToken, lastValidAt: new Date().toISOString() }, null, 2)
    );

    const verified = verifyValidationToken(payload.data.validationToken);
    if (verified?.status === 'BLOCKED') {
      mainWindow?.webContents.send('rt:license-blocked', { status: verified.status });
    }
  } catch {
    // offline — same tolerance as revalidateLicenseInBackground()
  }
}

ipcMain.handle('rt:backup-status-get', () => ({ settings: readBackupSettings(), state: backupRuntimeState }));
ipcMain.handle('rt:backup-settings-get', () => readBackupSettings());
ipcMain.handle('rt:backup-settings-save', (_event, patch: Partial<BackupSettings>) => {
  const next = { ...readBackupSettings(), ...patch };
  writeBackupSettings(next);
  publishBackupStatus();
  return next;
});
ipcMain.handle('rt:backup-pause', () => {
  backupRuntimeState.pauseRequested = true;
  writeBackupSettings({ ...readBackupSettings(), paused: true });
  publishBackupStatus();
  return { settings: readBackupSettings(), state: backupRuntimeState };
});
ipcMain.handle('rt:backup-resume', () => {
  backupRuntimeState.pauseRequested = false;
  writeBackupSettings({ ...readBackupSettings(), paused: false });
  publishBackupStatus();
  return { settings: readBackupSettings(), state: backupRuntimeState };
});

ipcMain.handle('rt:backup-run-now', async () => {
  await runScheduledBackupCycle('manual');
  return { ranAt: new Date().toISOString() };
});

ipcMain.handle('rt:offsite-backup-now', async () => {
  const settings = readBackupSettings();
  if (!settings.onlineBackupEnabled) throw new Error('Cloud backup is not enabled — turn it on first.');
  const results: Array<{ companyId: string; ok: boolean; error?: string }> = [];
  for (const { companyId, dbPath } of await listCompanyDbFiles()) {
    try {
      const manifest = await createLocalBackup(companyId, dbPath, 'scheduled');
      await uploadToR2(companyId, path.join(companyBackupDir(companyId), `${manifest.id}.db`));
      results.push({ companyId, ok: true });
    } catch (err) {
      results.push({ companyId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results };
});

ipcMain.handle('rt:online-backup-set', (_event, enabled: boolean) => {
  const settings = readBackupSettings();
  writeBackupSettings({ ...settings, onlineBackupEnabled: enabled });
  return { onlineBackupEnabled: enabled };
});

ipcMain.handle('rt:backup-extra-folders-get', () => readBackupSettings().extraFolders);

ipcMain.handle('rt:backup-extra-folders-add', async () => {
  if (!mainWindow) return readBackupSettings().extraFolders;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose a backup destination (e.g. a Google Drive / OneDrive sync folder, or an external drive)',
  });
  if (result.canceled || !result.filePaths[0]) return readBackupSettings().extraFolders;
  const settings = readBackupSettings();
  const folders = [...new Set([...settings.extraFolders, result.filePaths[0]])];
  writeBackupSettings({ ...settings, extraFolders: folders });
  return folders;
});

ipcMain.handle('rt:backup-extra-folders-remove', (_event, folder: string) => {
  const settings = readBackupSettings();
  const folders = settings.extraFolders.filter((f) => f !== folder);
  writeBackupSettings({ ...settings, extraFolders: folders });
  return folders;
});

ipcMain.handle('rt:backup-export-to', async (_event, companyId: string, backupId: string) => {
  const sourcePath = path.join(companyBackupDir(companyId), `${backupId}.db`);
  if (!fs.existsSync(sourcePath)) throw new Error('That backup file no longer exists.');
  if (!mainWindow) throw new Error('No window available for the save dialog.');

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export backup to...',
    defaultPath: `${backupId}.db`,
    filters: [{ name: 'RaSetu database backup', extensions: ['db'] }],
  });
  if (result.canceled || !result.filePath) return { exported: false };
  await fs.promises.copyFile(sourcePath, result.filePath);
  return { exported: true, path: result.filePath };
});

// Ingests an externally-picked .db file into this company's recognized
// backup format (copy + manifest) so the existing, already-checksum-verified
// POST /restore endpoint can restore from it uniformly — Electron never
// performs the restore itself, it just makes an external file look like any
// other backup on disk.
ipcMain.handle('rt:backup-import-external', async (_event, companyId: string) => {
  if (!mainWindow) throw new Error('No window available for the open dialog.');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Import a backup file (.db)',
    filters: [{ name: 'RaSetu database backup', extensions: ['db'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { imported: false };

  const manifest = await createLocalBackup(companyId, result.filePaths[0], 'imported');
  return { imported: true, backupId: manifest.id };
});
