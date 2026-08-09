import { Router } from 'express';

import { requireAuth, requireCompanyDb, requireRole } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';

// SCHEMA.md — every edit/cancel writes here via lib/mutation-log.ts. Read-only
// surface for admins to review disputes.

export const auditLogsRouter = Router({ mergeParams: true });

auditLogsRouter.use(requireAuth, requireRole('ADMIN'));

auditLogsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { entity, entityId } = req.query as { entity?: string; entityId?: string };
    const logs = await prisma.auditLog.findMany({
      where: { ...(entity ? { entity } : {}), ...(entityId ? { entityId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ logs });
  })
);
