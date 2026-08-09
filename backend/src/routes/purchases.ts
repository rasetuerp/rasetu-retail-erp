import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { HttpError } from '../lib/http-error.js';
import { applyStockMovement } from './stock.js';

// SCOPE.md #6 (Purchase Entry) — party bill entry, auto stock-in, GST input
// capture for GSTR-2B/3B reconciliation (docs/GST-SPEC.md sheet 7).

export const purchasesRouter = Router({ mergeParams: true });

const purchaseItemSchema = z.object({
  itemId: z.string(),
  qty: z.number().positive(),
  rate: z.number(),
  gstRate: z.number(),
});

const createPurchaseSchema = z.object({
  partyId: z.string(),
  billNumber: z.string().min(1),
  billDate: z.coerce.date().default(() => new Date()),
  items: z.array(purchaseItemSchema).min(1),
});

purchasesRouter.use(requireAuth);

purchasesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const purchases = await prisma.purchase.findMany({
      where: { companyId: req.params.companyId },
      orderBy: { billDate: 'desc' },
      include: { items: { include: { item: true } }, party: true },
    });
    res.json({ purchases });
  })
);

purchasesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = createPurchaseSchema.parse(req.body);
    const subtotal = input.items.reduce((sum, i) => sum + i.qty * i.rate, 0);
    // TODO Day 7: CGST/SGST vs IGST split by supplier state, same as invoices.

    const purchase = await prisma.purchase.create({
      data: {
        companyId: req.params.companyId,
        partyId: input.partyId,
        billNumber: input.billNumber,
        billDate: input.billDate,
        subtotal,
        total: subtotal,
        items: {
          create: input.items.map((i) => ({
            itemId: i.itemId,
            qty: i.qty,
            rate: i.rate,
            gstRate: i.gstRate,
            amount: i.qty * i.rate,
          })),
        },
      },
      include: { items: true },
    });

    for (const line of purchase.items) {
      await applyStockMovement(prisma, {
        itemId: line.itemId,
        type: 'PURCHASE',
        qty: Number(line.qty),
        refType: 'Purchase',
        refId: purchase.id,
      });
    }

    // Round 10 — a real, adjacent gap found while building Purchase Return
    // (debit-notes.ts): recording a purchase never updated the supplier's
    // balance/ledger at all, so a Purchase Return's own ledger entry would
    // have had nothing correct to subtract from. Mirrors invoices.ts's own
    // /post handler exactly (a purchase is a "debit" against the supplier's
    // balance, same as a sale is against a customer's — both increase what's
    // owed; a Payment or DebitNote's "credit" is what reduces it).
    const party = await prisma.party.findUniqueOrThrow({ where: { id: input.partyId } });
    const newBalance = Number(party.balance) + subtotal;
    await prisma.ledgerEntry.create({
      data: { partyId: input.partyId, debit: subtotal, credit: 0, balance: newBalance, refType: 'Purchase', refId: purchase.id },
    });
    await prisma.party.update({ where: { id: input.partyId }, data: { balance: newBalance } });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Purchase',
      entityId: purchase.id,
      action: 'CREATE',
      newValue: purchase,
      tableName: 'purchase',
      syncAction: 'CREATE',
      payload: purchase,
    });

    res.status(201).json({ purchase });
  })
);

purchasesRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const purchase = await prisma.purchase.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!purchase) throw new HttpError(404, 'Purchase not found');
    if (purchase.monthLocked) throw new HttpError(400, 'Cannot cancel — month is locked (SCHEMA.md)');

    const cancelled = await prisma.purchase.update({
      where: { id: purchase.id },
      data: { cancelledAt: new Date() },
    });

    for (const line of purchase.items) {
      await applyStockMovement(prisma, {
        itemId: line.itemId,
        type: 'PURCHASE',
        qty: -Number(line.qty),
        refType: 'Purchase',
        refId: purchase.id,
        reason: 'Purchase cancelled',
      });
    }

    // Round 10 — reverse the ledger debit this purchase created, same
    // symmetry as invoices.ts's own cancel path.
    if (purchase.partyId) {
      const party = await prisma.party.findUniqueOrThrow({ where: { id: purchase.partyId } });
      const newBalance = Number(party.balance) - Number(purchase.total);
      await prisma.ledgerEntry.create({
        data: { partyId: purchase.partyId, debit: 0, credit: purchase.total, balance: newBalance, refType: 'Purchase', refId: purchase.id },
      });
      await prisma.party.update({ where: { id: purchase.partyId }, data: { balance: newBalance } });
    }

    res.json({ purchase: cancelled });
  })
);
