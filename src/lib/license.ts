// Shared license client — infrastructure, not a page (same exemption as
// api.ts/session.ts). Round 4: calls RaSetu's Supabase Edge Functions
// directly (needs internet, same as GoBilling's proven pattern) rather than
// proxying through the local Express backend. One license per installed
// copy (machine), not per company — see docs/plan Round 4 design decision #2.
//
// window.rasetu only exists inside Electron (electron/preload.ts) — the
// Chrome preview pane running the bare Vite dev server never has it, so
// every call here is guarded and licensing is effectively a no-op there
// (same "desktop-only feature" precedent as LabelsPage.tsx's printer bridge).
// Its type is declared once, globally, in src/lib/rasetu-bridge.d.ts.

const LICENSE_FUNCTIONS_URL = 'https://doopelkfucwiogrylysj.supabase.co/functions/v1';
const LICENSE_ANON_KEY = 'sb_publishable_Fp4R_QUz_d_Hzs0pBA2eKw_986nPQzz';

export type LicenseInfo = {
  key: string;
  type: 'TRIAL' | 'LIFETIME';
  status: 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'BLOCKED';
  customerName: string | null;
  customerBusinessName: string | null;
  customerGstin: string | null;
  amcExpiresOn: string | null;
  trialExpiresOn: string | null;
};

export type StartupLicenseStatus =
  | { hasValidLicense: false }
  | {
      hasValidLicense: true;
      license: { status: string; type: string; validUntil: string; amcExpiresOn: string | null };
      snapshot: { licenseKey: string; lastValidAt: string };
    };

// Round 9 — user-facing offline-grace messaging, mirroring GoBilling's own
// offlineStatus() three-state logic (electron/main.ts in the GoBilling repo):
// within 7 days offline is benign ('grace'); beyond 7 days but before the
// cached token's own validUntil is a hard warning naming the reconnect-by
// date ('warning'); once past validUntil the offline-verified startup check
// itself already reports hasValidLicense:false (see electron/main.ts's
// rt:license-startup-status), so 'expired' here is only reachable if this is
// called with a stale validUntil the caller hasn't re-checked against.
const OFFLINE_GRACE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type OfflineGraceState = 'ok' | 'grace' | 'warning' | 'expired';

export type OfflineGraceInfo = {
  state: OfflineGraceState;
  daysOffline: number;
  validUntil: Date;
  message: string | null;
};

export function getOfflineGraceInfo(lastValidAt: string, validUntil: string): OfflineGraceInfo {
  const validUntilDate = new Date(validUntil);
  const now = new Date();
  const daysOffline = Math.max(0, Math.floor((now.getTime() - new Date(lastValidAt).getTime()) / MS_PER_DAY));

  if (now >= validUntilDate) {
    return {
      state: 'expired',
      daysOffline,
      validUntil: validUntilDate,
      message: 'This device could not reconnect in time and its license has expired. Connect to the internet to restore access.',
    };
  }
  if (daysOffline > OFFLINE_GRACE_DAYS) {
    return {
      state: 'warning',
      daysOffline,
      validUntil: validUntilDate,
      message: `This device has been offline for ${daysOffline} days. Reconnect to the internet by ${validUntilDate.toLocaleDateString('en-IN')} to keep RaSetu working.`,
    };
  }
  if (daysOffline > 0) {
    return { state: 'grace', daysOffline, validUntil: validUntilDate, message: null };
  }
  return { state: 'ok', daysOffline, validUntil: validUntilDate, message: null };
}

export class LicenseError extends Error {
  reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.reason = reason;
  }
}

async function callLicenseFunction(
  path: 'license-activate' | 'license-validate',
  body: unknown
): Promise<{ license: LicenseInfo; validationToken: string; validUntil: string }> {
  const res = await fetch(`${LICENSE_FUNCTIONS_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LICENSE_ANON_KEY}` },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    data?: { ok?: boolean; license?: LicenseInfo; validationToken?: string; validUntil?: string };
    valid?: boolean;
    reason?: string;
    message?: string;
    error?: string;
  };

  if (!res.ok || !(payload.data?.ok ?? payload.valid ?? false) || !payload.data) {
    throw new LicenseError(payload.message ?? payload.error ?? 'License check failed', payload.reason);
  }

  return payload.data as { license: LicenseInfo; validationToken: string; validUntil: string };
}

export async function activateLicense(key: string): Promise<LicenseInfo> {
  if (!window.rasetu) throw new LicenseError('Activation is only available in the desktop app.');

  const machineId = await window.rasetu.getMachineId();
  const appInfo = await window.rasetu.getAppInfo().catch(() => null);
  const { license, validationToken } = await callLicenseFunction('license-activate', {
    key,
    machineId,
    machineDetails: { appVersion: appInfo?.version },
  });

  await window.rasetu.saveLicenseSnapshot({
    licenseKey: key,
    machineId,
    validationToken,
    lastValidAt: new Date().toISOString(),
  });

  return license;
}

/** Best-effort online re-check — failures (offline, blocked) are swallowed; the offline-verified startup status still governs access. */
export async function revalidateLicenseInBackground(): Promise<void> {
  if (!window.rasetu) return;
  const status = await window.rasetu.getStartupLicenseStatus();
  if (!status.hasValidLicense) return;

  try {
    const machineId = await window.rasetu.getMachineId();
    const { validationToken } = await callLicenseFunction('license-validate', { key: status.snapshot.licenseKey, machineId });
    await window.rasetu.saveLicenseSnapshot({
      licenseKey: status.snapshot.licenseKey,
      machineId,
      validationToken,
      lastValidAt: new Date().toISOString(),
    });
  } catch {
    // offline, or the Edge Function rejected it (e.g. blocked) — leave the
    // last-known-good snapshot in place; it'll simply expire on its own TTL.
  }
}

export async function getStartupLicenseStatus(): Promise<StartupLicenseStatus> {
  if (!window.rasetu) return { hasValidLicense: false };
  return window.rasetu.getStartupLicenseStatus();
}
