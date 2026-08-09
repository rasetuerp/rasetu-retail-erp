import { Router } from 'express';

import { requireAuth, requireCompanyDb } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';

// SCOPE.md #10 — Sales/Purchase/Stock/Outstanding reports. Data endpoints only;
// Print/PDF/Excel rendering happens in the frontend's shared exportUtils.ts
// (RULES.md #8, built Day 3) — never build export logic per report here.

export const reportsRouter = Router({ mergeParams: true });

reportsRouter.use(requireAuth);

reportsRouter.get(
  '/sales',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { from, to } = req.query as { from?: string; to?: string };
    // `to` is inclusive of the whole day — a bare "2026-07-23" parses to UTC
    // midnight, which would otherwise exclude every same-day invoice.
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

// Round 10 — days-past-due -> a coarse bucket, matching the standard
// receivables-aging vocabulary a shop owner already expects to see.
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
    // Per-party earliest-due POSTED invoice — a pragmatic approximation (no
    // aging math per PRD), not a strict 1:1 invoice-to-party model. N+1 here
    // is fine at small-shop scale (see pre-build review, "suggestions"); a
    // join is the spot to optimize if the party list grows large.
    const withDueDate = await Promise.all(
      parties.map(async (p) => {
        const earliest = await prisma.invoice.findFirst({
          where: { partyId: p.id, status: 'POSTED', dueDate: { not: null } },
          orderBy: { dueDate: 'asc' },
          select: { dueDate: true },
        });
        const dueDate = earliest?.dueDate ?? null;
        const overdue = dueDate ? dueDate < new Date() : false;
        // Round 10 — one more derived field per party, same N+1-at-small-scale
        // shape as dueDate/overdue above, not a new query pattern.
        return { ...p, dueDate, overdue, agingBucket: agingBucket(dueDate) };
      })
    );
    res.json({ parties: withDueDate });
  })
);

// Round 10 — items with no SALE movement in the last N days (default 60).
// Same prisma.item.findMany + related-movement lookup shape /stock already
// uses, just one more derived field per item.
reportsRouter.get(
  '/dead-stock',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const days = Number((req.query as { days?: string }).days ?? 60);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const items = await prisma.item.findMany({ where: { companyId: req.params.companyId, isActive: true } });
    const withLastSale = await Promise.all(
      items.map(async (item) => {
        const lastSale = await prisma.stockMovement.findFirst({
          where: { itemId: item.id, type: 'SALE' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        return { ...item, lastSaleAt: lastSale?.createdAt ?? null };
      })
    );
    const deadStock = withLastSale.filter((i) => !i.lastSaleAt || i.lastSaleAt < cutoff);
    res.json({ items: deadStock, days });
  })
);

// TODO (Day 8): /purchase report (mirrors /sales against Purchase model).
