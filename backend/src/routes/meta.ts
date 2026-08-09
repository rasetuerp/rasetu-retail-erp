import { Router } from 'express';

import { getClothProfile } from '../lib/vertical-profile.js';

export const metaRouter = Router();

metaRouter.get('/vertical-profiles', (_req, res) => {
  // v1 ships one profile; Phase 2 adds hardware/electronics/steel (docs/PHASE2.md).
  // This is the raw base profile — company-specific label overrides/custom
  // fields (Round 10) are merged in separately by GET /companies/:id/items/fields.
  res.json({ profiles: [getClothProfile()] });
});
