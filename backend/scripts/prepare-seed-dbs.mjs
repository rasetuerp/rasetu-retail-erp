import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runPrismaDbPush(schemaPath, env) {
  const prismaCli = path.join(backendRoot, 'node_modules', 'prisma', 'build', 'index.js');
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--schema', schemaPath, '--skip-generate'], {
    cwd: backendRoot,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

function ensureSeedDb(dbPath, schemaPath, env) {
  if (fs.existsSync(dbPath)) {
    console.log(`Seed database ready: ${path.relative(backendRoot, dbPath)}`);
    return;
  }

  runPrismaDbPush(schemaPath, env);
}

fs.mkdirSync(path.join(backendRoot, 'prisma', 'catalog'), { recursive: true });
fs.mkdirSync(path.join(backendRoot, 'prisma', 'company'), { recursive: true });

ensureSeedDb(path.join(backendRoot, 'prisma', 'catalog', 'catalog.db'), 'prisma/catalog/schema.prisma', {
  CATALOG_DATABASE_URL: 'file:./catalog.db',
});

ensureSeedDb(path.join(backendRoot, 'prisma', 'company', 'template.db'), 'prisma/company/schema.prisma', {
  COMPANY_DATABASE_URL: 'file:./template.db',
});
