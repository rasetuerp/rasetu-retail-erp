import fs from 'node:fs';
import path from 'node:path';

import { PrismaClient as CompanyPrismaClient } from '../generated/company-client/index.js';
import { HttpError } from '../lib/http-error.js';
import { BACKEND_ROOT } from '../lib/backend-root.js';

// Round 4 — one physical SQLite file per company (docs/plan Round 4 design
// decision #3). `RASETU_DATA_DIR` is set by Electron's main process
// (app.getPath('userData')); falls back to a repo-relative dev path when
// unset (npm run dev). The template DB is built once via
// `prisma db push --schema=prisma/company/schema.prisma` — see
// backend/prisma/company/template.db.
const dataDir = process.env.RASETU_DATA_DIR
  ? path.join(process.env.RASETU_DATA_DIR, 'companies')
  : path.resolve(BACKEND_ROOT, 'prisma', 'companies');
const templatePath = path.resolve(BACKEND_ROOT, 'prisma', 'company', 'template.db');

const registry = new Map<string, CompanyPrismaClient>();

// Round 9 — companies with storageType 'external' don't live under `dataDir`
// at a formulaic path; their real location is resolved at runtime against
// whichever drive currently holds their stored volumeId (see
// backend/src/lib/company-storage.ts) and cached here. This keeps
// companyDbPath() synchronous for the common (internal) case — the vast
// majority of callers (openClient, getCompanyClient's fs.existsSync check)
// need a plain string, not a promise — while still supporting drive-letter
// changes for the external case via an explicit resolve-then-cache step the
// caller performs first (company-storage.ts's resolveExternalCompanyPath()).
const externalDbPathCache = new Map<string, string>();

// Round 9 — separate from externalDbPathCache above (which gets CLEARED once
// a drive is found absent, so it can't answer "is this company external" on
// its own). Once a companyId is known to be external, it's external for the
// rest of this process's life — used so getCompanyClient can tell "this
// company was never created" (a real 404) apart from "this company's drive
// just isn't plugged in right now" (a 503, DRIVE_DISCONNECTED) instead of
// both collapsing into the same generic "Company not found". Found live
// during Round 9's hardware test: a second disconnect after a reset lost the
// friendly drive-disconnected messaging entirely without this.
const knownExternalCompanyIds = new Set<string>();

/** Called by company-storage.ts once it has resolved an external company's current absolute path. */
export function setResolvedExternalDbPath(companyId: string, absoluteDbPath: string): void {
  externalDbPathCache.set(companyId, absoluteDbPath);
  knownExternalCompanyIds.add(companyId);
}

export function clearResolvedExternalDbPath(companyId: string): void {
  externalDbPathCache.delete(companyId);
}

export function companyDbPath(companyId: string): string {
  const resolved = externalDbPathCache.get(companyId);
  if (resolved) return resolved;
  return path.join(dataDir, `${companyId}.db`);
}

// Round 7 — backup files live as a sibling of the companies/ dir, one
// subfolder per company, so a backup can never be mistaken for a live DB by
// anything that globs `companies/*.db`.
export function companyBackupDir(companyId: string): string {
  return path.join(path.dirname(dataDir), 'backups', companyId);
}

function openClient(companyId: string): CompanyPrismaClient {
  const existing = registry.get(companyId);
  if (existing) return existing;

  const client = new CompanyPrismaClient({
    datasources: { db: { url: `file:${companyDbPath(companyId)}` } },
  });
  registry.set(companyId, client);
  return client;
}

/** Opens an existing company's database. 404s if that company was never provisioned; 503s (DRIVE_DISCONNECTED) if it's a known-external company whose drive isn't reachable right now. */
export function getCompanyClient(companyId: string): CompanyPrismaClient {
  if (!registry.has(companyId) && !fs.existsSync(companyDbPath(companyId))) {
    if (knownExternalCompanyIds.has(companyId)) {
      throw new HttpError(503, "This company's data drive appears to be disconnected. Reconnect it and try again.", {
        code: 'DRIVE_DISCONNECTED',
      });
    }
    throw new HttpError(404, 'Company not found');
  }
  return openClient(companyId);
}

/**
 * Provisions a brand-new company's database from the template — called once,
 * from POST /companies. `explicitDbPath` (Round 9) lets the caller place an
 * externally-stored company's file under its chosen drive instead of the
 * default internal formula; the resolved path is cached so companyDbPath()
 * returns it for the rest of this process's lifetime.
 */
export function createCompanyDb(companyId: string, explicitDbPath?: string): CompanyPrismaClient {
  if (explicitDbPath) setResolvedExternalDbPath(companyId, explicitDbPath);
  const dbPath = companyDbPath(companyId);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(templatePath, dbPath);
  return openClient(companyId);
}

/** Disconnects every lazily-opened company client — called on fatal shutdown. */
export async function disconnectAllCompanyClients(): Promise<void> {
  await Promise.all([...registry.values()].map((client) => client.$disconnect()));
}

/**
 * Round 7 — restore swaps the underlying .db file out from under a live
 * connection, so the cached client must be dropped entirely (not just
 * disconnected) or the next request could keep talking to Prisma's original
 * file handle instead of the restored one. The next `getCompanyClient` call
 * lazily opens a brand-new connection against whatever file now sits at
 * this path.
 */
export async function resetCompanyClient(companyId: string): Promise<void> {
  const existing = registry.get(companyId);
  if (existing) {
    await existing.$disconnect();
    registry.delete(companyId);
  }
}
