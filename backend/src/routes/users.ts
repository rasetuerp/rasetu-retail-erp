import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb, requireRole } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { recordMutation } from '../lib/mutation-log.js';
import { HttpError } from '../lib/http-error.js';

export const usersRouter = Router({ mergeParams: true });

// App.tsx's Tab union — kept as free-text strings here (User.permissions is a
// JSON column, not a relation) rather than importing frontend types into the
// backend. 'users' (Team & Access) is deliberately excluded — never a
// STAFF-assignable permission, only ADMIN/SUPER_ADMIN manage accounts.
const TAB_VALUES = ['dashboard', 'billing', 'items', 'purchase', 'parties', 'reports', 'labels', 'settings'] as const;

const createUserSchema = z.object({
  name: z.string().min(1),
  username: z.string().min(3),
  password: z.string().min(6),
  role: z.enum(['ADMIN', 'STAFF']).default('STAFF'),
  permissions: z.array(z.enum(TAB_VALUES)).nullable().optional(),
});

function parsePermissions(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

usersRouter.use(requireAuth);

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    // Includes deactivated users (unlike other v1 list endpoints) — Round 3's
    // UsersPage needs to show + reactivate them, not just hide them forever.
    const users = await prisma.user.findMany({
      where: { companyId: req.params.companyId },
      select: { id: true, name: true, username: true, role: true, permissions: true, pinHash: true, isActive: true },
    });
    res.json({
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        role: u.role,
        permissions: parsePermissions(u.permissions),
        hasPin: Boolean(u.pinHash),
        isActive: u.isActive,
      })),
    });
  })
);

usersRouter.post(
  '/',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = createUserSchema.parse(req.body);
    const passwordHash = await hashPassword(input.password);

    const user = await prisma.user.create({
      data: {
        companyId: req.params.companyId,
        name: input.name,
        username: input.username,
        passwordHash,
        role: input.role,
        permissions: input.permissions ? JSON.stringify(input.permissions) : null,
      },
    });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'User',
      entityId: user.id,
      action: 'CREATE',
      newValue: { id: user.id, name: user.name, username: user.username, role: user.role },
      tableName: 'user',
      syncAction: 'CREATE',
      payload: { id: user.id, name: user.name, username: user.username, role: user.role },
    });

    res.status(201).json({ user: { id: user.id, name: user.name, username: user.username, role: user.role, permissions: input.permissions ?? null, hasPin: false } });
  })
);

// Self-service — any authenticated user manages their own PIN/password, no
// ADMIN gate, but both require re-entering the current password (RULES.md
// #7-adjacent: a sensitive change needs fresh proof of identity, not just an
// existing session token).
const setPinSchema = z.object({
  currentPassword: z.string().min(1),
  pin: z.string().length(4).regex(/^\d{4}$/),
});

usersRouter.post(
  '/me/pin',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = setPinSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user || user.companyId !== req.params.companyId) throw new HttpError(404, 'User not found');

    const valid = await verifyPassword(input.currentPassword, user.passwordHash);
    if (!valid) throw new HttpError(401, 'Current password is incorrect');

    const pinHash = await hashPassword(input.pin);
    await prisma.user.update({ where: { id: user.id }, data: { pinHash } });

    res.json({ ok: true });
  })
);

const changeOwnPasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

usersRouter.patch(
  '/me/password',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = changeOwnPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user || user.companyId !== req.params.companyId) throw new HttpError(404, 'User not found');

    const valid = await verifyPassword(input.currentPassword, user.passwordHash);
    if (!valid) throw new HttpError(401, 'Current password is incorrect');

    const passwordHash = await hashPassword(input.newPassword);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    res.json({ ok: true });
  })
);

// ADMIN/SUPER_ADMIN managing a subordinate user — role/permissions/isActive,
// and the two admin-mediated reset actions (docs/plan Round 3 design
// decision #3: no email infra, so resets are always in-person/admin-mediated).
const updateUserSchema = z.object({
  role: z.enum(['ADMIN', 'STAFF']).optional(),
  permissions: z.array(z.enum(TAB_VALUES)).nullable().optional(),
  isActive: z.boolean().optional(),
  resetPassword: z.string().min(6).optional(),
  clearPin: z.boolean().optional(),
});

usersRouter.patch(
  '/:userId',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = updateUserSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!existing || existing.companyId !== req.params.companyId) throw new HttpError(404, 'User not found');
    if (existing.role === 'SUPER_ADMIN') throw new HttpError(403, 'Cannot modify a Super Admin account here');

    const passwordHash = input.resetPassword ? await hashPassword(input.resetPassword) : undefined;

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.permissions !== undefined ? { permissions: input.permissions ? JSON.stringify(input.permissions) : null } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(passwordHash !== undefined ? { passwordHash } : {}),
        ...(input.clearPin ? { pinHash: null } : {}),
      },
    });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'User',
      entityId: user.id,
      action: 'UPDATE',
      oldValue: { role: existing.role, isActive: existing.isActive },
      newValue: { role: user.role, isActive: user.isActive },
      tableName: 'user',
      syncAction: 'UPDATE',
      payload: { id: user.id, role: user.role, isActive: user.isActive },
    });

    res.json({
      user: { id: user.id, name: user.name, username: user.username, role: user.role, isActive: user.isActive, permissions: parsePermissions(user.permissions), hasPin: Boolean(user.pinHash) },
    });
  })
);
