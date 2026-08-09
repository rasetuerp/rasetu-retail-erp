import crypto from 'node:crypto';

// Public half of RaSetu's OWN license signing keypair (Ed25519).
// DO NOT reuse GoBilling's key here — it belongs to a different Supabase
// project and license issuer. Generate a fresh pair for RaSetu:
//   node -e "const {publicKey,privateKey}=require('crypto').generateKeyPairSync('ed25519');console.log(publicKey.export({type:'spki',format:'pem'}));console.log(privateKey.export({type:'pkcs8',format:'pem'}))"
// Keep the private key only in Supabase (LICENSE_SIGNING_PRIVATE_KEY env var);
// the public key below is safe to ship in the app — it can verify, not forge.
const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAOT0mesybMQlfkBMQAWW2rvs0+Tt2wZZpTaJ3iqUYxJ0=
-----END PUBLIC KEY-----`;

export type VerifiedLicenseToken = {
  licenseId?: string;
  key?: string;
  machineId?: string;
  status?: string;
  type?: string;
  amcExpiresOn?: string | null;
  issuedAt: Date;
  validUntil: Date;
};

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verifies an EdDSA-signed validation token offline.
 * Returns the trusted claims, or null when the token is missing, malformed,
 * signed with an unexpected algorithm (legacy HS256), or has a bad signature.
 */
export function verifyValidationToken(token: string | undefined | null): VerifiedLicenseToken | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8')) as { alg?: string };
    if (header.alg !== 'EdDSA') return null;

    const publicKey = crypto.createPublicKey(LICENSE_PUBLIC_KEY_PEM);
    const signedData = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    const signature = base64UrlDecode(parts[2]);
    if (!crypto.verify(null, signedData, publicKey, signature)) return null;

    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as {
      license_id?: string;
      key?: string;
      machine_id?: string;
      status?: string;
      type?: string;
      amc_expires_on?: string | null;
      valid_until?: string;
      iat?: number;
      exp?: number;
    };

    const issuedAt = payload.iat ? new Date(payload.iat * 1000) : null;
    const validUntil = payload.valid_until
      ? new Date(payload.valid_until)
      : payload.exp
        ? new Date(payload.exp * 1000)
        : null;
    if (!issuedAt || !validUntil || Number.isNaN(validUntil.getTime())) return null;

    return {
      licenseId: payload.license_id,
      key: payload.key,
      machineId: payload.machine_id,
      status: payload.status,
      type: payload.type,
      amcExpiresOn: payload.amc_expires_on ?? null,
      issuedAt,
      validUntil,
    };
  } catch {
    return null;
  }
}
