// tsc only compiles src/**/*.ts into dist/ — it never copies Prisma's
// pre-generated client (src/generated/{catalog-client,company-client}: plain
// .js/.d.ts plus the native query-engine binary). Without this step, dist/
// (the only thing electron-builder.yml packages — backend/src is explicitly
// excluded from the installer) has no Prisma client at all, and every
// backend that imports it — company-registry.ts, every route file — fails
// at runtime with ERR_MODULE_NOT_FOUND. Run after tsc as part of `build`.
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
cpSync(path.join(backendRoot, 'src', 'generated'), path.join(backendRoot, 'dist', 'generated'), { recursive: true });
