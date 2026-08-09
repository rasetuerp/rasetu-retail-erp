import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { verifyAuthToken } from './jwt.js';
import { getCompanyClient } from '../db/company-registry.js';
import { HttpError } from './http-error.js';
import type { PrismaClient as CompanyPrismaClient } from '../generated/company-client/index.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        companyId: string | null;
        role: 'ADMIN' | 'STAFF' | 'SUPER_ADMIN';
        fullName: string;
        permissions?: string[] | null;
      };
      // Round 4 — the requesting user's own company database, attached by
      // requireAuth once the companyId match above has already passed. Every
      // company-scoped route reads this instead of a shared global client.
      companyDb?: CompanyPrismaClient;
    }
  }
}

/** Narrows req.companyDb, throwing if a route somehow reaches a handler without requireAuth having run. */
export function requireCompanyDb(req: Request): CompanyPrismaClient {
  if (!req.companyDb) {
    throw new HttpError(500, 'Company database not resolved for this request');
  }
  return req.companyDb;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authorization = req.header('authorization');

  if (!authorization?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const token = authorization.slice('Bearer '.length).trim();

  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  let payload;
  try {
    payload = await verifyAuthToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = {
    id: payload.sub,
    companyId: payload.companyId,
    role: payload.role,
    fullName: payload.fullName,
    permissions: payload.permissions ?? null,
  };

  // A Super Admin's unscoped identity token (companyId: null) is rejected
  // by every :companyId-scoped route here — it only works on the top-level
  // /auth/super-admin/enter/:companyId route, which mints a real scoped
  // token. Everything below this line behaves exactly as before.
  if (typeof req.params.companyId === 'string' && req.params.companyId !== req.user.companyId) {
    return res.status(403).json({ error: 'Cross-company access denied' });
  }

  // Round 4 — every requireAuth-protected route is mounted under
  // /companies/:companyId, so companyId is always a real string here (the
  // check above already rejected any mismatch or unscoped token).
  if (req.user.companyId) {
    try {
      req.companyDb = getCompanyClient(req.user.companyId);
    } catch (err) {
      return next(err);
    }
  }

  return next();
}

export function requireRole(...allowed: Array<'ADMIN' | 'STAFF' | 'SUPER_ADMIN'>): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Missing token' });
    }

    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
  };
}
