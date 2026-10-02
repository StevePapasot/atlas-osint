import { createHash, createHmac, randomBytes } from 'node:crypto';

export function sha256Hex(input: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Pseudonymise IP addresses for audit/rate-limit records (keyed so it cannot be reversed by brute force offline). */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const key = process.env.ATLAS_IP_HASH_SALT ?? 'atlas-local-ip-salt';
  return createHmac('sha256', key).update(ip).digest('hex').slice(0, 32);
}
