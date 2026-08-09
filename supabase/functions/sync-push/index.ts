import { serviceClient } from '../_shared/db.ts';
import { corsHeaders, json } from '../_shared/cors.ts';

// Round 4 — one-way sync push, license-gated (never a service_role key ships
// in the desktop app; the Edge Function is the only thing holding it).
// v1 scope is push-only, deliberately minimal — see docs/ARCHITECTURE.md.
const MAX_ROWS_PER_REQUEST = 200;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
    const companyId = typeof body.companyId === 'string' ? body.companyId.trim() : '';
    const rows = Array.isArray(body.rows) ? body.rows : [];

    if (!licenseKey || !companyId || rows.length === 0) {
      return json({ error: 'licenseKey, companyId, and at least one row are required' }, 400);
    }

    const db = serviceClient();
    const { data: license, error } = await db
      .from('licenses')
      .select('id, status')
      .eq('license_key', licenseKey)
      .maybeSingle();
    if (error) throw error;
    if (!license) return json({ error: 'License key not found' }, 404);
    if (license.status === 'BLOCKED') return json({ error: 'License is blocked' }, 403);

    const insertRows = rows.slice(0, MAX_ROWS_PER_REQUEST).map((r: Record<string, unknown>) => ({
      license_id: license.id,
      company_id: companyId,
      table_name: String(r.tableName ?? ''),
      row_id: String(r.rowId ?? ''),
      action: String(r.action ?? ''),
      payload: r.payload ?? null,
      source_created_at: r.createdAt ?? null,
    }));

    const { error: insertError } = await db.from('synced_rows').insert(insertRows);
    if (insertError) throw insertError;

    return json({ ok: true, inserted: insertRows.length });
  } catch (err) {
    console.error(err);
    return json({ error: 'Internal error' }, 500);
  }
});
