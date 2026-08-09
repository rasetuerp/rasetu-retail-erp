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

const COMPANY_CLIENT_IDLE_MS = 20 * 60 * 1000;
const COMPANY_CLIENT_SWEEP_MS = 5 * 60 * 1000;

type RegistryEntry = {
  client: CompanyPrismaClient;
  lastUsedAt: number;
  ready: Promise<void>;
};

const registry = new Map<string, RegistryEntry>();

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

export function markKnownExternalCompany(companyId: string): void {
  knownExternalCompanyIds.add(companyId);
}

export function isKnownExternalCompany(companyId: string): boolean {
  return knownExternalCompanyIds.has(companyId);
}

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
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.client;
  }

  const client = new CompanyPrismaClient({
    datasources: { db: { url: `file:${companyDbPath(companyId)}` } },
  });
  registry.set(companyId, { client, lastUsedAt: Date.now(), ready: configureCompanyClient(client) });
  return client;
}

async function configureCompanyClient(client: CompanyPrismaClient): Promise<void> {
  await client.$executeRawUnsafe('PRAGMA busy_timeout = 10000');
  await client.$executeRawUnsafe('PRAGMA journal_mode = WAL');
  await client.$executeRawUnsafe('PRAGMA synchronous = NORMAL');
  await client.$executeRawUnsafe('PRAGMA foreign_keys = ON');
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

export async function getReadyCompanyClient(companyId: string): Promise<CompanyPrismaClient> {
  const client = getCompanyClient(companyId);
  const entry = registry.get(companyId);
  if (entry) {
    try {
      await entry.ready;
    } catch (err) {
      registry.delete(companyId);
      await entry.client.$disconnect().catch(() => undefined);
      throw err;
    }
  }
  return client;
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
  const entries = [...registry.values()];
  registry.clear();
  await Promise.all(entries.map((entry) => entry.client.$disconnect()));
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
    registry.delete(companyId);
    await existing.client.$disconnect();
  }
}

export function startCompanyClientIdleSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [companyId, entry] of registry) {
      if (now - entry.lastUsedAt < COMPANY_CLIENT_IDLE_MS) continue;
      registry.delete(companyId);
      entry.client.$disconnect().catch((err: unknown) => {
        console.error(`[db] failed to disconnect idle company client ${companyId}:`, err);
      });
    }
  }, COMPANY_CLIENT_SWEEP_MS);
}
