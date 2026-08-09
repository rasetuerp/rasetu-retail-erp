import { serviceClient } from '../_shared/db.ts';
import { signValidationToken } from '../_shared/jwt.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { checkLicenseUsable, licensePayload, type LicenseRow } from '../_shared/license.ts';

// Re-validates an already-activated license (periodic online check-in) — never
// binds a new machine itself, that only happens in license-activate.
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

    await db.from('licenses').update({ last_seen_at: new Date().toISOString() }).eq('id', license.id);

    const { token, validUntil } = await signValidationToken({
      license_id: license.id,
      key: license.license_key,
      machine_id: machineId,
      status: license.status,
      type: license.type,
      amc_expires_on: license.amc_expires_on,
    });

    return json({
      data: { ok: true, license: licensePayload(license), validationToken: token, validUntil: validUntil.toISOString() },
      valid: true,
      features: [],
    });
  } catch (err) {
    console.error(err);
    return json({ error: 'Internal error' }, 500);
  }
});
