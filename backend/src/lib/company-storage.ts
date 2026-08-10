import path from 'node:path';

import { prisma } from '../db/catalog-client.js';
import { setResolvedExternalDbPath, clearResolvedExternalDbPath, markKnownExternalCompany, resetCompanyClient } from '../db/company-registry.js';
import { findDriveByVolumeId, type DriveInfo } from './drives.js';
import { HttpError } from './http-error.js';

// Round 9 — resolves an externally-stored company's CURRENT absolute
// database path against its stable volumeId, never the last-seen mount
// path (drive letters aren't stable — see drives.ts). Call this before
// touching an external company's DB (company presence checks, login,
// backups) so company-registry.ts's cache is fresh for this process.

export type CompanyStorageRow = {
  id: string;
  storageType: string;
  dbDir: string | null;
  volumeId: string | null;
};

export function externalDbDir(companyId: string): string {
  return path.join('RaSetuData', 'companies', companyId);
}

export function externalDbPath(mountpoint: string, dbDir: string, companyId: string): string {
  return path.join(mountpoint, dbDir, `${companyId}.db`);
}

export type StorageAvailability = { available: true; drive: DriveInfo } | { available: false; drive: null };

/**
 * For an internal company, always "available" (nothing to resolve). For an
 * external company, looks up its volume among currently-mounted drives; if
 * found, caches the current absolute path so company-registry.ts's
 * companyDbPath() resolves correctly for the rest of this process, and
 * returns available:true. If the drive isn't plugged in right now, clears
 * any stale cache entry and returns available:false — callers use this to
 * decide whether to show/allow access to the company at all.
 */
export async function resolveExternalCompanyPath(company: CompanyStorageRow): Promise<StorageAvailability> {
  if (company.storageType !== 'external') return { available: true, drive: null as unknown as DriveInfo };
  markKnownExternalCompany(company.id);
  if (!company.volumeId || !company.dbDir) return { available: false, drive: null };

  const drive = await findDriveByVolumeId(company.volumeId);
  if (!drive) {
    clearResolvedExternalDbPath(company.id);
    return { available: false, drive: null };
  }

  setResolvedExternalDbPath(company.id, externalDbPath(drive.mountpoint, company.dbDir, company.id));
  return { available: true, drive };
}

/**
 * Guards login routes reached without first going through GET /companies
 * (manual company-ID entry, Super Admin support "enter") — resolves and
 * caches an external company's current path, or throws if its drive isn't
 * plugged in right now. No-op (and no throw) for a company that doesn't
 * exist at all — callers already have their own 404 for that case.
 *
 * Also drops any cached Prisma client for an external company (RULES.md —
 * see PENDING.md "drive reconnect leaves a stale DB connection" fix, found
 * during Round 9's live hardware test). A client opened against a volume
 * that later disappeared can come back permanently broken even after the
 * drive is reconnected — Prisma/SQLite doesn't self-heal a connection whose
 * underlying file vanished out from under it, confirmed live: unplugging
 * then replugging a USB drive left every subsequent request against that
 * company failing with the same disconnected-drive error until the whole
 * backend process was restarted. Login is the natural choke point to force
 * a fresh connection — it's the first real DB touch after a company
 * potentially went through a disconnect/reconnect cycle. Internal companies
 * never hit this class of failure (their file never goes anywhere), so this
 * only resets for external ones to keep normal login free of the extra work.
 */
export async function ensureCompanyStorageAvailable(companyId: string): Promise<void> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return;
  const result = await resolveExternalCompanyPath(company);
  if (!result.available) {
    throw new HttpError(404, "This company's data drive is not connected. Plug it in and try again.");
  }
  if (company.storageType === 'external') {
    await resetCompanyClient(companyId);
  }
}
