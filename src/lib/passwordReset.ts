// Shared password-reset client — infrastructure, same exemption as
// license.ts/api.ts/session.ts. Round 12 — self-service account recovery
// (docs/SCHEMA.md's Round 12 entry): a locked-out shop submits a request
// here (needs internet, same as license.ts's own direct-to-Supabase calls),
// support approves it by hand in Supabase later, and the shop redeems the
// resulting code through the *local* backend (POST .../auth/reset-with-code,
// backend/src/routes/auth.ts) — that step is deliberately NOT here, since
// the backend re-verifies the code itself rather than trusting the frontend.

const PASSWORD_RESET_FUNCTIONS_URL = 'https://doopelkfucwiogrylysj.supabase.co/functions/v1';
const PASSWORD_RESET_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRvb3BlbGtmdWN3aW9ncnlseXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5Njc4NjgsImV4cCI6MjEwMDU0Mzg2OH0.f5Df_uiZlzRbxOfa9ecI4ZIP59-5zfmwM7OKWlfNVDk';

export class PasswordResetError extends Error {}

export async function requestPasswordReset(input: {
  licenseKey: string;
  companyName: string;
  username: string;
  contactNote?: string;
}): Promise<{ requestId: string }> {
  let res: Response;
  try {
    res = await fetch(`${PASSWORD_RESET_FUNCTIONS_URL}/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PASSWORD_RESET_ANON_KEY}` },
      body: JSON.stringify(input),
    });
  } catch {
    throw new PasswordResetError('Could not reach RaSetu servers - check your internet connection.');
  }

  const payload = (await res.json().catch(() => ({}))) as { requestId?: string; error?: string };
  if (!res.ok || typeof payload.requestId !== 'string') {
    throw new PasswordResetError(payload.error ?? 'Failed to submit request.');
  }
  return { requestId: payload.requestId };
}
