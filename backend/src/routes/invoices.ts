import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb, requireRole } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { HttpError } from '../lib/http-error.js';
import { applyStockMovement } from './stock.js';
import { computeInvoiceTotals, gstinStateCode, type CalcLineInput } from '../lib/gst-calc.js';
import { prisma as catalogPrisma } from '../db/catalog-client.js';
import type { PrismaClient as CompanyPrismaClient } from '../generated/company-client/index.js';

// GST Billing — SCOPE.md #5, the heart of the sprint (Days 5-6, docs/SPRINT_PLAN.md
// Steps 6-8). Draft/hold/post/cancel + FY-scoped numbering + stock integration,
// with the real calc engine (lib/gst-calc.ts): inclusive/exclusive, cloth
// MRP-slab auto-rate, CGST/SGST vs IGST by state, discount/round-off/reverse
// adjustment. Do not add fields here without checking docs/SCHEMA.md first
// (schema is frozen — RULES.md #10).

export const invoicesRouter = Router({ mergeParams: true });

const invoiceItemSchema = z
  .object({
    itemId: z.string(),
    qty: z.number().positive(),
    rate: z.number(),
    gstInclusive: z.boolean().default(true),
    discountPct: z.number().default(0),
    // Round 5 — ADMIN/SUPER_ADMIN-only safety valve; re-checked against the
    // requester's actual role server-side in runCalc, never trusted as-is.
    gstRateOverride: z.number().min(0).max(28).optional(),
    gstOverrideReason: z.string().min(1).optional(),
  })
  .refine((v) => (v.gstRateOverride === undefined) === (v.gstOverrideReason === undefined), {
    message: 'gstOverrideReason is required when gstRateOverride is set',
  });

const invoiceBodySchema = z.object({
  partyId: z.string().optional(),
  // Draft and Held were near-duplicate "not final yet" states — collapsed
  // into just Held per the user's call. DRAFT stays a valid InvoiceStatus
  // enum value (for any pre-existing rows) but is no longer creatable.
  status: z.enum(['HELD', 'ESTIMATE']).default('HELD'),
  items: z.array(invoiceItemSchema).min(1),
  discountPct: z.number().default(0),
  discountAmt: z.number().default(0),
  reverseAdjustTotal: z.number().optional(),
  // Round 5 — cashier-editable at billing time; falls back to the +15-day
  // default only when the client doesn't supply one.
  dueDate: z.coerce.date().optional(),
});

const DEFAULT_DUE_DAYS = 15; // single constant, easy to change later (PRD 2.4)
function defaultDueDate(from: Date) {
  const d = new Date(from);
  d.setDate(d.getDate() + DEFAULT_DUE_DAYS);
  return d;
}

function currentFyLabel(fyStartMonth: number, date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const fyStartYear = month >= fyStartMonth ? year : year - 1;
  return `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Draft/Held bills are internal work-in-progress, not "documents issued" —
 * they get a temporary, never-colliding placeholder and only receive a real
 * sequential number when POSTED (docs/GST-SPEC.md Documents Issued sheet
 * only cares about posted/cancelled invoices).
 */
function tempInvoiceNumber(status: 'DRAFT' | 'HELD') {
  return `${status}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Estimates are handed to the customer as a real, identifiable document (not
 * a "come back later" placeholder like Draft/Held), so they get a real
 * sequential number up front — just under an EST/ prefix, never the
 * company's invoicePrefix, and never counted in GST filing (GST-SPEC.md's
 * Documents Issued sheet only looks at POSTED/CANCELLED). Mirrors the
 * max-based (not count-based) sequencing in POST /:id/post for the same
 * reason: self-correcting regardless of gaps or out-of-order creation.
 */
async function nextEstimateNumber(prisma: CompanyPrismaClient, companyId: string, fyLabel: string) {
  const existing = await prisma.invoice.findMany({
    where: { companyId, fyLabel, status: 'ESTIMATE' },
    select: { number: true },
  });
  const maxSeq = existing.reduce((max, row) => {
    const seq = parseInt(row.number.split('/').pop() ?? '', 10);
    return Number.isFinite(seq) && seq > max ? seq : max;
  }, 0);
  return `EST/${fyLabel}/${String(maxSeq + 1).padStart(4, '0')}`;
}

type InvoiceBody = z.infer<typeof invoiceBodySchema>;

/**
 * Loads item MRPs and company/party GSTIN state, then runs the pure calc
 * engine (lib/gst-calc.ts). itemId → mrp is always read fresh from the DB —
 * the client only supplies qty/rate/gstInclusive, never the tax rate itself.
 *
 * Round 4: Company lives in the catalog database (not this company's own
 * database), so its GSTIN is passed in by the caller — who already has it
 * from a catalog lookup — rather than re-fetched here.
 */
async function runCalc(
  prisma: CompanyPrismaClient,
  companyGstin: string | null | undefined,
  companyId: string,
  input: InvoiceBody,
  requesterRole: string
) {
  const items = await prisma.item.findMany({
    where: { id: { in: input.items.map((i) => i.itemId) }, companyId },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));

  // Only ADMIN/SUPER_ADMIN may exercise the GST% override — re-checked here
  // against the JWT-verified role, never the client's say-so.
  const canOverrideGst = requesterRole === 'ADMIN' || requesterRole === 'SUPER_ADMIN';

  const lines: CalcLineInput[] = input.items.map((line) => {
    const item = itemById.get(line.itemId);
    if (!item) throw new HttpError(400, `Item ${line.itemId} not found in this company`);
    return {
      itemId: line.itemId,
      qty: line.qty,
      rate: line.rate,
      mrp: Number(item.mrp),
      gstInclusive: line.gstInclusive,
      discountPct: line.discountPct,
      gstRateOverride: canOverrideGst ? line.gstRateOverride : undefined,
      gstOverrideReason: canOverrideGst ? line.gstOverrideReason : undefined,
    };
  });

  let sameState = true;
  if (input.partyId) {
    const party = await prisma.party.findUnique({ where: { id: input.partyId } });
    const companyState = gstinStateCode(companyGstin);
    const partyState = gstinStateCode(party?.gstin);
    // Missing GSTIN on either side → treat as intra-state B2C, the common
    // case for a cloth shop counter sale (docs/GST-SPEC.md: ~95% of sales).
    sameState = !companyState || !partyState || companyState === partyState;
  }

  return computeInvoiceTotals({
    lines,
    discountPct: input.discountPct,
    discountAmt: input.discountAmt,
    sameState,
    reverseAdjustTotal: input.reverseAdjustTotal,
  });
}

invoicesRouter.use(requireAuth);

invoicesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { status, partyId } = req.query as { status?: string; partyId?: string };
    const invoices = await prisma.invoice.findMany({
      where: {
        companyId: req.params.companyId,
        ...(status ? { status: status as never } : {}),
        ...(partyId ? { partyId } : {}),
      },
      orderBy: { date: 'desc' },
      include: { items: true, payments: true, party: true },
    });
    res.json({ invoices });
  })
);

// Round 6 — shop-configurable text shown on the printed thermal receipt
// (exchange policy, footer), stored the same way payment modes and label
// settings already are: a JSON blob under a Setting key, not a new column.
// Registered ahead of GET/PUT '/:id' below — Express would otherwise treat
// the literal path segment "receipt-settings" as an :id value and this
// handler would never be reached.
const RECEIPT_SETTINGS_KEY = 'receipt-settings';

// Round 7 — text-only analog of a toggleable/reorderable section catalog
// (src/lib/invoicePrint.ts's SECTION_BUILDERS owns the actual per-section
// text; this schema only stores which sections are on and in what order).
// 'items'/'totals' are locked (always on) at the render layer, not here —
// keep them in the schema so a client round-trips the same shape either way.
const RECEIPT_SECTION_KEYS = [
  'header',
  'cashierCustomer',
  'items',
  'totals',
  'paidLine',
  'amountInWords',
  'gstBreakup',
  'savingsLine',
  'exchangePolicy',
  'customMessage',
  'paymentInfo',
  'qrPlaceholder',
  'cashier',
  'footer',
] as const;
const DEFAULT_RECEIPT_SECTIONS = RECEIPT_SECTION_KEYS.map((key, order) => ({ key, enabled: true, order }));
const RECEIPT_HEADER_KEYS = ['logo', 'shopName', 'localShopName', 'headerLine1', 'headerLine2', 'headerLine3'] as const;
const DEFAULT_RECEIPT_HEADER_ORDER = [...RECEIPT_HEADER_KEYS];

const receiptSettingsSchema = z.object({
  receiptLogoImage: z.string().max(900000).default(''),
  receiptLogoWidthMm: z.number().min(8).max(72).default(18),
  shopNameText: z.string().default(''),
  shopNameFontSize: z.number().min(8).max(32).default(16),
  localShopNameText: z.string().default(''),
  localShopNameFontSize: z.number().min(8).max(32).default(16),
  headerLine1Text: z.string().default(''),
  headerLine1FontSize: z.number().min(8).max(24).default(12),
  headerLine2Text: z.string().default(''),
  headerLine2FontSize: z.number().min(8).max(24).default(10),
  headerLine3Text: z.string().default(''),
  headerLine3FontSize: z.number().min(8).max(24).default(10),
  headerOrder: z.array(z.enum(RECEIPT_HEADER_KEYS)).default(DEFAULT_RECEIPT_HEADER_ORDER),
  exchangePolicyText: z.string().default('Exchange within 7 days with bill. No exchange on sale items and altered garments.'),
  footerText: z.string().default('Thank you! Visit again'),
  // Round 10 — free-form multi-line custom message / terms & conditions /
  // promotional offer, separate from the single-line exchangePolicy/footer.
  customMessageText: z.string().default(''),
  // Round 12 — a real printed payment line (e.g. UPI ID), distinct from the
  // qrPlaceholder section which is deliberately text-only (no image support
  // in the ESC/POS pipeline).
  paymentInfoText: z.string().default(''),
  showSavingsLine: z.boolean().default(true),
  sections: z
    .array(z.object({ key: z.enum(RECEIPT_SECTION_KEYS), enabled: z.boolean(), order: z.number() }))
    .default(DEFAULT_RECEIPT_SECTIONS),
  // Round 17 — physical roll width in characters (58mm ≈ 32 cols, 80mm ≈ 48
  // cols at standard thermal font). Drives every thermal layout's formatting.
  columns: z.number().int().min(20).max(64).default(32),
  marginLeftChars: z.number().int().min(0).max(12).default(0),
  marginRightChars: z.number().int().min(0).max(12).default(0),
  endFeedLines: z.number().int().min(0).max(5).default(0),
  receiptPrintableWidthMm: z.number().min(0).max(90).default(0),
  receiptLeftMarginMm: z.number().min(0).max(12).default(0),
  receiptBodyFontPx: z.number().min(0).max(12).default(0),
});
const DEFAULT_RECEIPT_SETTINGS = receiptSettingsSchema.parse({});

invoicesRouter.get(
  '/receipt-settings',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const setting = await prisma.setting.findUnique({
      where: { companyId_key: { companyId: req.params.companyId, key: RECEIPT_SETTINGS_KEY } },
    });
    // Re-validated through the schema (not a raw JSON.parse) so a blob saved
    // before Round 7's `sections` field existed still comes back complete —
    // zod's .default(...) backfills whatever an older stored value is
    // missing, instead of every reader having to defend against partial data.
    res.json({ settings: setting ? receiptSettingsSchema.parse(JSON.parse(setting.value)) : DEFAULT_RECEIPT_SETTINGS });
  })
);

invoicesRouter.put(
  '/receipt-settings',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = receiptSettingsSchema.parse(req.body);
    const setting = await prisma.setting.upsert({
      where: { companyId_key: { companyId: req.params.companyId, key: RECEIPT_SETTINGS_KEY } },
      create: { companyId: req.params.companyId, key: RECEIPT_SETTINGS_KEY, value: JSON.stringify(input) },
      update: { value: JSON.stringify(input) },
    });
    res.json({ settings: JSON.parse(setting.value) });
  })
);

invoicesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { item: true } }, payments: true, party: true },
    });
    if (!invoice) throw new HttpError(404, 'Invoice not found');

    // Receipt-header fields (shop name/address/phone/GSTIN) live in the
    // separate catalog database, never automatically joined into a
    // company-scoped query — fetched here purely for print/display.
    const company = await catalogPrisma.company.findUnique({ where: { id: invoice.companyId } });

    // "Who rang this up" isn't a stored column on Invoice — reused from the
    // CREATE audit trail every invoice already gets (mutation-log.ts),
    // avoiding a schema change just to label a receipt.
    const createdLog = await prisma.auditLog.findFirst({
      where: { entity: 'Invoice', entityId: invoice.id, action: 'CREATE' },
      orderBy: { createdAt: 'asc' },
    });
    const cashier = createdLog?.userId ? await prisma.user.findUnique({ where: { id: createdLog.userId } }) : null;

    res.json({ invoice: { ...invoice, company, cashierName: cashier?.name ?? null } });
  })
);

invoicesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = invoiceBodySchema.parse(req.body);
    const company = await catalogPrisma.company.findUnique({ where: { id: req.params.companyId } });
    if (!company) throw new HttpError(404, 'Company not found');

    const fyLabel = currentFyLabel(company.fyStartMonth);
    const calc = await runCalc(prisma, company.gstin, req.params.companyId, input, req.user!.role);

    const itemsCreate = calc.lines.map((line) => ({
      itemId: line.itemId,
      qty: line.qty,
      rate: line.rate,
      gstRate: line.gstRate,
      gstInclusive: line.gstInclusive,
      discountPct: line.discountPct,
      gstOverrideReason: line.gstOverrideReason ?? null,
      amount: line.taxableValue,
    }));

    const baseData = {
      companyId: req.params.companyId,
      fyLabel,
      partyId: input.partyId,
      status: input.status,
      subtotal: calc.subtotal,
      discountPct: input.discountPct,
      discountAmt: calc.discountAmt,
      cgst: calc.cgst,
      sgst: calc.sgst,
      igst: calc.igst,
      roundOff: calc.roundOff,
      total: calc.total,
      dueDate: input.dueDate ?? defaultDueDate(new Date()),
      items: { create: itemsCreate },
    };

    // Estimates need their number assigned inside a transaction (like /post
    // does for real invoice numbers) so two concurrent estimates can't read
    // the same "next number" — Draft/Held's random placeholder never
    // collides, so they don't need this.
    const invoice =
      input.status === 'ESTIMATE'
        ? await prisma.$transaction(async (tx) => {
            const number = await nextEstimateNumber(tx as CompanyPrismaClient, req.params.companyId, fyLabel);
            return tx.invoice.create({ data: { ...baseData, number }, include: { items: true } });
          })
        : await prisma.invoice.create({ data: { ...baseData, number: tempInvoiceNumber(input.status) }, include: { items: true } });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Invoice',
      entityId: invoice.id,
      action: 'CREATE',
      newValue: invoice,
      tableName: 'invoice',
      syncAction: 'CREATE',
      payload: invoice,
    });

    res.status(201).json({ invoice, calc });
  })
);

invoicesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = invoiceBodySchema.parse(req.body);
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, 'Invoice not found');
    // SCHEMA.md: only Draft/Held bills are freely editable — posted invoices
    // are corrected via Credit Note, cancelled invoices are terminal.
    if (existing.status !== 'DRAFT' && existing.status !== 'HELD') {
      throw new HttpError(400, 'Only draft or held invoices can be edited — use a credit note instead');
    }

    const existingCompany = await catalogPrisma.company.findUnique({ where: { id: existing.companyId } });
    const calc = await runCalc(prisma, existingCompany?.gstin, existing.companyId, input, req.user!.role);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.invoiceItem.deleteMany({ where: { invoiceId: existing.id } });
      return tx.invoice.update({
        where: { id: existing.id },
        data: {
          partyId: input.partyId,
          status: input.status ?? existing.status,
          subtotal: calc.subtotal,
          discountPct: input.discountPct,
          discountAmt: calc.discountAmt,
          cgst: calc.cgst,
          sgst: calc.sgst,
          igst: calc.igst,
          roundOff: calc.roundOff,
          total: calc.total,
          dueDate: input.dueDate ?? existing.dueDate,
          items: {
            create: calc.lines.map((line) => ({
              itemId: line.itemId,
              qty: line.qty,
              rate: line.rate,
              gstRate: line.gstRate,
              gstInclusive: line.gstInclusive,
              discountPct: line.discountPct,
              gstOverrideReason: line.gstOverrideReason ?? null,
              amount: line.taxableValue,
            })),
          },
        },
        include: { items: true },
      });
    });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Invoice',
      entityId: updated.id,
      action: 'UPDATE',
      oldValue: existing,
      newValue: updated,
      tableName: 'invoice',
      syncAction: 'UPDATE',
      payload: updated,
    });

    res.json({ invoice: updated, calc });
  })
);

// A held bill is only ever local scratch work — never posted, never touched
// stock or the party's ledger — so removing one is a real delete, not a
// cancel (matches SCHEMA.md's "Draft bill: Delete yes"; the merged Draft/Held
// concept keeps that same freedom). DRAFT stays allowed here too, purely so
// any pre-existing legacy rows can still be cleaned up.
invoicesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, 'Invoice not found');
    if (existing.status !== 'DRAFT' && existing.status !== 'HELD') {
      throw new HttpError(400, 'Only held bills can be removed — posted invoices must be cancelled instead');
    }

    await prisma.$transaction(async (tx) => {
      await tx.invoiceItem.deleteMany({ where: { invoiceId: existing.id } });
      await tx.invoice.delete({ where: { id: existing.id } });
    });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Invoice',
      entityId: existing.id,
      action: 'DELETE',
      oldValue: existing,
      tableName: 'invoice',
      syncAction: 'DELETE',
      payload: { id: existing.id },
    });

    res.status(204).send();
  })
);

const deleteLastInvoiceSchema = z.object({
  confirmation: z.string(),
});

invoicesRouter.delete(
  '/last/safe',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = deleteLastInvoiceSchema.parse(req.body ?? {});
    if (input.confirmation !== 'DELETE LAST INVOICE') {
      throw new HttpError(400, 'Type DELETE LAST INVOICE to confirm.');
    }

    const invoice = await prisma.invoice.findFirst({
      where: { companyId: req.params.companyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { items: true, payments: true, creditNotes: true },
    });
    if (!invoice) throw new HttpError(404, 'No invoice found to delete.');
    if (invoice.payments.length > 0) throw new HttpError(400, 'Cannot delete the last invoice because payments are linked to it. Cancel/return it instead.');
    if (invoice.creditNotes.length > 0) throw new HttpError(400, 'Cannot delete the last invoice because sales returns/credit notes are linked to it.');

    if (invoice.status === 'POSTED' || invoice.status === 'CANCELLED') {
      const sameFyIssued = await prisma.invoice.findMany({
        where: { companyId: invoice.companyId, fyLabel: invoice.fyLabel, status: { in: ['POSTED', 'CANCELLED'] } },
        select: { id: true, number: true },
      });
      const thisSeq = parseInt(invoice.number.split('/').pop() ?? '', 10);
      const maxSeq = sameFyIssued.reduce((max, row) => {
        const seq = parseInt(row.number.split('/').pop() ?? '', 10);
        return Number.isFinite(seq) && seq > max ? seq : max;
      }, 0);
      if (!Number.isFinite(thisSeq) || thisSeq !== maxSeq) {
        throw new HttpError(400, 'Only the latest issued invoice number can be deleted safely.');
      }
    }

    if (invoice.partyId) {
      const invoiceLedger = await prisma.ledgerEntry.findMany({
        where: { invoiceId: invoice.id },
        orderBy: { createdAt: 'desc' },
      });
      const latestInvoiceLedgerAt = invoiceLedger[0]?.createdAt;
      if (latestInvoiceLedgerAt) {
        const laterLedger = await prisma.ledgerEntry.findFirst({
          where: {
            partyId: invoice.partyId,
            createdAt: { gt: latestInvoiceLedgerAt },
            NOT: { invoiceId: invoice.id },
          },
        });
        if (laterLedger) {
          throw new HttpError(400, 'Cannot delete the last invoice because this party has later ledger activity.');
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      const movements = await tx.stockMovement.findMany({ where: { refType: 'Invoice', refId: invoice.id } });
      const stockByItem = new Map<string, number>();
      for (const movement of movements) {
        stockByItem.set(movement.itemId, (stockByItem.get(movement.itemId) ?? 0) + Number(movement.qty));
      }
      for (const [itemId, qtyEffect] of stockByItem) {
        if (qtyEffect !== 0) await tx.item.update({ where: { id: itemId }, data: { stockQty: { decrement: qtyEffect } } });
      }

      await tx.stockMovement.deleteMany({ where: { refType: 'Invoice', refId: invoice.id } });
      await tx.ledgerEntry.deleteMany({ where: { invoiceId: invoice.id } });
      if (invoice.partyId) {
        const lastEntry = await tx.ledgerEntry.findFirst({ where: { partyId: invoice.partyId }, orderBy: { date: 'desc' } });
        await tx.party.update({ where: { id: invoice.partyId }, data: { balance: lastEntry?.balance ?? 0 } });
      }
      await tx.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } });
      await tx.invoice.delete({ where: { id: invoice.id } });
    });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Invoice',
      entityId: invoice.id,
      action: 'DELETE',
      oldValue: invoice,
      tableName: 'invoice',
      syncAction: 'DELETE',
      payload: { id: invoice.id, number: invoice.number },
    });

    res.json({ deletedInvoice: { id: invoice.id, number: invoice.number, status: invoice.status } });
  })
);

// Due date is meant to keep moving after posting as a credit customer's
// promise-to-pay date shifts — distinct from PUT /:id, which only touches
// DRAFT/HELD invoices (posted ones are correction-via-credit-note territory).
const dueDateSchema = z.object({ dueDate: z.coerce.date().nullable() });

invoicesRouter.patch(
  '/:id/due-date',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = dueDateSchema.parse(req.body);
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, 'Invoice not found');

    const updated = await prisma.invoice.update({ where: { id: existing.id }, data: { dueDate: input.dueDate } });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Invoice',
      entityId: updated.id,
      action: 'UPDATE',
      oldValue: existing,
      newValue: updated,
      tableName: 'invoice',
      syncAction: 'UPDATE',
      payload: updated,
    });

    res.json({ invoice: updated });
  })
);

invoicesRouter.post(
  '/:id/post',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!invoice) throw new HttpError(404, 'Invoice not found');
    if (invoice.status === 'POSTED') throw new HttpError(400, 'Invoice already posted');

    const company = await catalogPrisma.company.findUniqueOrThrow({ where: { id: invoice.companyId } });
    const fyLabel = currentFyLabel(company.fyStartMonth);

    // Round 18 — reject the whole post if any line's qty exceeds what's
    // actually in stock; previously nothing checked this at any layer, so a
    // bill could be posted (and stock driven negative) for more than a shop
    // had on hand. Checked before the transaction so a short-stock item
    // blocks the post before any balance/number/stock changes happen.
    const stockByItem = await prisma.item.findMany({
      where: { id: { in: invoice.items.map((line) => line.itemId) } },
      select: { id: true, sku: true, stockQty: true },
    });
    const shortItems = invoice.items
      .map((line) => {
        const item = stockByItem.find((i) => i.id === line.itemId);
        return item && Number(line.qty) > Number(item.stockQty) ? `${item.sku} (have ${item.stockQty}, need ${line.qty})` : null;
      })
      .filter((msg): msg is string => msg !== null);
    if (shortItems.length > 0) {
      throw new HttpError(400, `Not enough stock to post this bill: ${shortItems.join(', ')}`);
    }

    // Number assignment + party ledger update run in one transaction so a
    // concurrent post can't read the same "next number" twice
    // (docs/SCHEMA.md: invoice numbers must be sequential & gap-free).
    //
    // Uses MAX(existing numeric suffix) + 1, not COUNT(rows) + 1: a row count
    // silently assumes every posted/cancelled invoice was assigned strictly
    // in order with zero gaps, which broke in practice (test data posted out
    // of chronological order left row-count and highest-assigned-number out
    // of sync, so count-based numbering recomputed an already-used number and
    // every post started failing on the unique constraint). Max-based is
    // self-correcting regardless of posting order or historical gaps.
    const posted = await prisma.$transaction(async (tx) => {
      const existing = await tx.invoice.findMany({
        where: { companyId: invoice.companyId, fyLabel, status: { in: ['POSTED', 'CANCELLED'] } },
        select: { number: true },
      });
      const maxSeq = existing.reduce((max, row) => {
        const seq = parseInt(row.number.split('/').pop() ?? '', 10);
        return Number.isFinite(seq) && seq > max ? seq : max;
      }, 0);
      const number = `${company.invoicePrefix}/${fyLabel}/${String(maxSeq + 1).padStart(4, '0')}`;

      // Old/new balance (docs/SCOPE.md #5) — a posted invoice is a debit
      // against the party's running balance. Walk-in sales (no partyId) have
      // no ledger entry, but newBalance must still equal this invoice's own
      // total (Round 18) — it's what the payment-collection panel reads as
      // "amount owed on this bill" (BillingPage.tsx/InvoicesPage.tsx), and
      // leaving it at 0 for Walk-in wrongly showed every cash sale as
      // already paid off.
      let oldBalance = 0;
      if (invoice.partyId) {
        const party = await tx.party.findUniqueOrThrow({ where: { id: invoice.partyId } });
        oldBalance = Number(party.balance);
      }
      const newBalance = oldBalance + Number(invoice.total);
      if (invoice.partyId) {
        await tx.ledgerEntry.create({
          data: {
            partyId: invoice.partyId,
            debit: invoice.total,
            credit: 0,
            balance: newBalance,
            refType: 'Invoice',
            refId: invoice.id,
            invoiceId: invoice.id,
          },
        });
        await tx.party.update({ where: { id: invoice.partyId }, data: { balance: newBalance } });
      }

      return tx.invoice.update({
        where: { id: invoice.id },
        data: { status: 'POSTED', number, fyLabel, oldBalance, newBalance },
      });
    });

    for (const line of invoice.items) {
      await applyStockMovement(prisma, {
        itemId: line.itemId,
        type: 'SALE',
        qty: -Number(line.qty),
        refType: 'Invoice',
        refId: invoice.id,
      });
    }

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Invoice',
      entityId: posted.id,
      action: 'UPDATE',
      oldValue: invoice,
      newValue: posted,
      tableName: 'invoice',
      syncAction: 'UPDATE',
      payload: posted,
    });

    res.json({ invoice: posted });
  })
);

const cancelSchema = z.object({ reason: z.string().min(1) });

invoicesRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = cancelSchema.parse(req.body);
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!invoice) throw new HttpError(404, 'Invoice not found');
    // SCHEMA.md lifecycle: posted invoices are never deleted, only cancelled.
    // TODO: block cancel once the invoice's period is locked (Setting-based
    // period lock, Day 7) — cancel becomes credit-note-only after filing.

    const cancelled = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: input.reason },
    });

    if (invoice.status === 'POSTED') {
      for (const line of invoice.items) {
        await applyStockMovement(prisma, {
          itemId: line.itemId,
          type: 'SALE',
          qty: Number(line.qty), // reverse
          refType: 'Invoice',
          refId: invoice.id,
          reason: `Cancelled: ${input.reason}`,
        });
      }

      // Round 19 — cancelling a posted invoice reversed stock but never
      // touched the party's ledger balance: the debit posted for the
      // invoice's total, and the credit(s) posted for any payments already
      // recorded against it, both stayed on the books forever, leaving
      // Amount Due wrong on every invoice/party screen from then on.
      // Payment rows themselves are left untouched (same never-delete
      // philosophy as invoices) — only their balance effect is reversed here,
      // via one consolidated ledger entry.
      if (invoice.partyId) {
        const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id, partyId: invoice.partyId } });
        const paymentsTotal = payments.reduce((s, p) => s + Number(p.amount), 0);
        const netReversal = Number(invoice.total) - paymentsTotal;
        if (netReversal !== 0) {
          const lastEntry = await prisma.ledgerEntry.findFirst({ where: { partyId: invoice.partyId }, orderBy: { date: 'desc' } });
          const currentBalance = lastEntry?.balance ? Number(lastEntry.balance) : 0;
          const newBalance = currentBalance - netReversal;
          await prisma.ledgerEntry.create({
            data: {
              partyId: invoice.partyId,
              debit: netReversal < 0 ? -netReversal : 0,
              credit: netReversal > 0 ? netReversal : 0,
              balance: newBalance,
              refType: 'Invoice',
              refId: invoice.id,
              invoiceId: invoice.id,
            },
          });
          await prisma.party.update({ where: { id: invoice.partyId }, data: { balance: newBalance } });
        }
      }
    }

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Invoice',
      entityId: cancelled.id,
      action: 'CANCEL',
      oldValue: invoice,
      newValue: cancelled,
      tableName: 'invoice',
      syncAction: 'UPDATE',
      payload: cancelled,
    });

    res.json({ invoice: cancelled });
  })
);
