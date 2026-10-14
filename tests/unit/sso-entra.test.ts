import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EntraSsoProvider,
  openTransaction,
  sealTransaction,
  type SsoTransaction,
} from '@/lib/auth/sso-entra';

/**
 * Entra OIDC provider against an in-process mock IdP (stubbed fetch). No real
 * tenant is contacted. The mock enforces PKCE like Entra does: the token
 * endpoint only answers when sha256(code_verifier) equals the challenge sent
 * on the authorization request.
 */

const ISSUER = 'https://login.microsoftonline.com/tenant-id/v2.0';
const CLIENT_ID = 'test-client-id';
const STATE_SECRET = 'sso-state-secret-min-32-chars-padded-0000';
const CALLBACK = 'https://app.example/api/auth/sso/callback';

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = signingKey.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

function sign(
  claims: Record<string, unknown>,
  opts: { key?: KeyObject; alg?: string; kid?: string } = {},
): string {
  const header = b64urlJson({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'key-1' });
  const payload = b64urlJson(claims);
  const sig = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(opts.key ?? signingKey.privateKey);
  return `${header}.${payload}.${sig.toString('base64url')}`;
}

const provider = () =>
  new EntraSsoProvider({
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    stateSecret: STATE_SECRET,
  });

const baseContext = { organisationId: 'org-1', issuer: ISSUER, clientId: CLIENT_ID };

describe('sso transaction', () => {
  const tx = (): SsoTransaction => ({
    org: 'org-1',
    iss: ISSUER,
    state: 's',
    nonce: 'n',
    cv: 'v',
    exp: Date.now() + 60_000,
  });

  it('round-trips and is opaque to the browser', () => {
    const sealed = sealTransaction(tx(), STATE_SECRET);
    expect(openTransaction(sealed, STATE_SECRET)).toMatchObject({
      org: 'org-1',
      cv: 'v',
    });
    expect(sealed).not.toContain('org-1');
  });

  it('rejects tampering, the wrong secret, and expiry', () => {
    const sealed = sealTransaction(tx(), STATE_SECRET);
    const [iv, body, tag] = sealed.split('.');
    const flipped = Buffer.from(body!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() =>
      openTransaction(`${iv}.${flipped.toString('base64url')}.${tag}`, STATE_SECRET),
    ).toThrow(/invalid/);
    expect(() =>
      openTransaction(sealed, 'another-secret-min-32-chars-padded-00'),
    ).toThrow();
    expect(() => openTransaction('garbage', STATE_SECRET)).toThrow(/malformed/);
    const expired = sealTransaction({ ...tx(), exp: Date.now() - 1 }, STATE_SECRET);
    expect(() => openTransaction(expired, STATE_SECRET)).toThrow(/expired/);
  });
});

describe('entra provider', () => {
  /** What the mock IdP issues for the next code. */
  let claimOverrides: Record<string, unknown> = {};
  let tokenOverride: ((nonce: string) => string) | null = null;
  let discoveryIssuer = ISSUER;
  const issued = new Map<string, { challenge: string; nonce: string }>();
  let tokenRequests: URLSearchParams[] = [];

  const discoveryDoc = () => ({
    authorization_endpoint: `${ISSUER}/oauth2/v2.0/authorize`,
    token_endpoint: `${ISSUER}/oauth2/v2.0/token`,
    jwks_uri: `${ISSUER}/discovery/v2.0/keys`,
    issuer: discoveryIssuer,
  });

  const validClaims = (nonce: string) => ({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'entra-sub-123',
    preferred_username: 'staff@council.example',
    email: 'staff@council.example',
    name: 'Test Staff',
    nonce,
    exp: Math.floor(Date.now() / 1000) + 3600,
    amr: ['pwd', 'mfa'],
  });

  /** Mock IdP authorize: user signs in, IdP redirects back with a code. */
  function authorize(redirectUrl: string): string {
    const params = new URL(redirectUrl).searchParams;
    const code = `code-${issued.size + 1}`;
    issued.set(code, {
      challenge: params.get('code_challenge') ?? '',
      nonce: params.get('nonce') ?? '',
    });
    return `${CALLBACK}?code=${code}&state=${params.get('state')}`;
  }

  beforeEach(() => {
    claimOverrides = {};
    tokenOverride = null;
    discoveryIssuer = ISSUER;
    issued.clear();
    tokenRequests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const reply = (body: unknown, ok = true) =>
          ({ ok, status: ok ? 200 : 400, json: async () => body }) as Response;
        if (href.endsWith('/.well-known/openid-configuration'))
          return reply(discoveryDoc());
        if (href === discoveryDoc().jwks_uri)
          return reply({ keys: [{ ...jwk, kid: 'key-1' }] });
        if (href === discoveryDoc().token_endpoint) {
          const body = new URLSearchParams((init?.body as string) ?? '');
          tokenRequests.push(body);
          const grant = issued.get(body.get('code') ?? '');
          const verifier = body.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!grant || grant.challenge !== challenge) {
            return reply({ error: 'invalid_grant' }, false);
          }
          const idToken = tokenOverride
            ? tokenOverride(grant.nonce)
            : sign({ ...validClaims(grant.nonce), ...claimOverrides });
          return reply({ id_token: idToken });
        }
        throw new Error(`unexpected fetch: ${href}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function startFlow(loginHint?: string) {
    const request = await provider().start({
      ...baseContext,
      callbackUrl: CALLBACK,
      ...(loginHint ? { loginHint } : {}),
    });
    return { ...request, callbackUrl: authorize(request.redirectUrl) };
  }

  function complete(
    flow: { callbackUrl: string; state: string; transaction: string },
    overrides: Partial<typeof baseContext & { transaction: string; state: string }> = {},
  ) {
    return provider().complete({
      ...baseContext,
      callbackUrl: flow.callbackUrl,
      state: flow.state,
      transaction: flow.transaction,
      ...overrides,
    });
  }

  it('sends state, nonce and an S256 PKCE challenge bound to a sealed transaction', async () => {
    const { redirectUrl, state, transaction } = await provider().start({
      ...baseContext,
      callbackUrl: CALLBACK,
      loginHint: 'staff@council.example',
    });
    const params = new URL(redirectUrl).searchParams;
    expect(redirectUrl).toContain('oauth2/v2.0/authorize');
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('state')).toBe(state);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('login_hint')).toBe('staff@council.example');
    const tx = openTransaction(transaction, STATE_SECRET);
    expect(tx).toMatchObject({ org: 'org-1', iss: ISSUER, state });
    expect(params.get('nonce')).toBe(tx.nonce);
    expect(params.get('code_challenge')).toBe(
      createHash('sha256').update(tx.cv).digest('base64url'),
    );
    // Secrets for the callback never travel through the IdP redirect.
    expect(redirectUrl).not.toContain(tx.cv);
    expect(redirectUrl).not.toContain(transaction);
  });

  it('completes with a verified federated identity and sends the PKCE verifier', async () => {
    const flow = await startFlow();
    const identity = await complete(flow);
    expect(identity).toMatchObject({
      subject: 'entra-sub-123',
      email: 'staff@council.example',
      emailVerified: true,
    });
    expect(tokenRequests[0]?.get('redirect_uri')).toBe(CALLBACK);
    expect(tokenRequests[0]?.get('code_verifier')).toBeTruthy();
  });

  it('falls back to the UPN for the email when no email claim is issued', async () => {
    claimOverrides = { email: undefined, preferred_username: 'upn@council.example' };
    const identity = await complete(await startFlow());
    expect(identity.email).toBe('upn@council.example');
    expect(identity.emailVerified).toBe(true);
  });

  it('links on the UPN and ignores a divergent mail attribute', async () => {
    claimOverrides = {
      email: 'victim@council.example',
      preferred_username: 'staff@council.example',
    };
    const identity = await complete(await startFlow());
    expect(identity.email).toBe('staff@council.example');
    expect(identity.emailVerified).toBe(true);
  });

  it('does not treat an unverified mail claim as a verified address', async () => {
    claimOverrides = { preferred_username: undefined };
    const identity = await complete(await startFlow());
    expect(identity.email).toBe('staff@council.example');
    expect(identity.emailVerified).toBe(false);
  });

  it('accepts a mail claim when Entra marks the domain verified and there is no UPN', async () => {
    claimOverrides = { preferred_username: undefined, xms_edov: true };
    const identity = await complete(await startFlow());
    expect(identity.email).toBe('staff@council.example');
    expect(identity.emailVerified).toBe(true);
  });

  it('rejects a password-only token and a token with no amr claim', async () => {
    claimOverrides = { amr: ['pwd'] };
    await expect(complete(await startFlow())).rejects.toThrow(/multi-factor/);
    claimOverrides = { amr: undefined };
    await expect(complete(await startFlow())).rejects.toThrow(/multi-factor/);
  });

  it('rejects a callback without this browser’s transaction', async () => {
    const flow = await startFlow();
    await expect(complete(flow, { transaction: '' })).rejects.toThrow(/transaction/);
  });

  it('rejects a transaction from another browser (state mismatch)', async () => {
    const victim = await startFlow();
    const attacker = await startFlow();
    // Attacker's code+state replayed into the victim's browser (login CSRF).
    await expect(
      complete({ ...attacker, transaction: victim.transaction }),
    ).rejects.toThrow(/state mismatch/);
  });

  it('rejects a tampered transaction', async () => {
    const flow = await startFlow();
    await expect(
      complete(flow, { transaction: `${flow.transaction.slice(0, -2)}AA` }),
    ).rejects.toThrow(/transaction/);
  });

  it('rejects organisation, issuer and client mismatches', async () => {
    const flow = await startFlow();
    await expect(complete(flow, { organisationId: 'org-2' })).rejects.toThrow(
      /organisation mismatch/,
    );
    await expect(
      complete(flow, { issuer: 'https://login.microsoftonline.com/other/v2.0' }),
    ).rejects.toThrow(/issuer mismatch/);
    await expect(complete(flow, { clientId: 'someone-else' })).rejects.toThrow(/client/);
    await expect(
      provider().start({
        ...baseContext,
        clientId: 'someone-else',
        callbackUrl: CALLBACK,
      }),
    ).rejects.toThrow(/client/);
  });

  it('rejects an IdP error response', async () => {
    const flow = await startFlow();
    await expect(
      complete({ ...flow, callbackUrl: `${CALLBACK}?error=access_denied&state=x` }),
    ).rejects.toThrow(/provider returned an error/);
  });

  it('fails the code exchange when the PKCE verifier does not match', async () => {
    const flow = await startFlow();
    const tx = openTransaction(flow.transaction, STATE_SECRET);
    const forged = sealTransaction({ ...tx, cv: 'not-the-verifier' }, STATE_SECRET);
    await expect(complete(flow, { transaction: forged })).rejects.toThrow(
      /code exchange/,
    );
  });

  it('rejects a nonce mismatch or a missing nonce', async () => {
    claimOverrides = { nonce: 'replayed-nonce' };
    await expect(complete(await startFlow())).rejects.toThrow(/nonce/);
    claimOverrides = { nonce: undefined };
    await expect(complete(await startFlow())).rejects.toThrow(/nonce/);
  });

  it('rejects a token from another tenant (issuer) or for another client (audience)', async () => {
    claimOverrides = { iss: 'https://login.microsoftonline.com/attacker/v2.0' };
    await expect(complete(await startFlow())).rejects.toThrow(/issuer mismatch/);
    claimOverrides = { aud: 'another-client' };
    await expect(complete(await startFlow())).rejects.toThrow(/audience/);
    claimOverrides = { aud: [CLIENT_ID, 'another-client'], azp: 'another-client' };
    await expect(complete(await startFlow())).rejects.toThrow(/authorized party/);
  });

  it('rejects expired and not-yet-valid tokens', async () => {
    claimOverrides = { exp: 1 };
    await expect(complete(await startFlow())).rejects.toThrow(/expired/);
    claimOverrides = { nbf: Math.floor(Date.now() / 1000) + 3600 };
    await expect(complete(await startFlow())).rejects.toThrow(/not yet valid/);
  });

  it('rejects bad signatures, unknown keys and non-RS256 algorithms', async () => {
    tokenOverride = (nonce) => sign(validClaims(nonce), { key: otherKey.privateKey });
    await expect(complete(await startFlow())).rejects.toThrow(/signature invalid/);
    tokenOverride = (nonce) => sign(validClaims(nonce), { kid: 'rotated-away' });
    await expect(complete(await startFlow())).rejects.toThrow(/signing key not found/);
    tokenOverride = (nonce) => {
      const [, payload] = sign(validClaims(nonce)).split('.');
      return `${b64urlJson({ alg: 'none', kid: 'key-1' })}.${payload}.`;
    };
    await expect(complete(await startFlow())).rejects.toThrow(/malformed|algorithm/);
    tokenOverride = () => 'not-a-jwt';
    await expect(complete(await startFlow())).rejects.toThrow(/malformed/);
  });

  it('rejects a discovery document whose issuer differs (e.g. the common endpoint)', async () => {
    discoveryIssuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
    const issuer = 'https://login.microsoftonline.com/common/v2.0';
    await expect(
      provider().start({ ...baseContext, issuer, callbackUrl: CALLBACK }),
    ).rejects.toThrow(/discovery issuer mismatch/);
  });

  it('refuses a non-HTTPS issuer', async () => {
    await expect(
      provider().start({
        ...baseContext,
        issuer: 'http://idp.example/tenant/v2.0',
        callbackUrl: CALLBACK,
      }),
    ).rejects.toThrow(/HTTPS/);
  });
});
