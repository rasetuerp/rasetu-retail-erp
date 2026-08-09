import { prisma as catalogPrisma } from '../db/catalog-client.js';
import { getReadyCompanyClient } from '../db/company-registry.js';
import { resolveExternalCompanyPath, type CompanyStorageRow } from './company-storage.js';
import { readLicenseKey } from './license-snapshot.js';

// Round 4 — one-way push (backup to cloud), deliberately minimal, matching
// docs/ARCHITECTURE.md's already-decided sync design. No license activated
// yet → nothing to authenticate a push with → the worker just quietly skips
// until one exists. See license-snapshot.ts for how readLicenseKey() reaches
// the snapshot file from this (non-renderer) process.
const SYNC_PUSH_URL = 'https://doopelkfucwiogrylysj.supabase.co/functions/v1/sync-push';
const SYNC_ANON_KEY = 'sb_publishable_Fp4R_QUz_d_Hzs0pBA2eKw_986nPQzz';
const POLL_INTERVAL_MS = 60_000;
const BATCH_SIZE = 100;

async function pushCompany(companyId: string, licenseKey: string): Promise<void> {
  const db = await getReadyCompanyClient(companyId);
  const unsynced = await db.syncQueue.findMany({
    where: { synced: false },
    take: BATCH_SIZE,
    orderBy: { createdAt: 'asc' },
  });
  if (unsynced.length === 0) return;

  const res = await fetch(SYNC_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_ANON_KEY}` },
    body: JSON.stringify({
      licenseKey,
      companyId,
      rows: unsynced.map((r) => ({
        tableName: r.tableName,
        rowId: r.rowId,
        action: r.action,
        payload: JSON.parse(r.payload) as unknown, // SyncQueue.payload is a JSON string; the Edge Function's column is jsonb
        createdAt: r.createdAt.toISOString(),
      })),
    }),
  });
  if (!res.ok) return; // retry next tick — could be offline, or a transient Edge Function error

  await db.syncQueue.updateMany({
    where: { id: { in: unsynced.map((r) => r.id) } },
    data: { synced: true, syncedAt: new Date() },
  });
}

async function tick(): Promise<void> {
  const licenseKey = readLicenseKey();
  if (!licenseKey) return;

  try {
    const companies = await catalogPrisma.company.findMany({
      select: { id: true, storageType: true, dbDir: true, volumeId: true },
    });
    for (const company of companies) {
      const availability = await resolveExternalCompanyPath(company as CompanyStorageRow);
      if (!availability.available) continue;
      await pushCompany(company.id, licenseKey).catch((err: unknown) => {
        console.error(`[sync-worker] push failed for company ${company.id}:`, err);
      });
    }
  } catch (err) {
    console.error('[sync-worker] tick failed:', err);
  }
}

export function startSyncWorker(): NodeJS.Timeout {
  void tick();
  return setInterval(() => void tick(), POLL_INTERVAL_MS);
}
