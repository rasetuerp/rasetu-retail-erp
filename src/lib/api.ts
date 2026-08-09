// Shared API client — infrastructure, not a page, same exemption as exportUtils.ts
// (docs/RULES.md #2's no-cross-page-imports rule targets pages).

const BASE_URL = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ?? 'http://localhost:4100';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
};

// A JWT expires after JWT_TTL_HOURS (12h) — shop staff realistically leave the
// app open across a full shift, so this fires routinely, not as an edge case.
// apiRequest is a plain function (not a hook) so it can't call useSession()
// directly; App.tsx registers a handler once on mount that clears the session,
// so an expired token drops the user back to the login gate instead of
// leaving every page showing a raw "Invalid or expired token" banner over
// stale/zeroed data.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

// Round 9 — an externally-stored company's drive can be unplugged mid-session
// (docs/PENDING.md notes this is best-effort, not exhaustively hardware-tested).
// The backend detects the failed read/write and responds with this distinct
// code (backend/src/app.ts) instead of a generic 500, so the app can show a
// clear "reconnect the drive" message instead of a raw error.
let onDriveDisconnected: ((message: string) => void) | null = null;
export function setDriveDisconnectedHandler(handler: ((message: string) => void) | null) {
  onDriveDisconnected = handler;
}

export async function apiRequest<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await res.json() : undefined;

  if (!res.ok) {
    const errPayload = payload as { error?: string; code?: string } | undefined;
    const message = errPayload?.error ?? `Request failed (${res.status})`;
    // Only a request that was actually sent with a token counts as a session
    // expiry — an unauthenticated 401 (e.g. wrong username/password on the
    // login screen itself) must not trigger a logout loop.
    if (res.status === 401 && options.token) {
      onUnauthorized?.();
    }
    if (errPayload?.code === 'DRIVE_DISCONNECTED') {
      onDriveDisconnected?.(message);
    }
    throw new ApiError(res.status, message, errPayload?.code);
  }

  return payload as T;
}
