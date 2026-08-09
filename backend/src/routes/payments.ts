import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb, requireRole } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { HttpError } from '../lib/http-error.js';
import type { PrismaClient as CompanyPrismaClient } from '../generated/company-client/index.js';

// Part of SCOPE.md #5 (multiple payment modes, part payments) and #9 (ledger).

export const paymentsRouter = Router({ mergeParams: true });

// Round 5 — payment modes used to be a fixed Prisma enum; they're now an
// admin-editable list stored the same way label-print settings are (see
// labels.ts's SETTING_KEY pattern), validated here instead of at the DB.
const PAYMENT_MODES_KEY = 'payment-modes';
type PaymentModeEntry = { name: string; isActive: boolean };
const DEFAULT_PAYMENT_MODES: PaymentModeEntry[] = [
  { name: 'CASH', isActive: true },
  { name: 'UPI', isActive: true },
  { name: 'CARD', isActive: true },
  { name: 'CHEQUE', isActive: true },
  { name: 'CREDIT', isActive: true },
];

// Exported so credit-notes.ts's refund route (Round 15) can validate a
// refund's mode against the same admin-editable list, instead of duplicating
// this lookup.
export async function getPaymentModes(prisma: CompanyPrismaClient, companyId: string): Promise<PaymentModeEntry[]> {
  const setting = await prisma.setting.findUnique({ where: { companyId_key: { companyId, key: PAYMENT_MODES_KEY } } });
  return setting ? JSON.parse(setting.value) : DEFAULT_PAYMENT_MODES;
}

const createPaymentSchema = z.object({
  mode: z.string().min(1),
  amount: z.number().positive(),
  refNumber: z.string().optional(),
  invoiceId: z.string().optional(),
  partyId: z.string().optional(),
  // Round 10 — reporting/labeling only ("Receipts" vs "Payment Vouchers" in
  // the UI); defaulted from the party's type below if the caller doesn't
  // send it, so every pre-existing call site keeps working unchanged. Never
  // used in the balance/ledger math further down — see docs/SCHEMA.md.
  direction: z.enum(['IN', 'OUT']).optional(),
});

paymentsRouter.use(requireAuth);

paymentsRouter.get(
  '/modes',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const modes = await getPaymentModes(prisma, req.params.companyId);
    res.json({ modes });
  })
);

const paymentModesSchema = z.array(z.object({ name: z.string().min(1), isActive: z.boolean() }));

paymentsRouter.put(
  '/modes',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = paymentModesSchema.parse(req.body);
    const setting = await prisma.setting.upsert({
      where: { companyId_key: { companyId: req.params.companyId, key: PAYMENT_MODES_KEY } },
      create: { companyId: req.params.companyId, key: PAYMENT_MODES_KEY, value: JSON.stringify(input) },
      update: { value: JSON.stringify(input) },
    });
    res.json({ modes: JSON.parse(setting.value) });
  })
);

paymentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { partyId, invoiceId, direction } = req.query as { partyId?: string; invoiceId?: string; direction?: 'IN' | 'OUT' };
    const payments = await prisma.payment.findMany({
      where: {
        companyId: req.params.companyId,
        ...(partyId ? { partyId } : {}),
        ...(invoiceId ? { invoiceId } : {}),
        ...(direction ? { direction } : {}),
      },
      // Round 10 — party name for the Receipts/Payment-Vouchers report
      // (ReportsPage.tsx); this list previously only ever needed partyId.
      // Round 16 — invoice number too, so a per-invoice/per-party payments
      // list (PaymentSplitPanel.tsx, PartiesPage.tsx, ReportsPage.tsx) can
      // show which bill a payment applies to without a second round-trip.
      include: { party: true, invoice: { select: { number: true } } },
      orderBy: { date: 'desc' },
    });
    res.json({ payments });
  })
);

paymentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = createPaymentSchema.parse(req.body);

    const modes = await getPaymentModes(prisma, req.params.companyId);
    if (!modes.some((m) => m.name === input.mode && m.isActive)) {
      throw new HttpError(400, `Unknown or inactive payment mode: ${input.mode}`);
    }

    // Round 10 — default direction from the party's type when the caller
    // doesn't send one: paying a customer's due IN, paying a supplier OUT.
    let direction = input.direction;
    if (!direction) {
      const party = input.partyId ? await prisma.party.findUnique({ where: { id: input.partyId } }) : null;
      direction = party?.type === 'SUPPLIER' ? 'OUT' : 'IN';
    }

    const payment = await prisma.payment.create({
      data: { companyId: req.params.companyId, ...input, direction },
    });

    // Round 18 — CREDIT means paid by credit card, not "left on account";
    // it reduces the balance exactly like every other collection mode. (An
    // earlier round wrongly treated CREDIT as a deferred/uncollected sale.)
    if (input.partyId) {
      const lastEntry = await prisma.ledgerEntry.findFirst({
        where: { partyId: input.partyId },
        orderBy: { date: 'desc' },
      });
      const runningBalance = (lastEntry?.balance ? Number(lastEntry.balance) : 0) - input.amount;
      await prisma.ledgerEntry.create({
        data: {
          partyId: input.partyId,
          credit: input.amount,
          balance: runningBalance,
          refType: 'Payment',
          refId: payment.id,
          invoiceId: input.invoiceId,
        },
      });
      await prisma.party.update({ where: { id: input.partyId }, data: { balance: runningBalance } });
    }

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Payment',
      entityId: payment.id,
      action: 'CREATE',
      newValue: payment,
      tableName: 'payment',
      syncAction: 'CREATE',
      payload: payment,
    });

    res.status(201).json({ payment });
  })
);
