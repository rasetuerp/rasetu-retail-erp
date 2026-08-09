import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { requireAuth, requireCompanyDb } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { HttpError } from '../lib/http-error.js';
import { companyDbPath, companyBackupDir, resetCompanyClient, getCompanyClient } from '../db/company-registry.js';

// Round 7 — local database backup/restore, adapted from the manifest +
// SHA-256 + mandatory-pre-restore-safety-backup pattern GoBilling's own
// backend/src/routes/backups.ts already proved out. Electron (main.ts) only
// orchestrates *scheduling* and *destination* (local folder copy, R2 upload)
// — the actual backup file + manifest are always created here, since this
// process already owns the company .db file paths (company-registry.ts).

export const backupsRouter = Router({ mergeParams: true });

backupsRouter.use(requireAuth);

type DbManifest = {
  databaseId: string;
  createdAt: string;
  lastBackupAt?: string;
  lastBackupName?: string;
  restoredAt?: string;
  restoredFrom?: string;
};

type BackupManifest = {
  id: string;
  companyId: string;
  databaseId: string;
  reason: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
};

function dbManifestPath(companyId: string): string {
  return path.join(companyBackupDir(companyId), 'database-manifest.json');
}

function readDbManifest(companyId: string): DbManifest {
  const p = dbManifestPath(companyId);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  const created: DbManifest = { databaseId: crypto.randomUUID(), createdAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(created, null, 2));
  return created;
}

function writeDbManifest(companyId: string, manifest: DbManifest) {
  fs.writeFileSync(dbManifestPath(companyId), JSON.stringify(manifest, null, 2));
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function listBackupManifests(companyId: string): BackupManifest[] {
  const dir = companyBackupDir(companyId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.manifest.json') && f !== 'database-manifest.json')
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as BackupManifest)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

backupsRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const companyId = req.params.companyId;
    const dbPath = companyDbPath(companyId);
    if (!fs.existsSync(dbPath)) throw new HttpError(404, 'Company database not found');

    const stat = fs.statSync(dbPath);
    const manifest = readDbManifest(companyId);
    const backups = listBackupManifests(companyId);

    // Runs SQLite's own integrity check through the already-open connection
    // — no new dependency needed just for this, Prisma's raw-query escape
    // hatch already gets us there.
    const [integrityRow] = await prisma.$queryRawUnsafe<Array<{ integrity_check: string }>>('PRAGMA integrity_check');
    const healthMessage = integrityRow?.integrity_check ?? 'unknown';

    res.json({
      status: {
        databaseId: manifest.databaseId,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        lastBackupAt: manifest.lastBackupAt ?? null,
        lastBackupName: manifest.lastBackupName ?? null,
        restoredAt: manifest.restoredAt ?? null,
        healthy: healthMessage === 'ok',
        healthMessage,
        backupCount: backups.length,
      },
    });
  })
);

backupsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ backups: listBackupManifests(req.params.companyId) });
  })
);

const createBackupSchema = z.object({
  reason: z.enum(['manual', 'scheduled', 'pre-restore', 'pre-update']).default('manual'),
});

function createBackup(companyId: string, reason: string): BackupManifest {
  const dbPath = companyDbPath(companyId);
  if (!fs.existsSync(dbPath)) throw new HttpError(404, 'Company database not found');

  const dir = companyBackupDir(companyId);
  fs.mkdirSync(dir, { recursive: true });

  const id = `rasetu-${reason}-${isoStamp()}`;
  const backupPath = path.join(dir, `${id}.db`);
  fs.copyFileSync(dbPath, backupPath);

  const manifest: BackupManifest = {
    id,
    companyId,
    databaseId: readDbManifest(companyId).databaseId,
    reason,
    sha256: sha256File(backupPath),
    sizeBytes: fs.statSync(backupPath).size,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, `${id}.manifest.json`), JSON.stringify(manifest, null, 2));

  const dbManifest = readDbManifest(companyId);
  writeDbManifest(companyId, { ...dbManifest, lastBackupAt: manifest.createdAt, lastBackupName: id });

  return manifest;
}

backupsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createBackupSchema.parse(req.body ?? {});
    const manifest = createBackup(req.params.companyId, input.reason);
    res.status(201).json({ backup: manifest });
  })
);

const pruneSchema = z.object({ keepLatest: z.number().int().positive().default(12) });

backupsRouter.post(
  '/prune',
  asyncHandler(async (req, res) => {
    const input = pruneSchema.parse(req.body ?? {});
    const companyId = req.params.companyId;
    const dir = companyBackupDir(companyId);
    // Manual backups are kept forever — only automated ones (scheduled/
    // pre-restore/pre-update) get pruned, matching GoBilling's own
    // pruneAutomatedBackups() behavior.
    const automated = listBackupManifests(companyId).filter((b) => b.reason !== 'manual');
    const toDelete = automated.slice(input.keepLatest);
    for (const b of toDelete) {
      fs.rmSync(path.join(dir, `${b.id}.db`), { force: true });
      fs.rmSync(path.join(dir, `${b.id}.manifest.json`), { force: true });
    }
    res.json({ deleted: toDelete.map((b) => b.id) });
  })
);

const restoreSchema = z.object({ backupId: z.string(), confirm: z.literal('RESTORE') });

backupsRouter.post(
  '/restore',
  asyncHandler(async (req, res) => {
    // Touch the company DB once up front purely to confirm it's reachable
    // before we start disconnecting anything.
    requireCompanyDb(req);
    const input = restoreSchema.parse(req.body);
    const companyId = req.params.companyId;
    const dir = companyBackupDir(companyId);
    const manifestPath = path.join(dir, `${input.backupId}.manifest.json`);
    const backupPath = path.join(dir, `${input.backupId}.db`);
    if (!fs.existsSync(manifestPath) || !fs.existsSync(backupPath)) throw new HttpError(404, 'Backup not found');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
    if (manifest.companyId !== companyId) throw new HttpError(403, 'Backup does not belong to this company');

    const actualHash = sha256File(backupPath);
    if (actualHash !== manifest.sha256) {
      throw new HttpError(400, 'Backup file failed checksum verification — refusing to restore a corrupted backup');
    }

    // Always take a safety backup of the current state first, and archive
    // (never delete) the pre-restore file — a bad restore must itself be
    // reversible. Both are plain file copies, no live connection involved yet.
    createBackup(companyId, 'pre-restore');
    const dbPath = companyDbPath(companyId);
    const archivePath = path.join(dir, `${companyId}.before-restore-${isoStamp()}.db`);
    fs.copyFileSync(dbPath, archivePath);

    // Drop the cached connection (not just disconnect it) before swapping the
    // file out from under it — otherwise the next request could keep talking
    // to the old file handle instead of the restored one (see
    // company-registry.ts's resetCompanyClient comment).
    await resetCompanyClient(companyId);
    fs.copyFileSync(backupPath, dbPath);

    const dbManifest = readDbManifest(companyId);
    writeDbManifest(companyId, { ...dbManifest, restoredAt: new Date().toISOString(), restoredFrom: input.backupId });

    // Record the restore against the freshly-reopened (now-restored)
    // database, not the connection that just got dropped — otherwise this
    // audit entry would land in a file we're about to discard, and the fact
    // a restore happened would be invisible in the database that's actually
    // live afterward.
    const freshClient = getCompanyClient(companyId);
    await recordMutation(freshClient, {
      userId: req.user?.id,
      entity: 'Company',
      entityId: companyId,
      action: 'UPDATE',
      newValue: { restoredFrom: input.backupId },
      tableName: 'company',
      syncAction: 'UPDATE',
      payload: { restoredFrom: input.backupId },
    });

    res.json({ restored: input.backupId });
  })
);
