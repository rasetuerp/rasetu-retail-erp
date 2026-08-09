import { Router } from 'express';

import { requireAuth, requireCompanyDb } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';

// SCOPE.md #11 / docs/GST-SPEC.md — the one-click GST Returns Pack. This
// endpoint returns the raw data for all 8 sheets; the frontend's exportUtils.ts
// turns it into one Excel workbook (SheetJS) on Day 8. Do not build XLSX
// generation server-side — keep export logic in the one shared frontend utility.

export const gstReportsRouter = Router({ mergeParams: true });

gstReportsRouter.use(requireAuth);

gstReportsRouter.get(
  '/pack',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { month } = req.query as { month?: string }; // "2026-07"
    if (!month) return res.status(400).json({ error: 'month query param required, e.g. 2026-07' });

    const [year, mon] = month.split('-').map(Number);
    const from = new Date(year, mon - 1, 1);
    const to = new Date(year, mon, 0, 23, 59, 59);

    const invoices = await prisma.invoice.findMany({
      where: { companyId: req.params.companyId, date: { gte: from, lte: to } },
      include: { items: { include: { item: true } }, party: true },
    });

    const posted = invoices.filter((i) => i.status === 'POSTED');
    const b2b = posted.filter((i) => i.party?.gstin);
    const b2c = posted.filter((i) => !i.party?.gstin);
    const creditNotes = await prisma.creditNote.findMany({
      where: { companyId: req.params.companyId, date: { gte: from, lte: to } },
    });
    const purchases = await prisma.purchase.findMany({
      where: { companyId: req.params.companyId, billDate: { gte: from, lte: to } },
      include: { items: true, party: true },
    });

    // HSN summary
    const hsnMap = new Map<string, { hsn: string; qty: number; taxable: number; tax: number }>();
    for (const inv of posted) {
      for (const line of inv.items) {
        const hsn = line.item.hsn ?? 'UNSPECIFIED';
        const entry = hsnMap.get(hsn) ?? { hsn, qty: 0, taxable: 0, tax: 0 };
        entry.qty += Number(line.qty);
        entry.taxable += Number(line.amount);
        hsnMap.set(hsn, entry);
      }
    }

    res.json({
      month,
      b2b,
      b2cSmall: b2c, // TODO Day 8: split large inter-state invoices into b2cLarge per threshold
      b2cLarge: [],
      creditNotes,
      hsnSummary: Array.from(hsnMap.values()),
      // Documents Issued only covers invoices that ever received a real
      // sequence number (POSTED/CANCELLED) — Draft/Held rows carry a
      // temporary placeholder (see routes/invoices.ts tempInvoiceNumber) and
      // were never part of the number series, so they don't belong here.
      documentsIssued: {
        total: invoices.filter((i) => i.status === 'POSTED' || i.status === 'CANCELLED').length,
        cancelled: invoices.filter((i) => i.status === 'CANCELLED').length,
      },
      purchaseRegister: purchases,
      gstr3bSummary: {
        outwardTaxableValue: posted.reduce((s, i) => s + Number(i.subtotal), 0),
        cgst: posted.reduce((s, i) => s + Number(i.cgst), 0),
        sgst: posted.reduce((s, i) => s + Number(i.sgst), 0),
        igst: posted.reduce((s, i) => s + Number(i.igst), 0),
      },
    });
  })
);
