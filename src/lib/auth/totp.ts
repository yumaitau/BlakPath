import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HOTP/TOTP compatible with Better Auth's authenticator codes.
 *
 * The HMAC key is the UTF-8 bytes of the secret string (not a base32 decode).
 * Digits 6, period 30 seconds, window ±1. Comparison checks every step so a
 * miss does not return early.
 */

export function hotp(secret: string, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export function totpMatches(
  secret: string,
  code: string,
  now = Date.now(),
  options?: { period?: number; digits?: number; window?: number },
): boolean {
  const period = options?.period ?? 30;
  const digits = options?.digits ?? 6;
  const window = options?.window ?? 1;
  const normalized = code.replace(/\s/g, '');
  if (!/^\d+$/.test(normalized) || normalized.length !== digits) return false;

  const counter = Math.floor(now / 1000 / period);
  const provided = Buffer.from(normalized);
  let matched = false;
  for (let step = -window; step <= window; step += 1) {
    const expected = Buffer.from(hotp(secret, counter + step, digits));
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      matched = true;
    }
  }
  return matched;
}

/**
 * Index of `provided` in `codes`, or -1. Every code is compared; the first
 * match is remembered and the scan continues.
 */
export function matchBackupCode(codes: readonly string[], provided: string): number {
  const candidate = Buffer.from(provided);
  let index = -1;
  for (let i = 0; i < codes.length; i += 1) {
    const current = Buffer.from(codes[i] ?? '');
    if (
      current.length === candidate.length &&
      timingSafeEqual(current, candidate) &&
      index < 0
    ) {
      index = i;
    }
  }
  return index;
}
