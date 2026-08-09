import fs from 'node:fs';
import path from 'node:path';

import { BACKEND_ROOT } from './backend-root.js';

// Round 4/12 — reads the license key straight out of the same JSON snapshot
// file electron/main.ts writes (shares RASETU_DATA_DIR with
// db/company-registry.ts) rather than needing new IPC plumbing — the backend
// runs as its own process, not inside the Electron renderer, so it has no
// access to window.rasetu. Originally lived only in sync-worker.ts; extracted
// here since Round 12's password-reset flow needs the same read.
export function readLicenseKey(): string | null {
  const dataDir = process.env.RASETU_DATA_DIR ?? path.resolve(BACKEND_ROOT, 'prisma');
  try {
    const snapshot: unknown = JSON.parse(fs.readFileSync(path.join(dataDir, 'license-snapshot.json'), 'utf8'));
    const key = (snapshot as { licenseKey?: unknown })?.licenseKey;
    return typeof key === 'string' ? key : null;
  } catch {
    return null;
  }
}
