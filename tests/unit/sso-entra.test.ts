import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntraSsoProvider, signState, verifyState } from '@/lib/auth/sso-entra';

const ISSUER = 'https://login.microsoftonline.com/tenant-id/v2.0';
const CLIENT_ID = 'test-client-id';

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('sso state', () => {
  it('round-trips and rejects tampering and expiry', () => {
    const secret = 'test-secret-min-32-chars-padded-0000';
    const state = signState('org-1', secret);
    expect(verifyState(state, secret)).toBe('org-1');
    expect(() => verifyState(`${state}tampered`, secret)).toThrow();
    expect(() => verifyState(state, 'wrong-secret-padded-00000000000000')).toThrow();
  });
});

describe('entra provider', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

  function idToken(claims: Record<string, unknown>): string {
    const header = b64urlJson({ alg: 'RS256', kid: 'key-1', typ: 'JWT' });
    const payload = b64urlJson(claims);
    const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
    return `${header}.${payload}.${sig.toString('base64url')}`;
  }

  const validClaims = () => ({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'entra-sub-123',
    email: 'staff@council.example',
    email_verified: true,
    name: 'Test Staff',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  const provider = () =>
    new EntraSsoProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      stateSecret: 'test-secret-min-32-chars-padded-0000',
    });

  const discoveryDoc = {
    authorization_endpoint: `${ISSUER}/oauth2/v2.0/authorize`,
    token_endpoint: `${ISSUER}/oauth2/v2.0/token`,
    jwks_uri: `${ISSUER}/discovery/v2.0/keys`,
    issuer: ISSUER,
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const json = async () => {
          if (href.endsWith('/.well-known/openid-configuration')) return discoveryDoc;
          if (href === discoveryDoc.jwks_uri) return { keys: [{ ...jwk, kid: 'key-1' }] };
          if (href === discoveryDoc.token_endpoint) {
            const body = new URLSearchParams((init?.body as string) ?? '');
            const code = body.get('code');
            if (code === 'bad-code') return {};
            return {
              id_token: idToken(
                code === 'expired' ? { ...validClaims(), exp: 1 } : validClaims(),
              ),
            };
          }
          throw new Error(`unexpected fetch: ${href}`);
        };
        return { ok: true, json } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds an authorization redirect bound to the organisation', async () => {
    const { redirectUrl, state } = await provider().start({
      organisationId: 'org-1',
      callbackUrl: 'https://app.example/api/sso/entra/callback',
    });
    expect(redirectUrl).toContain('oauth2/v2.0/authorize');
    expect(redirectUrl).toContain(`client_id=${CLIENT_ID}`);
    expect(verifyState(state, 'test-secret-min-32-chars-padded-0000')).toBe('org-1');
  });

  it('completes with a verified federated identity', async () => {
    const { state } = await provider().start({
      organisationId: 'org-1',
      callbackUrl: 'https://app.example/api/sso/entra/callback',
    });
    const identity = await provider().complete({
      organisationId: 'org-1',
      callbackUrl: 'https://app.example/api/sso/entra/callback?code=good',
      state,
    });
    expect(identity).toMatchObject({
      subject: 'entra-sub-123',
      email: 'staff@council.example',
      emailVerified: true,
    });
  });

  it('rejects org mismatch, bad code, and expired tokens', async () => {
    const { state } = await provider().start({
      organisationId: 'org-1',
      callbackUrl: 'https://app.example/callback',
    });
    await expect(
      provider().complete({
        organisationId: 'org-2',
        callbackUrl: 'https://app.example/callback?code=good',
        state,
      }),
    ).rejects.toThrow(/organisation mismatch/);
    await expect(
      provider().complete({
        organisationId: 'org-1',
        callbackUrl: 'https://app.example/callback?code=bad-code',
        state,
      }),
    ).rejects.toThrow(/id_token/);
    await expect(
      provider().complete({
        organisationId: 'org-1',
        callbackUrl: 'https://app.example/callback?code=expired',
        state,
      }),
    ).rejects.toThrow(/expired/);
  });
});
