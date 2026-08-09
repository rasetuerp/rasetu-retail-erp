import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BACKEND_ROOT } from './backend-root.js';

// v1 ships one profile; Phase 2 adds hardware/electronics/steel (docs/PHASE2.md).
// Shared by meta.ts (raw base profile), gst-calc.ts (mrpSlabRule), and
// items.ts (merged with a company's item-fields Setting) — previously each
// read+parsed the file independently; consolidated once a third call site
// needed the same data.
export type ItemAttribute = { key: string; label: string; type: string; required: boolean };
export type VerticalProfile = {
  key: string;
  itemAttributes: ItemAttribute[];
  units: { allowed: string[]; default: string };
  gst: { mrpSlabRule: { thresholdMrp: number; rateBelowOrEqual: number; rateAbove: number } };
};

let cachedClothProfile: VerticalProfile | null = null;

export function getClothProfile(): VerticalProfile {
  if (cachedClothProfile) return cachedClothProfile;
  const profilePath = path.resolve(BACKEND_ROOT, '..', 'config', 'profiles', 'profile-cloth.json');
  cachedClothProfile = JSON.parse(readFileSync(profilePath, 'utf8')) as VerticalProfile;
  return cachedClothProfile;
}
