import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/catalog-client.js';
import { disconnectAllCompanyClients } from './db/company-registry.js';
import { startSyncWorker } from './lib/sync-worker.js';

let shuttingDownAfterFatal = false;

function logFatalBackendError(kind: string, error: unknown) {
  const e = error instanceof Error ? error : new Error(String(error));
  console.error(`\n========== FATAL BACKEND ${kind.toUpperCase()} ==========`);
  console.error('timestamp:', new Date().toISOString());
  console.error('message:  ', e.message);
  console.error(e.stack ?? e);
  console.error('=================================================\n');
}

async function exitAfterFatal(kind: string, error: unknown) {
  logFatalBackendError(kind, error);
  if (shuttingDownAfterFatal) return;
  shuttingDownAfterFatal = true;
  try {
    await Promise.all([prisma.$disconnect(), disconnectAllCompanyClients()]);
  } finally {
    process.exit(1);
  }
}

process.on('uncaughtException', (error) => void exitAfterFatal('uncaughtException', error));
process.on('unhandledRejection', (reason) => void exitAfterFatal('unhandledRejection', reason));

const app = createApp();

async function main() {
  await prisma.$connect();
  app.listen(env.PORT, env.HOST, () => {
    console.log(`RaSetu Retail ERP backend listening on http://${env.HOST}:${env.PORT}`);
  });
  startSyncWorker();
}

main().catch(async (error) => {
  console.error('Failed to start backend', error);
  await prisma.$disconnect();
  process.exit(1);
});
