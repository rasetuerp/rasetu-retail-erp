import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';

import { HttpError } from './lib/http-error.js';
import { BACKEND_ROOT } from './lib/backend-root.js';
import { resetCompanyClient, clearResolvedExternalDbPath, isKnownExternalCompany } from './db/company-registry.js';
import { healthRouter } from './routes/health.js';
import { metaRouter } from './routes/meta.js';
import { systemRouter } from './routes/system.js';
import { companiesRouter } from './routes/companies.js';
import { authRouter } from './routes/auth.js';
import { authSuperRouter } from './routes/auth-super.js';
import { usersRouter } from './routes/users.js';
import { partiesRouter } from './routes/parties.js';
import { itemsRouter } from './routes/items.js';
import { categoriesRouter } from './routes/categories.js';
import { stockRouter } from './routes/stock.js';
import { invoicesRouter } from './routes/invoices.js';
import { purchasesRouter } from './routes/purchases.js';
import { paymentsRouter } from './routes/payments.js';
import { creditNotesRouter } from './routes/credit-notes.js';
import { debitNotesRouter } from './routes/debit-notes.js';
import { reportsRouter } from './routes/reports.js';
import { gstReportsRouter } from './routes/gst-reports.js';
import { labelsRouter } from './routes/labels.js';
import { auditLogsRouter } from './routes/audit-logs.js';
import { backupsRouter } from './routes/backups.js';
import { uploadRoot } from './lib/local-storage.js';

// Round 9 — best-effort detection of "the drive an external company's DB
// lives on just disappeared mid-session" (docs/PENDING.md notes this isn't
// exhaustively hardware-tested — SQLite/Prisma's exact error shape for a
// vanished file can vary). Matches the common signatures: SQLITE_CANTOPEN
// (can't open — file/directory gone), ENOENT, and Prisma's own "unable to
// open the database file" wording.
function isDriveDisconnectedError(e: { message?: string; code?: string }): boolean {
  const text = `${e?.code ?? ''} ${e?.message ?? ''}`.toLowerCase();
  return (
    text.includes('sqlite_cantopen') ||
    text.includes('unable to open the database file') ||
    text.includes('enoent') ||
    text.includes('disk i/o error')
  );
}

// Route tree matches docs/SCOPE.md v1 modules only. Every jewellery-specific
// router from GoBilling (girvi, karigars, chit-tracker, bullion-tracker,
// old-gold, hand-loans, rent-tracker, salary-accounts, borrowings) was left
// behind on purpose — see docs/ARCHITECTURE.md "Not reused".

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '12mb' }));

  const frontendDist = process.env.FRONTEND_DIST
    ? path.resolve(process.env.FRONTEND_DIST)
    : path.resolve(BACKEND_ROOT, '..', 'dist');
  const frontendIndex = path.join(frontendDist, 'index.html');
  const hasFrontendBuild = existsSync(frontendIndex);

  if (hasFrontendBuild) {
    app.use(express.static(frontendDist));
  }
  app.use('/uploads', express.static(uploadRoot()));

  app.get('/', (_req, res) => {
    if (hasFrontendBuild) {
      res.sendFile(frontendIndex);
      return;
    }
    res.json({ name: 'RaSetu Retail ERP API', status: 'ready-for-foundation' });
  });

  app.use('/health', healthRouter);
  app.use('/meta', metaRouter);
  app.use('/system', systemRouter);
  app.use('/companies', companiesRouter);
  app.use('/auth', authSuperRouter);
  app.use('/companies/:companyId/auth', authRouter);
  app.use('/companies/:companyId/users', usersRouter);
  app.use('/companies/:companyId/parties', partiesRouter);
  app.use('/companies/:companyId/items', itemsRouter);
  app.use('/companies/:companyId/categories', categoriesRouter);
  app.use('/companies/:companyId/stock', stockRouter);
  app.use('/companies/:companyId/invoices', invoicesRouter);
  app.use('/companies/:companyId/purchases', purchasesRouter);
  app.use('/companies/:companyId/payments', paymentsRouter);
  app.use('/companies/:companyId/credit-notes', creditNotesRouter);
  app.use('/companies/:companyId/debit-notes', debitNotesRouter);
  app.use('/companies/:companyId/reports', reportsRouter);
  app.use('/companies/:companyId/gst-reports', gstReportsRouter);
  app.use('/companies/:companyId/labels', labelsRouter);
  app.use('/companies/:companyId/audit-logs', auditLogsRouter);
  app.use('/companies/:companyId/backups', backupsRouter);

  if (hasFrontendBuild) {
    app.get(/.*/, (_req, res) => {
      res.sendFile(frontendIndex);
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Uploaded file is too large.' });
    }

    if (error instanceof ZodError) {
      const flattened = error.flatten();
      const firstFieldError = Object.entries(flattened.fieldErrors).find(([, msgs]) => msgs?.length);
      const message = firstFieldError
        ? `${firstFieldError[0]}: ${firstFieldError[1]![0]}`
        : (flattened.formErrors[0] ?? 'Validation failed');
      return res.status(400).json({ error: message, details: flattened });
    }

    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.meta !== undefined ? { meta: error.meta } : {}),
      });
    }

    const e = error as { code?: string; message?: string; stack?: string; meta?: unknown };

    // Round 9 — an external company's drive vanished mid-request (unplugged
    // mid-session). Drop the now-broken cached connection/path so the NEXT
    // attempt starts clean (a stale cache would just keep failing the same
    // way even after the drive is reconnected and the process would need a
    // restart otherwise) and tell the frontend via a distinct code instead
    // of a generic 500 — see src/lib/api.ts's onDriveDisconnected handler.
    const companyId = (_req.params as { companyId?: string }).companyId;
    if (companyId && isKnownExternalCompany(companyId) && isDriveDisconnectedError(e)) {
      void resetCompanyClient(companyId);
      clearResolvedExternalDbPath(companyId);
      return res.status(503).json({
        error: "This company's data drive appears to be disconnected. Reconnect it and try again.",
        code: 'DRIVE_DISCONNECTED',
      });
    }

    if (e?.code === 'P2002') {
      const fields = (e?.meta as { target?: string[] })?.target ?? [];
      if (fields.includes('barcode')) {
        return res.status(409).json({ error: 'An item with this barcode already exists.' });
      }
      if (fields.includes('sku')) {
        return res.status(409).json({ error: 'This SKU already exists in this shop. Choose a different one.' });
      }
      if (fields.includes('username')) {
        return res.status(409).json({ error: 'This username already exists.' });
      }
      return res.status(409).json({ error: 'This record already exists. Please check for duplicates.' });
    }
    if (e?.code === 'P2025') {
      return res.status(404).json({ error: 'The record you are trying to update was not found.' });
    }

    console.error('\n========== UNHANDLED API ERROR ==========');
    console.error('code:    ', e?.code ?? 'n/a');
    console.error('message: ', e?.message ?? String(error));
    console.error(e?.stack ?? error);
    console.error('=========================================\n');

    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}
