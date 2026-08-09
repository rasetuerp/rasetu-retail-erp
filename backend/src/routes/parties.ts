import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { HttpError } from '../lib/http-error.js';

// Backs SCOPE.md #9 (Parties & Ledger) — customers + suppliers unified via
// Party.type, matching the Prisma schema. GSTIN format check below is the
// "prevents 90% of CA rework" rule from docs/GST-SPEC.md.

export const partiesRouter = Router({ mergeParams: true });

const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/;

const createPartySchema = z.object({
  type: z.enum(['CUSTOMER', 'SUPPLIER']),
  name: z.string().min(1),
  gstin: z.string().regex(GSTIN_PATTERN).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  // Round 5 — deliberately no phone-uniqueness check: one phone number is
  // expected to be shared across multiple Party rows (family members under
  // one household number). "Family" = every Party row with this phone.
  dob: z.coerce.date().optional(),
  anniversary: z.coerce.date().optional(),
  notes: z.string().optional(),
  openingBalance: z.number().default(0),
  // Round 10 — advisory only (Billing warns, never blocks). 0/undefined = no limit.
  creditLimit: z.number().nonnegative().optional(),
});

partiesRouter.use(requireAuth);

partiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { type, search } = req.query as { type?: 'CUSTOMER' | 'SUPPLIER'; search?: string };
    const parties = await prisma.party.findMany({
      where: {
        companyId: req.params.companyId,
        isActive: true,
        ...(type ? { type } : {}),
        // Round 5 — widened from name-only so a cashier can find a customer by
        // whichever detail they're given at the counter (mobile number most often).
        ...(search
          ? { OR: [{ name: { contains: search } }, { phone: { contains: search } }, { address: { contains: search } }] }
          : {}),
      },
      orderBy: { name: 'asc' },
    });
    res.json({ parties });
  })
);

// Round 5 — "family" lookup: every Party row sharing this exact phone number,
// used by Billing's customer panel to show who's already linked to a number
// before deciding whether to add a new person under it.
partiesRouter.get(
  '/by-phone/:phone',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const parties = await prisma.party.findMany({
      where: { companyId: req.params.companyId, isActive: true, phone: req.params.phone },
      orderBy: { name: 'asc' },
    });
    res.json({ parties });
  })
);

partiesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = createPartySchema.parse(req.body);

    const party = await prisma.party.create({
      data: {
        companyId: req.params.companyId,
        type: input.type,
        name: input.name,
        gstin: input.gstin,
        phone: input.phone,
        email: input.email,
        address: input.address,
        dob: input.dob,
        anniversary: input.anniversary,
        notes: input.notes,
        balance: input.openingBalance,
        creditLimit: input.creditLimit,
      },
    });

    if (input.openingBalance !== 0) {
      await prisma.ledgerEntry.create({
        data: {
          partyId: party.id,
          debit: input.openingBalance > 0 ? input.openingBalance : 0,
          credit: input.openingBalance < 0 ? -input.openingBalance : 0,
          balance: input.openingBalance,
          refType: 'OpeningBalance',
        },
      });
    }

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Party',
      entityId: party.id,
      action: 'CREATE',
      newValue: party,
      tableName: 'party',
      syncAction: 'CREATE',
      payload: party,
    });

    res.status(201).json({ party });
  })
);

// Round 10 — needed by the Sales Return "Bill a replacement now" convenience
// link (Billing pre-selects a customer given only a partyId from Invoice
// History) — no single-party lookup existed before this; every other
// consumer already had the full party list loaded and found by ID client-side.
partiesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const party = await prisma.party.findUnique({ where: { id: req.params.id } });
    if (!party || party.companyId !== req.params.companyId) throw new HttpError(404, 'Party not found');
    res.json({ party });
  })
);

partiesRouter.get(
  '/:id/ledger',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const entries = await prisma.ledgerEntry.findMany({
      where: { partyId: req.params.id },
      orderBy: { date: 'asc' },
    });
    res.json({ entries });
  })
);

const updatePartySchema = z.object({
  type: z.enum(['CUSTOMER', 'SUPPLIER']).optional(),
  name: z.string().min(1).optional(),
  gstin: z.string().regex(GSTIN_PATTERN).optional().or(z.literal('')),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  dob: z.coerce.date().optional(),
  anniversary: z.coerce.date().optional(),
  notes: z.string().optional(),
  creditLimit: z.number().nonnegative().optional(),
});

partiesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = updatePartySchema.parse(req.body);
    const existing = await prisma.party.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.companyId !== req.params.companyId) throw new HttpError(404, 'Party not found');
    const updated = await prisma.party.update({
      where: { id: req.params.id },
      data: { ...input, gstin: input.gstin || null },
    });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Party',
      entityId: updated.id,
      action: 'UPDATE',
      oldValue: existing,
      newValue: updated,
      tableName: 'party',
      syncAction: 'UPDATE',
      payload: updated,
    });

    res.json({ party: updated });
  })
);

// TODO (Day 3): soft-delete via isActive=false only (SCHEMA.md master-data
// row) — never a hard delete, it breaks historical reports.
