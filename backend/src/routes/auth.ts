import { Router } from 'express';
import { z } from 'zod';

import { getCompanyClient } from '../db/company-registry.js';
import { asyncHandler } from '../lib/async-handler.js';
import { verifyPassword, hashPassword } from '../lib/password.js';
import { signAuthToken } from '../lib/jwt.js';
import { HttpError } from '../lib/http-error.js';
import { ensureCompanyStorageAvailable } from '../lib/company-storage.js';
import { readLicenseKey } from '../lib/license-snapshot.js';

export const authRouter = Router({ mergeParams: true });

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// role is a free-text column (docs/SCHEMA.md) — narrow it defensively rather
// than trusting the DB value at the type level.
function asRole(role: string): 'ADMIN' | 'STAFF' | 'SUPER_ADMIN' {
  return role === 'ADMIN' || role === 'SUPER_ADMIN' ? role : 'STAFF';
}

function parsePermissions(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    await ensureCompanyStorageAvailable(req.params.companyId);
    const prisma = getCompanyClient(req.params.companyId);

    const user = await prisma.user.findUnique({ where: { username: input.username } });
    if (!user || user.companyId !== req.params.companyId || !user.isActive) {
      throw new HttpError(401, 'Invalid username or password');
    }

    const valid = await verifyPassword(input.password, user.passwordHash);
    if (!valid) {
      throw new HttpError(401, 'Invalid username or password');
    }

    const token = await signAuthToken({
      sub: user.id,
      companyId: user.companyId,
      role: asRole(user.role),
      fullName: user.name,
      permissions: parsePermissions(user.permissions),
    });

    res.json({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role, permissions: parsePermissions(user.permissions), hasPin: Boolean(user.pinHash) } });
  })
);

// Round 3: device-bound PIN quick-login. Only ever reachable once the caller
// already knows the userId (from a prior full login remembered on this
// device) — never a global username→PIN lookup, so the 10,000-value PIN
// space is never a brute-force target against the whole user table.
const pinLoginSchema = z.object({
  userId: z.string().min(1),
  pin: z.string().length(4).regex(/^\d{4}$/),
});

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 5 * 60 * 1000;
// In-memory, resets on backend restart — an accepted tradeoff for a local
// desktop-app threat model (physical access to the shop PC), not an
// internet-facing one. See docs/plan Round 3 design decision #2.
const pinAttempts = new Map<string, { count: number; lockedUntil: number }>();

authRouter.post(
  '/pin-login',
  asyncHandler(async (req, res) => {
    const input = pinLoginSchema.parse(req.body);
    const key = `${req.params.companyId}:${input.userId}`;
    const state = pinAttempts.get(key);

    if (state && state.lockedUntil > Date.now()) {
      throw new HttpError(429, 'Too many wrong PIN attempts. Please log in with your password.');
    }

    await ensureCompanyStorageAvailable(req.params.companyId);
    const prisma = getCompanyClient(req.params.companyId);
    const user = await prisma.user.findUnique({ where: { id: input.userId } });
    if (!user || user.companyId !== req.params.companyId || !user.isActive || !user.pinHash) {
      throw new HttpError(401, 'PIN login is not available for this account.');
    }

    const valid = await verifyPassword(input.pin, user.pinHash);
    if (!valid) {
      const next = { count: (state?.count ?? 0) + 1, lockedUntil: 0 };
      if (next.count >= MAX_PIN_ATTEMPTS) next.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
      pinAttempts.set(key, next);
      throw new HttpError(401, 'Incorrect PIN.');
    }

    pinAttempts.delete(key);

    const token = await signAuthToken({
      sub: user.id,
      companyId: user.companyId,
      role: asRole(user.role),
      fullName: user.name,
      permissions: parsePermissions(user.permissions),
    });

    res.json({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role, permissions: parsePermissions(user.permissions), hasPin: true } });
  })
);

// Round 12 — self-service account recovery for a locked-out user (no valid
// session by definition, so this route is deliberately unauthenticated like
// /login and /pin-login above). The actual verification happens server-side
// against Supabase's redeem-password-reset Edge Function — the frontend
// never gets to decide "this code is valid" on its own; this backend does,
// then applies the change directly to the local company DB. See
// docs/SCHEMA.md's Round 12 entry and the RaSetu password-reset plan for the
// full design (request/approve/redeem flow, no admin dashboard in v1 —
// support approves requests by hand in Supabase's table editor).
const REDEEM_URL = 'https://doopelkfucwiogrylysj.supabase.co/functions/v1/redeem-password-reset';
const REDEEM_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRvb3BlbGtmdWN3aW9ncnlseXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5Njc4NjgsImV4cCI6MjEwMDU0Mzg2OH0.f5Df_uiZlzRbxOfa9ecI4ZIP59-5zfmwM7OKWlfNVDk';

const resetWithCodeSchema = z.object({
  username: z.string().min(1),
  code: z.string().min(1),
  newPassword: z.string().min(6),
  newPin: z.string().length(4).regex(/^\d{4}$/).optional(),
});

const REDEEM_FAILURE_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'Invalid reset code.',
  ALREADY_REDEEMED: 'This reset code has already been used.',
  NOT_APPROVED: 'This request has not been approved yet — contact support.',
  EXPIRED: 'This reset code has expired — submit a new request.',
  INVALID_REQUEST: 'Invalid reset code.',
};

authRouter.post(
  '/reset-with-code',
  asyncHandler(async (req, res) => {
    const input = resetWithCodeSchema.parse(req.body);

    const licenseKey = readLicenseKey();
    if (!licenseKey) {
      throw new HttpError(400, 'This device has no active license — password reset is not available.');
    }

    let redeemPayload: { ok: boolean; reason?: string };
    try {
      const redeemRes = await fetch(REDEEM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${REDEEM_ANON_KEY}` },
        body: JSON.stringify({ licenseKey, username: input.username, code: input.code }),
      });
      redeemPayload = (await redeemRes.json()) as { ok: boolean; reason?: string };
    } catch {
      throw new HttpError(503, 'Could not reach RaSetu servers to verify the code. Check your internet connection.');
    }

    if (!redeemPayload.ok) {
      throw new HttpError(400, REDEEM_FAILURE_MESSAGES[redeemPayload.reason ?? ''] ?? 'Invalid or expired reset code.');
    }

    await ensureCompanyStorageAvailable(req.params.companyId);
    const prisma = getCompanyClient(req.params.companyId);
    const user = await prisma.user.findUnique({ where: { username: input.username } });
    if (!user || user.companyId !== req.params.companyId || !user.isActive) {
      throw new HttpError(404, 'Could not find that user in this shop.');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(input.newPassword),
        pinHash: input.newPin ? await hashPassword(input.newPin) : user.pinHash,
      },
    });

    res.json({ success: true });
  })
);
