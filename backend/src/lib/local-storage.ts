import path from 'node:path';

import { BACKEND_ROOT } from './backend-root.js';

// Round 4 — RASETU_DATA_DIR is the same root db/company-registry.ts uses for
// per-company database files (set by Electron's main process to
// app.getPath('userData')); falls back to a repo-relative dev path when unset.
export function localDataRoot(): string {
  return process.env.RASETU_DATA_DIR ?? path.resolve(BACKEND_ROOT, 'prisma');
}

export function uploadRoot(): string {
  return path.join(localDataRoot(), 'uploads');
}
