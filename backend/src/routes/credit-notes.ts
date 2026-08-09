import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { applyStockMovement } from './stock.js';
import { HttpError } from '../lib/http-error.js';
import { getPaymentModes } from './payments.js';

// SCHEMA.md: "posted invoice, after day close / filed period" can only be
// corrected via Credit Note — this is that legal correction path.
//
// Round 10 — this is also RaSetu's Sales Return: `items` (added this round)
// is what makes it functional rather than a flat financial note. Amount is
// DERIVED from the returned lines (qty × rate), never a separate input, so
// the note can never disagree with what was actually returned.

export const creditNotesRouter = Router({ mergeParams: true });

const createCreditNoteSchema = z.object({
  invoiceId: z.string(),
  reason: z.string().min(1),
  items: z.array(z.object({ itemId: z.string(), qty: z.number().positive(), rate: z.number().nonnegative() })).min(1),
});

creditNotesRouter.use(requireAuth);

creditNotesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const notes = await prisma.creditNote.findMany({
      where: { companyId: req.params.companyId },
      include: { items: true, party: true, invoice: true },
      orderBy: { date: 'desc' },
    });
    res.json({ creditNotes: notes });
  })
);

creditNotesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = createCreditNoteSchema.parse(req.body);
    const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
    if (!invoice || !invoice.partyId) throw new HttpError(404, 'Invoice or party not found');

    const amount = input.items.reduce((sum, i) => sum + i.qty * i.rate, 0);

    const count = await prisma.creditNote.count({ where: { companyId: req.params.companyId } });
    const number = `CN/${new Date().getFullYear()}/${String(count + 1).padStart(4, '0')}`;

    // Company (catalog-adjacent) writes here are all within one SQLite file,
    // unlike companies.ts's cross-database Company+User creation — a real
    // $transaction is possible and used for the note + its line items.
    const note = await prisma.$transaction(async (tx) => {
      const created = await tx.creditNote.create({
        data: {
          companyId: req.params.companyId,
          number,
          invoiceId: input.invoiceId,
          partyId: invoice.partyId!,
          amount,
          reason: input.reason,
        },
      });
      await tx.creditNoteItem.createMany({
        data: input.items.map((i) => ({
          creditNoteId: created.id,
          itemId: i.itemId,
          qty: i.qty,
          rate: i.rate,
          amount: i.qty * i.rate,
        })),
      });
      return created;
    });

    // Stock comes back — one movement per returned line, same engine every
    // other stock-affecting write goes through (stock.ts's applyStockMovement,
    // RULES.md-equivalent "never touch Item.stockQty directly").
    for (const line of input.items) {
      await applyStockMovement(prisma, {
        itemId: line.itemId,
        type: 'SALES_RETURN',
        qty: line.qty,
        refType: 'CreditNote',
        refId: note.id,
      });
    }

    // Same running-balance ledger pattern payments.ts already uses — a
    // return reduces what the customer owes, exactly like a payment does.
    const lastEntry = await prisma.ledgerEntry.findFirst({ where: { partyId: invoice.partyId }, orderBy: { date: 'desc' } });
    const runningBalance = (lastEntry?.balance ? Number(lastEntry.balance) : 0) - amount;
    await prisma.ledgerEntry.create({
      data: {
        partyId: invoice.partyId,
        credit: amount,
        balance: runningBalance,
        refType: 'CreditNote',
        refId: note.id,
        invoiceId: invoice.id,
      },
    });
    await prisma.party.update({ where: { id: invoice.partyId }, data: { balance: runningBalance } });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'CreditNote',
      entityId: note.id,
      action: 'CREATE',
      newValue: note,
      tableName: 'creditNote',
      syncAction: 'CREATE',
      payload: note,
    });

    res.status(201).json({ creditNote: note });
  })
);

// Round 15 — a Sales Return today only ever becomes store credit (the
// balance reduction above). This records that some/all of it was actually
// handed back as cash instead, which is a genuinely different operation
// from a normal payment: POST /payments' `balance -= amount` is correct for
// a customer paying the shop or the shop paying a supplier (both settle a
// positive "outstanding" balance the same way), but a return already pushed
// this balance in the *opposite* direction (toward the shop owing the
// customer) — refunding must move it back up toward zero, not further down.
const refundSchema = z.object({
  amount: z.number().positive(),
  mode: z.string().min(1),
});

creditNotesRouter.post(
  '/:noteId/refund',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = refundSchema.parse(req.body);
    const note = await prisma.creditNote.findUnique({ where: { id: req.params.noteId } });
    if (!note || note.companyId !== req.params.companyId) throw new HttpError(404, 'Credit note not found');

    const remaining = Number(note.amount) - Number(note.refundedAmount);
    if (input.amount > remaining) {
      throw new HttpError(400, `Cannot refund more than the remaining ₹${remaining.toFixed(2)} on this return.`);
    }

    const modes = await getPaymentModes(prisma, req.params.companyId);
    if (!modes.some((m) => m.name === input.mode && m.isActive)) {
      throw new HttpError(400, `Unknown or inactive payment mode: ${input.mode}`);
    }

    // Logged as a real Payment row (direction OUT) for the audit trail, same
    // as any other money movement — but its balance effect is applied
    // directly below, not through POST /payments' own math.
    const payment = await prisma.payment.create({
      data: {
        companyId: req.params.companyId,
        mode: input.mode,
        amount: input.amount,
        direction: 'OUT',
        invoiceId: note.invoiceId,
        partyId: note.partyId,
      },
    });

    const party = await prisma.party.findUniqueOrThrow({ where: { id: note.partyId } });
    const runningBalance = Number(party.balance) + input.amount;
    await prisma.ledgerEntry.create({
      data: {
        partyId: note.partyId,
        debit: input.amount,
        balance: runningBalance,
        refType: 'Refund',
        refId: note.id,
        invoiceId: note.invoiceId,
      },
    });
    await prisma.party.update({ where: { id: note.partyId }, data: { balance: runningBalance } });

    const updated = await prisma.creditNote.update({
      where: { id: note.id },
      data: { refundedAmount: Number(note.refundedAmount) + input.amount },
    });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'CreditNote',
      entityId: note.id,
      action: 'UPDATE',
      newValue: updated,
      tableName: 'creditNote',
      syncAction: 'UPDATE',
      payload: updated,
    });

    res.json({ creditNote: updated, payment });
  })
);
