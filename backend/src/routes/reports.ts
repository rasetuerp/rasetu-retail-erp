import { Router } from 'express';

import { requireAuth, requireCompanyDb } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';

// SCOPE.md #10: Sales/Purchase/Stock/Outstanding reports. Data endpoints only;
// Print/PDF/Excel rendering happens in the frontend's shared exportUtils.ts.

export const reportsRouter = Router({ mergeParams: true });

reportsRouter.use(requireAuth);

reportsRouter.get(
  '/sales',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { from, to } = req.query as { from?: string; to?: string };
    const toEndOfDay = to ? new Date(to) : undefined;
    toEndOfDay?.setHours(23, 59, 59, 999);
    const invoices = await prisma.invoice.findMany({
      where: {
        companyId: req.params.companyId,
        status: 'POSTED',
        ...(from || to
          ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(toEndOfDay ? { lte: toEndOfDay } : {}) } }
          : {}),
      },
      include: { items: true, party: true },
      orderBy: { date: 'asc' },
    });
    res.json({ invoices });
  })
);

reportsRouter.get(
  '/stock',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { lowStockOnly } = req.query as { lowStockOnly?: string };
    const items = await prisma.item.findMany({ where: { companyId: req.params.companyId, isActive: true } });
    const result = lowStockOnly === 'true' ? items.filter((i) => i.stockQty.lte(i.minStock)) : items;
    res.json({ items: result });
  })
);

function agingBucket(dueDate: Date | null): 'current' | '1-30' | '31-60' | '61-90' | '90+' {
  if (!dueDate) return 'current';
  const daysPast = Math.floor((Date.now() - dueDate.getTime()) / 86_400_000);
  if (daysPast <= 0) return 'current';
  if (daysPast <= 30) return '1-30';
  if (daysPast <= 60) return '31-60';
  if (daysPast <= 90) return '61-90';
  return '90+';
}

reportsRouter.get(
  '/outstanding',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const parties = await prisma.party.findMany({
      where: { companyId: req.params.companyId, isActive: true, balance: { not: 0 } },
      orderBy: { balance: 'desc' },
    });

    const partyIds = parties.map((p) => p.id);
    const dueRows = partyIds.length
      ? await prisma.invoice.findMany({
          where: { partyId: { in: partyIds }, status: 'POSTED', dueDate: { not: null } },
          orderBy: { dueDate: 'asc' },
          select: { partyId: true, dueDate: true },
        })
      : [];

    const earliestDueByParty = new Map<string, Date>();
    for (const row of dueRows) {
      if (row.partyId && row.dueDate && !earliestDueByParty.has(row.partyId)) {
        earliestDueByParty.set(row.partyId, row.dueDate);
      }
    }

    const now = new Date();
    const withDueDate = parties.map((p) => {
      const dueDate = earliestDueByParty.get(p.id) ?? null;
      const overdue = dueDate ? dueDate < now : false;
      return { ...p, dueDate, overdue, agingBucket: agingBucket(dueDate) };
    });

    res.json({ parties: withDueDate });
  })
);

reportsRouter.get(
  '/dead-stock',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const days = Number((req.query as { days?: string }).days ?? 60);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const items = await prisma.item.findMany({ where: { companyId: req.params.companyId, isActive: true } });

    const itemIds = items.map((item) => item.id);
    const lastSaleRows = itemIds.length
      ? await prisma.stockMovement.groupBy({
          by: ['itemId'],
          where: { itemId: { in: itemIds }, type: 'SALE' },
          _max: { createdAt: true },
        })
      : [];

    const lastSaleByItem = new Map(lastSaleRows.map((row) => [row.itemId, row._max.createdAt ?? null]));
    const withLastSale = items.map((item) => ({ ...item, lastSaleAt: lastSaleByItem.get(item.id) ?? null }));
    const deadStock = withLastSale.filter((i) => !i.lastSaleAt || i.lastSaleAt < cutoff);
    res.json({ items: deadStock, days });
  })
);
