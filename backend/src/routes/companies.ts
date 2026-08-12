import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db/catalog-client.js';
import { createCompanyDb, companyDbPath } from '../db/company-registry.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { hashPassword } from '../lib/password.js';
import { signAuthToken } from '../lib/jwt.js';
import { requireAuth, requireCompanyDb, requireRole } from '../lib/auth-middleware.js';
import { HttpError } from '../lib/http-error.js';
import { findDriveByVolumeId } from '../lib/drives.js';
import { externalDbDir, externalDbPath, resolveExternalCompanyPath } from '../lib/company-storage.js';
import { abbreviateToCode } from '../lib/code-gen.js';

// Backs Setup Wizard + company switcher (docs/SCOPE.md #1, #2). Round 4: each
// company is a row here (the catalog database) PLUS its own separate SQLite
// database file for everything else (User, Party, Item, Invoice, ...) — see
// db/company-registry.ts and docs/plan Round 4 design decision #3.

export const companiesRouter = Router();

// Round 9 — free space is a sanity check, not real capacity planning; a
// template DB is under 1MB, but leaving no headroom for actual usage growth
// on a near-full drive is a bad first impression, so refuse below this floor.
const MIN_FREE_BYTES_FOR_NEW_COMPANY = 100 * 1024 * 1024;

const createCompanySchema = z.object({
  name: z.string().min(1),
  gstin: z.string().length(15).optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  verticalProfileKey: z.string().default('cloth'),
  invoicePrefix: z.string().default('INV'),
  // A brand-new company has zero users, so /users' requireAuth+ADMIN guard has
  // no way to bootstrap the first account — create it here in the same request.
  adminName: z.string().min(1),
  adminUsername: z.string().min(3),
  adminPassword: z.string().min(6),
  // Round 9 — "Where should this company's data live?" (docs/ARCHITECTURE.md
  // "Multi-company storage"). Omitted/undefined volumeId = internal (today's
  // default fixed-path behavior, unchanged). A volumeId targets a drive
  // GET /system/drives just reported — it's re-verified server-side (never
  // trust the client's snapshot of what's plugged in) before provisioning.
  storageVolumeId: z.string().optional(),
});

companiesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const companies = await prisma.company.findMany({ orderBy: { createdAt: 'asc' } });

    // Round 9 — an externally-stored company (pendrive/external drive) only
    // shows up here if its drive is currently plugged in, per the user's own
    // spec: "if this pendrive is not present then it will not show xyz2
    // company to select". Internal companies resolve instantly (no I/O) —
    // see resolveExternalCompanyPath's early return — so this stays cheap
    // for the common case. This also refreshes company-registry.ts's
    // resolved-path cache for any external company that IS present, so a
    // subsequent login against it uses the right (possibly new) drive letter.
    const availability = await Promise.all(companies.map((c) => resolveExternalCompanyPath(c)));
    // resolvedDbPath (Round 9) — internal use, consumed by electron/main.ts's
    // backup scheduler (which can't itself run drivelist/PowerShell volume
    // resolution — that logic is intentionally backend-only, see
    // backend/src/lib/drives.ts). companyDbPath() reads the in-memory cache
    // resolveExternalCompanyPath() just populated above, so this is always
    // the CURRENT path, not a stale stored one.
    const available = companies
      .filter((_, i) => availability[i].available)
      .map((c) => ({ ...c, resolvedDbPath: companyDbPath(c.id) }));

    res.json({ companies: available });
  })
);

companiesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createCompanySchema.parse(req.body);

    const profile = await prisma.verticalProfile.findUnique({ where: { key: input.verticalProfileKey } });
    const passwordHash = await hashPassword(input.adminPassword);

    // Round 9 — re-verify the chosen drive server-side; never trust the
    // client's stale snapshot of what's plugged in (it could have been
    // unplugged between the picker loading and this submit).
    const targetDrive = input.storageVolumeId ? await findDriveByVolumeId(input.storageVolumeId) : null;
    if (input.storageVolumeId && !targetDrive) {
      throw new HttpError(400, 'The selected drive is no longer connected. Reconnect it and try again.');
    }
    if (targetDrive && (targetDrive.freeBytes ?? 0) < MIN_FREE_BYTES_FOR_NEW_COMPANY) {
      throw new HttpError(400, 'The selected drive does not have enough free space for a new company.');
    }

    // Company (catalog DB) and its admin User (a brand-new, separate company
    // DB file) can't share one atomic transaction — they're physically
    // different SQLite files. Company creation is a rare, human-driven
    // action, not a hot path, so this two-step best-effort sequence is an
    // accepted tradeoff (same one every multi-database system makes).
    let company = await prisma.company.create({
      data: {
        name: input.name,
        gstin: input.gstin,
        address: input.address,
        phone: input.phone,
        email: input.email,
        invoicePrefix: input.invoicePrefix,
        verticalProfileId: profile?.id,
        ...(targetDrive
          ? {
              storageType: 'external',
              dbDir: externalDbDir('PENDING'), // placeholder, corrected below once company.id exists
              volumeId: targetDrive.volumeId,
              volumeLabel: targetDrive.label,
              volumeMountHint: targetDrive.mountpoint,
            }
          : {}),
      },
    });

    // dbDir is keyed by the company's own id, which only exists after
    // create() above — patch it in now rather than a two-step create+update
    // race for every company (internal companies never touch this branch).
    let explicitDbPath: string | undefined;
    if (targetDrive) {
      const dbDir = externalDbDir(company.id);
      company = await prisma.company.update({ where: { id: company.id }, data: { dbDir } });
      explicitDbPath = externalDbPath(targetDrive.mountpoint, dbDir, company.id);
    }

    const companyDb = createCompanyDb(company.id, explicitDbPath);
    const user = await companyDb.user.create({
      data: {
        companyId: company.id,
        name: input.adminName,
        username: input.adminUsername,
        passwordHash,
        role: 'ADMIN',
      },
    });

    // Round 7 — a brand-new shop shouldn't land on an empty Label Designer;
    // seed one sensible default (a compact 63x11mm tag: SKU, barcode, MRP —
    // sized off the customer-supplied small-tag samples this round).
    await companyDb.labelTemplate.create({
      data: {
        companyId: company.id,
        name: 'Professional MRP Label',
        isDefault: true,
        widthMm: 50,
        heightMm: 75,
        elements: JSON.stringify([
          // Round 14 fix — this used to say type: 'field', which was never a
          // real ElementType (labelPrint.ts's union is 'text'/'barcode'/
          // 'qrcode'/'line'/'rectangle'). Every brand-new shop's very first,
          // auto-provisioned template had two silently-blank elements as a
          // result — they matched no branch in the canvas renderer or the
          // sidebar's editor-panel type check, so they never showed preview
          // text and couldn't be edited at all.
          { id: 'brand', type: 'text', sourceKey: 'item.brand', xMm: 3, yMm: 2, widthMm: 44, heightMm: 9, fontSize: 14, bold: true, align: 'center' },
          { id: 'line-top', type: 'line', xMm: 3, yMm: 13, widthMm: 44, heightMm: 0.35 },
          { id: 'category-label', type: 'text', content: 'Category:', xMm: 3, yMm: 16, widthMm: 17, heightMm: 5, fontSize: 8, bold: true },
          { id: 'category-value', type: 'text', sourceKey: 'item.category', xMm: 20, yMm: 16, widthMm: 27, heightMm: 5, fontSize: 8, align: 'right' },
          { id: 'type-label', type: 'text', content: 'Type:', xMm: 3, yMm: 21, widthMm: 17, heightMm: 5, fontSize: 8, bold: true },
          { id: 'type-value', type: 'text', sourceKey: 'item.itemType', xMm: 20, yMm: 21, widthMm: 27, heightMm: 5, fontSize: 8, align: 'right' },
          { id: 'size-label', type: 'text', content: 'Size:', xMm: 3, yMm: 26, widthMm: 17, heightMm: 5, fontSize: 8, bold: true },
          { id: 'size-value', type: 'text', sourceKey: 'item.size', xMm: 20, yMm: 26, widthMm: 27, heightMm: 5, fontSize: 10, align: 'right' },
          { id: 'color-label', type: 'text', content: 'Color:', xMm: 3, yMm: 31, widthMm: 17, heightMm: 5, fontSize: 8, bold: true },
          { id: 'color-value', type: 'text', sourceKey: 'item.color', xMm: 20, yMm: 31, widthMm: 27, heightMm: 5, fontSize: 8, align: 'right' },
          { id: 'line-mid', type: 'line', xMm: 3, yMm: 38, widthMm: 44, heightMm: 0.25 },
          { id: 'mrp', type: 'text', sourceKey: 'item.mrp', xMm: 3, yMm: 41, widthMm: 44, heightMm: 9, fontSize: 14, bold: true, align: 'center', showLabel: true, displayLabel: 'MRP' },
          { id: 'tax-note', type: 'text', content: '(Incl. of all taxes)', xMm: 3, yMm: 51, widthMm: 44, heightMm: 4, fontSize: 6, align: 'center' },
          { id: 'barcode', type: 'barcode', sourceKey: 'item.sku', barcodeType: 'code128', xMm: 3, yMm: 58, widthMm: 44, heightMm: 14 },
        ]),
        printConfig: JSON.stringify({ darkness: 8, gapMm: 2, xOffsetMm: 0, yOffsetMm: 0, dpi: 203 }),
      },
    });

    await recordMutation(companyDb, {
      userId: user.id,
      entity: 'Company',
      entityId: company.id,
      action: 'CREATE',
      newValue: company,
      tableName: 'company',
      syncAction: 'CREATE',
      payload: company,
    });

    const token = await signAuthToken({
      sub: user.id,
      companyId: company.id,
      role: 'ADMIN',
      fullName: user.name,
    });

    res.status(201).json({
      company,
      token,
      user: { id: user.id, name: user.name, username: user.username, role: user.role },
    });
  })
);

// Settings page (pre-delivery fixes #2.1) — company details GET/PATCH.
// requireAuth applied per-route (not router-wide) since POST/GET '/' above
// must stay public for onboarding/login; requireAuth's own middleware also
// double-checks req.params.companyId === req.user.companyId when present.
companiesRouter.get(
  '/:companyId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const company = await prisma.company.findUnique({ where: { id: req.params.companyId } });
    if (!company) throw new HttpError(404, 'Company not found');
    // Round 11 — lets Settings prefill the Shop Code field via placeholder
    // (rather than a saved value) before the shop ever sets one; the SKU
    // generation endpoint (items.ts's /next-sku) computes this same fallback
    // independently so a generated SKU is consistent with what Settings shows.
    res.json({ company, suggestedShopCode: abbreviateToCode(company.name) });
  })
);

const updateCompanySchema = z.object({
  name: z.string().min(1).optional(),
  gstin: z.string().length(15).optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  alternatePhone: z.string().optional(),
  email: z.string().email().optional(),
  website: z.string().optional(),
  facebookUrl: z.string().optional(),
  instagramUrl: z.string().optional(),
  whatsappNumber: z.string().optional(),
  invoicePrefix: z.string().optional(),
  shopCode: z.string().optional(),
});

companiesRouter.patch(
  '/:companyId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const companyDb = requireCompanyDb(req);
    const input = updateCompanySchema.parse(req.body);
    const existing = await prisma.company.findUniqueOrThrow({ where: { id: req.params.companyId } });
    const updated = await prisma.company.update({ where: { id: req.params.companyId }, data: input });

    await recordMutation(companyDb, {
      userId: req.user?.id,
      entity: 'Company',
      entityId: updated.id,
      action: 'UPDATE',
      oldValue: existing,
      newValue: updated,
      tableName: 'company',
      syncAction: 'UPDATE',
      payload: updated,
    });

    res.json({ company: updated });
  })
);

async function companyTrialDataSummary(companyDb: ReturnType<typeof requireCompanyDb>, companyId: string) {
  const [
    invoices,
    postedInvoices,
    payments,
    purchases,
    creditNotes,
    debitNotes,
    stockMovements,
    itemsWithStock,
    partyBalances,
    lastInvoice,
  ] = await Promise.all([
    companyDb.invoice.count({ where: { companyId } }),
    companyDb.invoice.count({ where: { companyId, status: { in: ['POSTED', 'CANCELLED'] } } }),
    companyDb.payment.count({ where: { companyId } }),
    companyDb.purchase.count({ where: { companyId } }),
    companyDb.creditNote.count({ where: { companyId } }),
    companyDb.debitNote.count({ where: { companyId } }),
    companyDb.stockMovement.count({ where: { item: { companyId } } }),
    companyDb.item.count({ where: { companyId, stockQty: { not: 0 } } }),
    companyDb.party.count({ where: { companyId, balance: { not: 0 } } }),
    companyDb.invoice.findFirst({
      where: { companyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, number: true, status: true, total: true, createdAt: true },
    }),
  ]);

  return {
    invoices,
    postedInvoices,
    payments,
    purchases,
    creditNotes,
    debitNotes,
    stockMovements,
    itemsWithStock,
    partyBalances,
    lastInvoice,
  };
}

companiesRouter.get(
  '/:companyId/trial-data-summary',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const companyDb = requireCompanyDb(req);
    res.json({ summary: await companyTrialDataSummary(companyDb, req.params.companyId) });
  })
);

const clearTrialDataSchema = z.object({
  confirmation: z.string(),
});

companiesRouter.post(
  '/:companyId/clear-trial-data',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const companyDb = requireCompanyDb(req);
    const input = clearTrialDataSchema.parse(req.body);
    if (input.confirmation !== 'CLEAR TRIAL DATA') {
      throw new HttpError(400, 'Type CLEAR TRIAL DATA to confirm.');
    }

    const before = await companyTrialDataSummary(companyDb, req.params.companyId);
    await companyDb.$transaction(async (tx) => {
      await tx.payment.deleteMany({ where: { companyId: req.params.companyId } });
      await tx.ledgerEntry.deleteMany({ where: { party: { companyId: req.params.companyId } } });
      await tx.stockMovement.deleteMany({ where: { item: { companyId: req.params.companyId } } });

      await tx.debitNoteItem.deleteMany({ where: { debitNote: { companyId: req.params.companyId } } });
      await tx.debitNote.deleteMany({ where: { companyId: req.params.companyId } });
      await tx.creditNoteItem.deleteMany({ where: { creditNote: { companyId: req.params.companyId } } });
      await tx.creditNote.deleteMany({ where: { companyId: req.params.companyId } });

      await tx.purchaseItem.deleteMany({ where: { purchase: { companyId: req.params.companyId } } });
      await tx.purchase.deleteMany({ where: { companyId: req.params.companyId } });
      await tx.invoiceItem.deleteMany({ where: { invoice: { companyId: req.params.companyId } } });
      await tx.invoice.deleteMany({ where: { companyId: req.params.companyId } });

      await tx.item.updateMany({ where: { companyId: req.params.companyId }, data: { stockQty: 0 } });
      await tx.party.updateMany({ where: { companyId: req.params.companyId }, data: { balance: 0 } });
      await tx.auditLog.deleteMany({});
      await tx.syncQueue.deleteMany({});
    });

    res.json({ before, summary: await companyTrialDataSummary(companyDb, req.params.companyId) });
  })
);

// TODO (Day 1, Setup Wizard): logo upload, FY, plus a /:id/activate route
// the frontend calls when switching companies.

// Round 22 — top-bar Quick Notepad: a free-text scratchpad, stored the same
// way receipt settings/payment modes/label settings already are (a JSON blob
// under a Setting key), not a new table.
const QUICK_NOTEPAD_KEY = 'quick-notepad';
const quickNotepadSchema = z.object({ text: z.string().default('') });

companiesRouter.get(
  '/:companyId/quick-notepad',
  requireAuth,
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const setting = await prisma.setting.findUnique({
      where: { companyId_key: { companyId: req.params.companyId, key: QUICK_NOTEPAD_KEY } },
    });
    res.json({ notepad: setting ? quickNotepadSchema.parse(JSON.parse(setting.value)) : quickNotepadSchema.parse({}) });
  })
);

companiesRouter.put(
  '/:companyId/quick-notepad',
  requireAuth,
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = quickNotepadSchema.parse(req.body);
    const setting = await prisma.setting.upsert({
      where: { companyId_key: { companyId: req.params.companyId, key: QUICK_NOTEPAD_KEY } },
      create: { companyId: req.params.companyId, key: QUICK_NOTEPAD_KEY, value: JSON.stringify(input) },
      update: { value: JSON.stringify(input) },
    });
    res.json({ notepad: JSON.parse(setting.value) });
  })
);
