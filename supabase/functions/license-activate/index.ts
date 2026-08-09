import { serviceClient } from '../_shared/db.ts';
import { signValidationToken } from '../_shared/jwt.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { checkLicenseUsable, licensePayload, type LicenseRow } from '../_shared/license.ts';

const DEFAULT_TRIAL_DAYS = 15;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const machineId = typeof body.machineId === 'string' ? body.machineId.trim() : '';
    if (key.length < 8 || machineId.length < 8) {
      return json({ error: 'A license key and machine ID are required' }, 400);
    }

    const db = serviceClient();
    const { data: license, error } = await db
      .from('licenses')
      .select('*')
      .eq('license_key', key)
      .maybeSingle<LicenseRow>();
    if (error) throw error;
    if (!license) return json({ error: 'License key not found' }, 404);

    const rejection = checkLicenseUsable(license, machineId);
    if (rejection) return json({ valid: false, reason: rejection.reason, message: rejection.message }, rejection.httpStatus);

    const now = new Date();
    const updates: Record<string, unknown> = {
      machine_id: machineId,
      last_seen_at: now.toISOString(),
      software_version:
        typeof body.machineDetails?.appVersion === 'string' ? body.machineDetails.appVersion : undefined,
    };

    // First activation: bind the machine, stamp activated_at, and — for a
    // fresh TRIAL key with no expiry set yet — start the trial clock now
    // (not at key-creation time, so a key sitting unsold doesn't burn down).
    if (!license.activated_at) {
      updates.activated_at = now.toISOString();
      updates.status = license.type === 'TRIAL' ? 'TRIAL' : 'ACTIVE';
      if (license.type === 'TRIAL' && !license.trial_expires_on) {
        updates.trial_expires_on = new Date(now.getTime() + DEFAULT_TRIAL_DAYS * 86_400_000).toISOString();
      }
    }

    const { data: updated, error: updateError } = await db
      .from('licenses')
      .update(updates)
      .eq('id', license.id)
      .select()
      .single<LicenseRow>();
    if (updateError) throw updateError;

    const { token, validUntil } = await signValidationToken({
      license_id: updated.id,
      key: updated.license_key,
      machine_id: machineId,
      status: updated.status,
      type: updated.type,
      amc_expires_on: updated.amc_expires_on,
    });

    return json({
      data: { ok: true, license: licensePayload(updated), validationToken: token, validUntil: validUntil.toISOString() },
      valid: true,
    });
  } catch (err) {
    console.error(err);
    return json({ error: 'Internal error' }, 500);
  }
});
