import fs from 'node:fs';
import path from 'node:path';

import { PrismaClient } from '../generated/catalog-client/index.js';
import { BACKEND_ROOT } from '../lib/backend-root.js';

// Round 4 — the catalog database (Company + VerticalProfile only). See
// prisma/catalog/schema.prisma and docs/plan Round 4 design decision #3.
//
// Same reasoning as company-registry.ts's `dataDir`: when RASETU_DATA_DIR is
// set (by Electron's main.ts, to app.getPath('userData')), catalog.db must
// live there rather than at CATALOG_DATABASE_URL's schema-relative default
// (backend/prisma/catalog/catalog.db) — that path sits inside the packaged
// app's install directory, which electron-builder's NSIS installer does not
// preserve across version updates, so every company a customer ever created
// would vanish on update. Falls back to the .env-relative path for local dev
// without Electron.
const seedDbPath = path.resolve(BACKEND_ROOT, 'prisma', 'catalog', 'catalog.db');
const catalogDbPath = process.env.RASETU_DATA_DIR
  ? path.join(process.env.RASETU_DATA_DIR, 'catalog.db')
  : seedDbPath;

// First run under RASETU_DATA_DIR: nothing has been migrated there yet, so
// seed it from the packaged, already-migrated catalog.db (mirrors
// company-registry.ts's template.db copy for a brand-new company). Only the
// first install ever takes this branch — every later launch finds the file
// already sitting under RASETU_DATA_DIR and leaves it alone.
if (catalogDbPath !== seedDbPath && !fs.existsSync(catalogDbPath) && fs.existsSync(seedDbPath)) {
  fs.copyFileSync(seedDbPath, catalogDbPath);
}

declare global {
  var __rasetuCatalogPrisma__: PrismaClient | undefined;
}

export const prisma =
  global.__rasetuCatalogPrisma__ ??
  new PrismaClient({
    log: ['warn', 'error'],
    datasources: { db: { url: `file:${catalogDbPath}` } },
  });

if (process.env.NODE_ENV !== 'production') {
  global.__rasetuCatalogPrisma__ = prisma;
}
