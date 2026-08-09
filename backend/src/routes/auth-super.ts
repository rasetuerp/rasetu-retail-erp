import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db/catalog-client.js';
import { getReadyCompanyClient, resetCompanyClient } from '../db/company-registry.js';
import { asyncHandler } from '../lib/async-handler.js';
import { supabase } from '../lib/supabase-client.js';
import { signAuthToken, verifyAuthToken } from '../lib/jwt.js';
import { HttpError } from '../lib/http-error.js';
import { resolveExternalCompanyPath } from '../lib/company-storage.js';

// Top-level (not /companies/:companyId-scoped) — a Super Admin isn't bound to
// one company. Two-step flow so requireAuth's per-request companyId equality
// check (auth-middleware.ts) never needs a SUPER_ADMIN special case:
//   1. /super-login       → unscoped identity token (companyId: null)
//   2. /super-admin/enter/:companyId → verifies the identity token + role by
//      hand (not requireAuth — its companyId check would reject this on
//      purpose for every other route), logs the access, mints a normal
//      scoped token that behaves like any ADMIN/STAFF token from then on.
//
// Round 4: the credential check is Supabase Auth, not a local Prisma User —
// the vendor account is created/rotated in Supabase Studio directly (docs/plan
// Round 4 design decision #1). There is no local mirror of this identity;
// `payload.sub` is the Supabase Auth user's UUID and the verified, signed JWT
// itself is the source of truth for every request downstream — same trust
// model every other ADMIN/STAFF token already uses via requireAuth.

export const authSuperRouter = Router();

const superLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authSuperRouter.post(
  '/super-login',
  asyncHandler(async (req, res) => {
    const input = superLoginSchema.parse(req.body);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    });
    if (error || !data.user) {
      throw new HttpError(401, 'Invalid email or password');
    }

    const fullName = (data.user.user_metadata?.full_name as string | undefined) ?? data.user.email ?? 'RaSetu Support';

    const token = await signAuthToken({
      sub: data.user.id,
      companyId: null,
      role: 'SUPER_ADMIN',
      fullName,
    });

    const companies = await prisma.company.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, gstin: true },
    });

    res.json({ token, user: { id: data.user.id, name: fullName, role: 'SUPER_ADMIN' as const }, companies });
  })
);

authSuperRouter.post(
  '/super-admin/enter/:companyId',
  asyncHandler(async (req, res) => {
    const authorization = req.header('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new HttpError(401, 'Missing token');
    }

    let payload;
    try {
      payload = await verifyAuthToken(authorization.slice('Bearer '.length).trim());
    } catch {
      throw new HttpError(401, 'Invalid or expired token');
    }

    if (payload.role !== 'SUPER_ADMIN') {
      throw new HttpError(403, 'Forbidden');
    }

    const company = await prisma.company.findUnique({ where: { id: req.params.companyId } });
    if (!company) {
      throw new HttpError(404, 'Company not found');
    }
    const availability = await resolveExternalCompanyPath(company);
    if (!availability.available) {
      throw new HttpError(404, "This company's data drive is not connected. Plug it in and try again.");
    }
    // See company-storage.ts's ensureCompanyStorageAvailable for why: a
    // cached client from before a disconnect/reconnect cycle can come back
    // permanently broken even once the drive is present again.
    if (company.storageType === 'external') {
      await resetCompanyClient(company.id);
    }

    // Not a data mutation — recordMutation's AuditLog+SyncQueue pairing is for
    // entity writes (RULES.md #7); this is an access event, so it gets its
    // own AuditLog row with a distinct, greppable action. AuditLog lives
    // inside the entered company's own database (Round 4), not the catalog.
    const companyDb = await getReadyCompanyClient(company.id);
    await companyDb.auditLog.create({
      data: {
        userId: payload.sub,
        entity: 'Company',
        entityId: company.id,
        action: 'SUPER_ADMIN_ACCESS',
        newValue: JSON.stringify({ companyName: company.name, byUser: payload.fullName, at: new Date().toISOString() }),
      },
    });

    const token = await signAuthToken({
      sub: payload.sub,
      companyId: company.id,
      role: 'SUPER_ADMIN',
      fullName: payload.fullName,
    });

    // No local User row backs a vendor session — username has no real meaning
    // here, but SessionUser's shape requires it and nothing in the UI reads it
    // for a SUPER_ADMIN session (only the local-login remember-me path does).
    res.json({ token, user: { id: payload.sub, name: payload.fullName, username: payload.fullName, role: 'SUPER_ADMIN' as const }, company: { id: company.id, name: company.name } });
  })
);
