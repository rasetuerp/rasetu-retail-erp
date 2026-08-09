import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runPrismaDbPush(schemaPath, env) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(npx, ['prisma', 'db', 'push', '--schema', schemaPath, '--skip-generate'], {
    cwd: backendRoot,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

fs.mkdirSync(path.join(backendRoot, 'prisma', 'catalog'), { recursive: true });
fs.mkdirSync(path.join(backendRoot, 'prisma', 'company'), { recursive: true });

runPrismaDbPush('prisma/catalog/schema.prisma', {
  CATALOG_DATABASE_URL: 'file:./catalog.db',
});

runPrismaDbPush('prisma/company/schema.prisma', {
  COMPANY_DATABASE_URL: 'file:./template.db',
});
