import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { TOTP_ACCOUNT_LOCKOUT } from '@/lib/auth/plugins';
import { env } from '@/lib/env';

/**
 * Drives the Better Auth HTTP handler against Postgres. Skipped unless
 * RUN_INTEGRATION is set (CI provides Postgres and applies migrations first).
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(input: string): Uint8Array {
  const clean = input.replace(/=+$/u, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error(`Invalid base32 character: ${char}`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** Current TOTP for the raw secret embedded in an otpauth URI. */
function totpCode(rawSecret: string, now = Date.now()): string {
  const counter = Math.floor(now / 30_000);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', Buffer.from(rawSecret, 'utf8'))
    .update(counterBytes)
    .digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (binary % 1_000_000).toString().padStart(6, '0');
}

function secretFromUri(uri: string): string {
  const encoded = new URL(uri).searchParams.get('secret');
  if (!encoded) throw new Error('TOTP URI is missing a secret');
  return new TextDecoder().decode(decodeBase32(encoded));
}

function wrongCode(good: string): string {
  const next = String((Number(good) + 1) % 1_000_000).padStart(6, '0');
  return next === good ? '111111' : next;
}

type CookieJar = Map<string, string>;
type AuthHandler = { handler: (request: Request) => Promise<Response> };

function applySetCookie(jar: CookieJar, response: Response): void {
  const lines =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
  for (const line of lines) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    if (!pair) continue;
    const splitAt = pair.indexOf('=');
    if (splitAt < 0) continue;
    const name = pair.slice(0, splitAt);
    const value = pair.slice(splitAt + 1);
    const expired = value.length === 0 || attrs.some((attr) => /^max-age=0$/i.test(attr));
    if (expired) jar.delete(name);
    else jar.set(name, value);
  }
}

let ipSequence = 1;
function nextIp(): string {
  ipSequence += 1;
  return `203.0.113.${(ipSequence % 250) + 1}`;
}

async function authRequest(
  auth: AuthHandler,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; jar: CookieJar },
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const headers = new Headers({
    origin: env.BETTER_AUTH_URL,
    'cf-connecting-ip': nextIp(),
  });
  const cookie = [...options.jar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  if (cookie) headers.set('cookie', cookie);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const response = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
  applySetCookie(options.jar, response);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

integration('TOTP sign-in', () => {
  it('challenges an enrolled user and persists lockout', async () => {
    const [{ auth, hashCredentialPassword }, { db, schema }] = await Promise.all([
      import('@/lib/auth'),
      import('@/db/client'),
    ]);

    const userId = randomUUID();
    const email = `totp-${userId}@example.test`;
    const password = 'correct-horse-battery-staple';
    const jar: CookieJar = new Map();

    try {
      await db.insert(schema.users).values({
        id: userId,
        name: 'TOTP Integration',
        email,
        emailVerified: true,
      });
      await db.insert(schema.accounts).values({
        userId,
        providerId: 'credential',
        accountId: userId,
        password: await hashCredentialPassword(password),
      });

      const firstSignIn = await authRequest(auth, '/sign-in/email', {
        jar,
        body: { email, password },
      });
      expect(firstSignIn.status).toBe(200);
      expect(firstSignIn.body).toMatchObject({ token: expect.any(String) });

      const enabled = await authRequest(auth, '/two-factor/enable', {
        jar,
        body: { password },
      });
      expect(enabled.status).toBe(200);
      const totpUri = enabled.body?.totpURI;
      expect(typeof totpUri).toBe('string');
      const rawSecret = secretFromUri(totpUri as string);

      const confirmed = await authRequest(auth, '/two-factor/verify-totp', {
        jar,
        body: { code: totpCode(rawSecret) },
      });
      expect(confirmed.status).toBe(200);

      const [enrolled] = await db
        .select({ twoFactorEnabled: schema.users.twoFactorEnabled })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      expect(enrolled?.twoFactorEnabled).toBe(true);

      const signedOut = await authRequest(auth, '/sign-out', { jar, body: {} });
      expect(signedOut.status).toBe(200);

      const challenged = await authRequest(auth, '/sign-in/email', {
        jar,
        body: { email, password },
      });
      expect(challenged.status).toBe(200);
      expect(challenged.body).toMatchObject({
        twoFactorRedirect: true,
        twoFactorMethods: ['totp'],
      });
      expect(challenged.body).not.toHaveProperty('token');

      const pendingSessions = await db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, userId));
      expect(pendingSessions).toEqual([]);

      const sessionDuringChallenge = await authRequest(auth, '/get-session', {
        method: 'GET',
        jar,
      });
      expect(sessionDuringChallenge.body?.session ?? null).toBeNull();

      const completed = await authRequest(auth, '/two-factor/verify-totp', {
        jar,
        body: { code: totpCode(rawSecret) },
      });
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({ token: expect.any(String) });

      const sessionsAfterCode = await db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, userId));
      expect(sessionsAfterCode).toHaveLength(1);

      await authRequest(auth, '/sign-out', { jar, body: {} });

      const failuresPerChallenge = 5;
      const challenges = Math.ceil(
        TOTP_ACCOUNT_LOCKOUT.maxFailedAttempts / failuresPerChallenge,
      );
      for (let challenge = 0; challenge < challenges; challenge += 1) {
        const again = await authRequest(auth, '/sign-in/email', {
          jar,
          body: { email, password },
        });
        expect(again.body).toMatchObject({ twoFactorRedirect: true });
        const attempts =
          challenge === challenges - 1
            ? TOTP_ACCOUNT_LOCKOUT.maxFailedAttempts - challenge * failuresPerChallenge
            : failuresPerChallenge;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const rejected = await authRequest(auth, '/two-factor/verify-totp', {
            jar,
            body: { code: wrongCode(totpCode(rawSecret)) },
          });
          expect(rejected.status).toBe(401);
        }
      }

      const [factor] = await db
        .select({
          failedVerificationCount: schema.twoFactors.failedVerificationCount,
          lockedUntil: schema.twoFactors.lockedUntil,
        })
        .from(schema.twoFactors)
        .where(eq(schema.twoFactors.userId, userId));
      expect(factor?.failedVerificationCount).toBeGreaterThanOrEqual(
        TOTP_ACCOUNT_LOCKOUT.maxFailedAttempts,
      );
      expect(factor?.lockedUntil).toBeInstanceOf(Date);
      const remainingMs = (factor?.lockedUntil?.getTime() ?? 0) - Date.now();
      expect(remainingMs).toBeGreaterThan(
        TOTP_ACCOUNT_LOCKOUT.durationSeconds * 1000 - 60_000,
      );
      expect(remainingMs).toBeLessThanOrEqual(
        TOTP_ACCOUNT_LOCKOUT.durationSeconds * 1000 + 5_000,
      );

      const locked = await authRequest(auth, '/two-factor/verify-totp', {
        jar,
        body: { code: totpCode(rawSecret) },
      });
      expect(locked.status).toBe(429);
      expect(locked.body).toMatchObject({ code: 'ACCOUNT_TEMPORARILY_LOCKED' });

      const sessionsWhileLocked = await db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, userId));
      expect(sessionsWhileLocked).toEqual([]);
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  });
});
