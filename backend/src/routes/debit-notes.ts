import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { applyStockMovement } from './stock.js';
import { HttpError } from '../lib/http-error.js';

// Round 10 — Purchase Return. Deliberately structured as the mirror image of
// credit-notes.ts (which is Sales Return): same line-item shape, same
// stock-movement pattern, same ledger pattern — just the opposite direction
// on both (stock leaves instead of arriving; the supplier's balance goes
// down by a "credit" the same way a customer's does after a sales return,
// following purchases.ts's own "purchase = debit, return = credit" convention
// established this round when purchases.ts's own ledger tracking was added).

export const debitNotesRouter = Router({ mergeParams: true });

const createDebitNoteSchema = z.object({
  purchaseId: z.string(),
  reason: z.string().min(1),
  items: z.array(z.object({ itemId: z.string(), qty: z.number().positive(), rate: z.number().nonnegative() })).min(1),
});

debitNotesRouter.use(requireAuth);

debitNotesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const notes = await prisma.debitNote.findMany({
      where: { companyId: req.params.companyId },
      include: { items: true, party: true, purchase: true },
      orderBy: { date: 'desc' },
    });
    res.json({ debitNotes: notes });
  })
);

debitNotesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = createDebitNoteSchema.parse(req.body);
    const purchase = await prisma.purchase.findUnique({ where: { id: input.purchaseId } });
    if (!purchase) throw new HttpError(404, 'Purchase not found');

    const amount = input.items.reduce((sum, i) => sum + i.qty * i.rate, 0);

    const count = await prisma.debitNote.count({ where: { companyId: req.params.companyId } });
    const number = `DN/${new Date().getFullYear()}/${String(count + 1).padStart(4, '0')}`;

    const note = await prisma.$transaction(async (tx) => {
      const created = await tx.debitNote.create({
        data: {
          companyId: req.params.companyId,
          number,
          purchaseId: input.purchaseId,
          partyId: purchase.partyId,
          amount,
          reason: input.reason,
        },
      });
      await tx.debitNoteItem.createMany({
        data: input.items.map((i) => ({
          debitNoteId: created.id,
          itemId: i.itemId,
          qty: i.qty,
          rate: i.rate,
          amount: i.qty * i.rate,
        })),
      });
      return created;
    });

    // Stock leaves — going back to the supplier.
    for (const line of input.items) {
      await applyStockMovement(prisma, {
        itemId: line.itemId,
        type: 'PURCHASE_RETURN',
        qty: -line.qty,
        refType: 'DebitNote',
        refId: note.id,
      });
    }

    // Reduces what the shop owes the supplier — same "credit reduces
    // balance" convention as payments.ts/credit-notes.ts.
    const party = await prisma.party.findUniqueOrThrow({ where: { id: purchase.partyId } });
    const newBalance = Number(party.balance) - amount;
    await prisma.ledgerEntry.create({
      data: { partyId: purchase.partyId, debit: 0, credit: amount, balance: newBalance, refType: 'DebitNote', refId: note.id },
    });
    await prisma.party.update({ where: { id: purchase.partyId }, data: { balance: newBalance } });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'DebitNote',
      entityId: note.id,
      action: 'CREATE',
      newValue: note,
      tableName: 'debitNote',
      syncAction: 'CREATE',
      payload: note,
    });

    res.status(201).json({ debitNote: note });
  })
);
