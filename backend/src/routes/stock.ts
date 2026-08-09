import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { HttpError } from '../lib/http-error.js';
import type { PrismaClient as CompanyPrismaClient } from '../generated/company-client/index.js';

// The StockMovement engine (docs/SPRINT_PLAN.md Day 2): every stock-affecting
// write — purchase, sale, adjust, damage, opening — MUST go through
// applyStockMovement() below. Never adjust Item.stockQty directly from a route.

export const stockRouter = Router({ mergeParams: true });

export async function applyStockMovement(prisma: CompanyPrismaClient, input: {
  itemId: string;
  type: 'PURCHASE' | 'SALE' | 'ADJUST' | 'DAMAGE' | 'OPENING' | 'SALES_RETURN' | 'PURCHASE_RETURN';
  qty: number; // signed: +in / -out
  refType?: string;
  refId?: string;
  reason?: string;
}) {
  if ((input.type === 'DAMAGE' || input.type === 'ADJUST') && !input.reason) {
    throw new HttpError(400, 'Reason is mandatory for damage/adjustment entries');
  }

  const [movement] = await prisma.$transaction([
    prisma.stockMovement.create({ data: input }),
    prisma.item.update({
      where: { id: input.itemId },
      data: { stockQty: { increment: input.qty } },
    }),
  ]);

  return movement;
}

const adjustmentSchema = z.object({
  itemId: z.string(),
  qty: z.number(),
  type: z.enum(['ADJUST', 'DAMAGE']),
  reason: z.string().min(1),
});

stockRouter.use(requireAuth);

// Round 15 — company-wide stock-adjustment/damage feed for the Returns &
// Adjustments report (ReportsPage.tsx). Unlike the per-item route below,
// this always filters to ADJUST/DAMAGE only — PURCHASE/SALE/OPENING/
// SALES_RETURN/PURCHASE_RETURN already have their own dedicated views
// elsewhere (Purchase Entry, Billing, Invoice History's Sales Return,
// Purchase Entry's own Purchase Return) and would just be noise here.
const movementTypesQuerySchema = z.object({
  types: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : ['ADJUST', 'DAMAGE']))
    .pipe(z.array(z.enum(['ADJUST', 'DAMAGE']))),
});

stockRouter.get(
  '/movements',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { types } = movementTypesQuerySchema.parse(req.query);
    const movements = await prisma.stockMovement.findMany({
      where: { type: { in: types } },
      include: { item: { select: { sku: true, category: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json({ movements });
  })
);

stockRouter.get(
  '/movements/:itemId',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const movements = await prisma.stockMovement.findMany({
      where: { itemId: req.params.itemId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ movements });
  })
);

stockRouter.post(
  '/adjustments',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = adjustmentSchema.parse(req.body);
    const movement = await applyStockMovement(prisma, input);

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'StockMovement',
      entityId: movement.id,
      action: 'CREATE',
      newValue: movement,
      tableName: 'stockMovement',
      syncAction: 'CREATE',
      payload: movement,
    });

    res.status(201).json({ movement });
  })
);
