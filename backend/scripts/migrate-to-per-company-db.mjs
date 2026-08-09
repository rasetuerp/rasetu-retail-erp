// Round 4 — one-time migration: splits the old single shared SQLite database
// into the new architecture (one catalog DB + one file per company). Run
// once, from backend/: `node scripts/migrate-to-per-company-db.mjs`
//
// This is a dev-machine, one-off operation (no real customers yet) — not a
// general upgrade path. See docs/plan Round 4 design decision #3.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

const { PrismaClient: OldPrismaClient } = await import('@prisma/client');
const { PrismaClient: CatalogPrismaClient } = await import('../src/generated/catalog-client/index.js');
const { PrismaClient: CompanyPrismaClient } = await import('../src/generated/company-client/index.js');

const oldDbPath = path.join(backendRoot, 'prisma', 'rasetu-local.db');
const catalogDbPath = path.join(backendRoot, 'prisma', 'catalog', 'catalog.db');
const templateDbPath = path.join(backendRoot, 'prisma', 'company', 'template.db');
const companiesDir = path.resolve(backendRoot, 'prisma', 'companies');

if (!fs.existsSync(oldDbPath)) {
  console.log('No old shared DB found — nothing to migrate.');
  process.exit(0);
}

const oldPrisma = new OldPrismaClient({ datasources: { db: { url: `file:${oldDbPath}` } } });
const catalogPrisma = new CatalogPrismaClient({ datasources: { db: { url: `file:${catalogDbPath}` } } });

// Only models that actually carry a companyId column in the OLD shared
// schema. StockMovement/InvoiceItem/PurchaseItem/LedgerEntry are copied
// separately below, via their parent row (Item/Invoice/Purchase/Party).
// AuditLog/SyncQueue were never companyId-tagged in the old shared table —
// their history can't be cleanly attributed per company, so it's not
// migrated (acceptable: dev/test data only, no real customers yet; new
// entries accumulate correctly per-company from here on).
const COMPANY_MODELS_IN_ORDER = ['user', 'party', 'item', 'invoice', 'payment', 'purchase', 'creditNote', 'setting'];

async function main() {
  const companies = await oldPrisma.company.findMany();
  console.log(`Found ${companies.length} companies to migrate.`);

  fs.mkdirSync(companiesDir, { recursive: true });

  for (const company of companies) {
    console.log(`\n--- ${company.name} (${company.id}) ---`);

    await catalogPrisma.company.upsert({
      where: { id: company.id },
      update: {},
      create: {
        id: company.id,
        name: company.name,
        gstin: company.gstin,
        address: company.address,
        phone: company.phone,
        email: company.email,
        logoPath: company.logoPath,
        fyStartMonth: company.fyStartMonth,
        invoicePrefix: company.invoicePrefix,
        verticalProfileId: null, // no VerticalProfile rows exist in the old DB
        createdAt: company.createdAt,
        updatedAt: company.updatedAt,
      },
    });
    console.log('  catalog row: ok');

    const dbPath = path.join(companiesDir, `${company.id}.db`);
    if (!fs.existsSync(dbPath)) {
      fs.copyFileSync(templateDbPath, dbPath);
    }
    const companyPrisma = new CompanyPrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

    for (const model of COMPANY_MODELS_IN_ORDER) {
      const rows = await oldPrisma[model].findMany({ where: { companyId: company.id } });
      let copied = 0;
      for (const row of rows) {
        await companyPrisma[model].upsert({ where: { id: row.id }, update: {}, create: row });
        copied += 1;
      }
      if (copied > 0) console.log(`  ${model}: ${copied}`);
    }

    // StockMovement/InvoiceItem/PurchaseItem/LedgerEntry aren't directly
    // companyId-tagged — reachable only via their parent (Item/Invoice/
    // Purchase/Party). Copy them via the parent rows already copied above.
    const items = await companyPrisma.item.findMany({ select: { id: true } });
    for (const { id: itemId } of items) {
      const movements = await oldPrisma.stockMovement.findMany({ where: { itemId } });
      for (const row of movements) {
        await companyPrisma.stockMovement.upsert({ where: { id: row.id }, update: {}, create: row });
      }
      const invoiceItems = await oldPrisma.invoiceItem.findMany({ where: { itemId } });
      for (const row of invoiceItems) {
        await companyPrisma.invoiceItem.upsert({ where: { id: row.id }, update: {}, create: row });
      }
      const purchaseItems = await oldPrisma.purchaseItem.findMany({ where: { itemId } });
      for (const row of purchaseItems) {
        await companyPrisma.purchaseItem.upsert({ where: { id: row.id }, update: {}, create: row });
      }
    }
    const parties = await companyPrisma.party.findMany({ select: { id: true } });
    for (const { id: partyId } of parties) {
      const ledgerEntries = await oldPrisma.ledgerEntry.findMany({ where: { partyId } });
      for (const row of ledgerEntries) {
        await companyPrisma.ledgerEntry.upsert({ where: { id: row.id }, update: {}, create: row });
      }
    }

    const finalCounts = {
      users: await companyPrisma.user.count(),
      parties: await companyPrisma.party.count(),
      items: await companyPrisma.item.count(),
      invoices: await companyPrisma.invoice.count(),
      stockMovements: await companyPrisma.stockMovement.count(),
    };
    console.log('  final counts:', finalCounts);

    await companyPrisma.$disconnect();
  }

  await oldPrisma.$disconnect();
  await catalogPrisma.$disconnect();

  const bakPath = `${oldDbPath}.bak`;
  fs.renameSync(oldDbPath, bakPath);
  console.log(`\nOld shared DB moved to ${bakPath}. Migration complete.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
