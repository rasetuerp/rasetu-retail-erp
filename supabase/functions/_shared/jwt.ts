import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5';

// Ed25519-signed offline-verifiable token — mirrors electron/license-verify.ts's
// expected claims exactly (license_id, key, machine_id, status, type,
// amc_expires_on, valid_until, iat, exp). Private key is an Edge Function
// secret (LICENSE_SIGNING_PRIVATE_KEY, PKCS8 PEM); the matching public key is
// baked into the desktop app for offline verification.
export type LicenseTokenClaims = {
  license_id: string;
  key: string;
  machine_id: string;
  status: string;
  type: string;
  amc_expires_on: string | null;
};

export async function signValidationToken(claims: LicenseTokenClaims, ttlDays = 30) {
  const pem = Deno.env.get('LICENSE_SIGNING_PRIVATE_KEY')!.replace(/\\n/g, '\n');
  const privateKey = await importPKCS8(pem, 'EdDSA');
  const validUntil = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const token = await new SignJWT({ ...claims, valid_until: validUntil.toISOString() })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .setExpirationTime(`${ttlDays}d`)
    .sign(privateKey);

  return { token, validUntil };
}
