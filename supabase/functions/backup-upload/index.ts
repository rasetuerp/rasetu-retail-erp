import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from 'npm:@aws-sdk/client-s3@3';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3';

import { serviceClient } from '../_shared/db.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { checkLicenseUsable, type LicenseRow } from '../_shared/license.ts';

// Round 7 — issues a short-lived presigned PUT URL for Cloudflare R2
// (S3-compatible API). R2 credentials are Edge Function secrets, never seen
// by the desktop app. Mirrors license-validate's "is this key+machine
// actually allowed to do anything" gate before issuing anything — an
// unlicensed or blocked machine gets nothing, same as GoBilling's own
// backup-upload function.
const KEEP_LAST = 7;
const MAX_BYTES_PER_MACHINE = 200 * 1024 * 1024; // 200MB, matches GoBilling's own cap — largest single backup file
// Round 9 — RULES.md #13: total R2 usage per license must always be capped
// server-side before issuing an upload URL, on top of the per-file cap and
// per-company retention above. Round 9 allows one license to own unlimited
// companies, so per-company retention alone no longer bounds a license's
// total footprint (many companies x KEEP_LAST x MAX_BYTES_PER_MACHINE could
// otherwise multiply without limit). 500MB (revised down from an initial
// 2GB same-day, per RULES.md #13's own change log) — a real shop's SQLite
// backups run a few MB to a few tens of MB each, nowhere near the 200MB
// per-file cap, so even 5+ companies stays comfortably under 500MB in
// legitimate use. This bounds worst-case abuse from any single license
// (leaked key, bug, etc.) to a known, small cost — local backups on the
// shop's own PC are unaffected either way, this cap only limits the cloud
// copy.
const MAX_TOTAL_BYTES_PER_LICENSE = 500 * 1024 * 1024;

function r2Client() {
  const accountId = Deno.env.get('R2_ACCOUNT_ID')!;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,
      secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const machineId = typeof body.machineId === 'string' ? body.machineId.trim() : '';
    const companyId = typeof body.companyId === 'string' ? body.companyId.trim() : '';
    const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
    const sizeBytes = typeof body.sizeBytes === 'number' ? body.sizeBytes : 0;
    if (key.length < 8 || machineId.length < 8 || !companyId || !fileName) {
      return json({ error: 'key, machineId, companyId, and fileName are required' }, 400);
    }
    if (sizeBytes > MAX_BYTES_PER_MACHINE) {
      return json({ error: `Backup is larger than the ${MAX_BYTES_PER_MACHINE / 1024 / 1024}MB per-machine cap` }, 413);
    }

    const db = serviceClient();
    const { data: license, error } = await db.from('licenses').select('*').eq('license_key', key).maybeSingle<LicenseRow>();
    if (error) throw error;
    if (!license) return json({ error: 'License key not found' }, 404);

    const rejection = checkLicenseUsable(license, machineId);
    if (rejection) return json({ error: rejection.message, reason: rejection.reason }, rejection.httpStatus);

    const bucket = Deno.env.get('R2_BUCKET')!;
    const s3 = r2Client();
    const objectKey = `${machineId}/${companyId}/${fileName}`;

    // Retention: keep the newest KEEP_LAST for this machine+company; delete
    // the rest before issuing the new upload URL (so the count is right the
    // moment the client's PUT lands, without a second round trip).
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${machineId}/${companyId}/` }));
    const existing = (listed.Contents ?? []).filter((o) => o.Key).sort((a, b) => (a.Key! < b.Key! ? 1 : -1)); // newest key sorts first (ISO timestamp in the name)
    const toDelete = existing.slice(KEEP_LAST - 1); // -1: this new upload will be the newest, keeping KEEP_LAST total
    for (const obj of toDelete) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key! })).catch(() => {
        // best-effort — a stuck delete must never block issuing the upload URL
      });
    }

    // Total-per-license cap (RULES.md #13) — checked AFTER the prune above so
    // space just freed by deleting old backups counts in the customer's
    // favor. No delimiter on the prefix: S3-style listing matches everything
    // under machineId/ recursively, so this sums usage across every company
    // this machine has backed up, not just the one in this request.
    const allForMachine = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${machineId}/` }));
    const currentTotalBytes = (allForMachine.Contents ?? []).reduce((sum, o) => sum + (o.Size ?? 0), 0);
    if (currentTotalBytes + sizeBytes > MAX_TOTAL_BYTES_PER_LICENSE) {
      return json(
        {
          error: `This license has reached its ${MAX_TOTAL_BYTES_PER_LICENSE / 1024 / 1024}MB total cloud backup limit across all companies. Older backups are pruned automatically, but this upload would still exceed the cap.`,
        },
        413
      );
    }

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: 'application/gzip' }),
      { expiresIn: 300 }
    );

    return json({ data: { ok: true, uploadUrl, fileName: objectKey } });
  } catch (err) {
    console.error(err);
    return json({ error: 'Internal error' }, 500);
  }
});
