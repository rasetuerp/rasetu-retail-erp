import { Router } from 'express';

import { listDrives } from '../lib/drives.js';
import { asyncHandler } from '../lib/async-handler.js';

// Round 9 — backs the "where should this company's data live?" picker in
// SetupWizardPage.tsx and the shop-picker's presence check. Public (like
// GET /companies) since it's needed before login exists. See
// backend/src/lib/drives.ts for why this isn't just drivelist.list().
export const systemRouter = Router();

systemRouter.get(
  '/drives',
  asyncHandler(async (_req, res) => {
    const drives = await listDrives();
    res.json({ drives });
  })
);
