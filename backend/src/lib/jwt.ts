import { SignJWT, jwtVerify } from 'jose';

import { env } from '../config/env.js';

export type AuthPayload = {
  sub: string;
  // null only for a Super Admin's unscoped identity token (post /auth/super-login,
  // pre /auth/super-admin/enter/:companyId) — see auth-super.ts. Every other
  // token, including a Super Admin's post-entry token, has a real companyId.
  companyId: string | null;
  role: 'ADMIN' | 'STAFF' | 'SUPER_ADMIN';
  fullName: string;
  // Nullable JSON-array-of-Tab-strings; null = full access. Baked in at login
  // time like `role` — a permissions change takes effect on next login.
  permissions?: string[] | null;
};

const secret = new TextEncoder().encode(env.JWT_SECRET);

function isAuthPayload(payload: Record<string, unknown>): payload is AuthPayload {
  return (
    typeof payload.sub === 'string' &&
    (payload.companyId === null || typeof payload.companyId === 'string') &&
    (payload.role === 'ADMIN' || payload.role === 'STAFF' || payload.role === 'SUPER_ADMIN') &&
    typeof payload.fullName === 'string' &&
    (payload.permissions === undefined || payload.permissions === null || Array.isArray(payload.permissions))
  );
}

export async function signAuthToken(payload: AuthPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${env.JWT_TTL_HOURS}h`)
    .sign(secret);
}

export async function verifyAuthToken(token: string): Promise<AuthPayload> {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ['HS256'],
  });

  if (!isAuthPayload(payload)) {
    throw new Error('Invalid auth token payload');
  }

  return payload;
}
