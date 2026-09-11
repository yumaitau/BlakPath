import {
  createHmac,
  createPublicKey,
  createVerify,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '@/lib/env';
import {
  registerSsoProvider,
  type FederatedIdentity,
  type SsoAuthorizationRequest,
  type SsoCallbackContext,
  type SsoProvider,
  type SsoStartContext,
} from './sso-provider';

/**
 * Entra ID (Azure AD) OIDC provider.
 *
 * Implements the `SsoProvider` contract with zero new dependencies: discovery
 * over HTTPS, RS256 id_token verification with node:crypto (JWKS cached
 * in-memory for 10 minutes), HMAC-signed short-lived state. Secrets come from
 * `SSO_ENTRA_CLIENT_ID` / `SSO_ENTRA_CLIENT_SECRET`; the issuer allow-list is
 * the tenant binding table (`organisation_sso_providers`), enforced by the
 * caller before `start`/`complete` run.
 */

const STATE_TTL_MS = 10 * 60_000;
const JWKS_TTL_MS = 10 * 60_000;

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

interface Jwk {
  kty: string;
  kid?: string;
  [key: string]: unknown;
}

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`SSO endpoint error: ${res.status}`);
  return res.json() as Promise<unknown>;
}

export async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.doc;
  const base = issuer.replace(/\/$/, '');
  const doc = (await fetchJson(`${base}/.well-known/openid-configuration`)) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('SSO discovery document incomplete.');
  }
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

async function jwks(uri: string): Promise<Jwk[]> {
  const cached = jwksCache.get(uri);
  if (cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const doc = (await fetchJson(uri)) as { keys?: Jwk[] };
  if (!Array.isArray(doc.keys)) throw new Error('SSO JWKS malformed.');
  jwksCache.set(uri, { at: Date.now(), keys: doc.keys });
  return doc.keys;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function b64urlJson<T>(value: T): string {
  return b64url(JSON.stringify(value));
}

/** Sign opaque state binding organisation + nonce, 10-minute expiry. */
export function signState(organisationId: string, secret: string): string {
  const payload = b64urlJson({
    org: organisationId,
    nonce: randomUUID(),
    exp: Date.now() + STATE_TTL_MS,
  });
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Verify state, returning the organisation it was issued for. Throws on any failure. */
export function verifyState(state: string, secret: string): string {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) throw new Error('SSO state malformed.');
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('SSO state signature invalid.');
  }
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
    org?: string;
    exp?: number;
  };
  if (!data.org || typeof data.exp !== 'number' || data.exp < Date.now()) {
    throw new Error('SSO state expired or invalid.');
  }
  return data.org;
}

export interface EntraConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  stateSecret: string;
}

function verifyIdToken(
  idToken: string,
  keys: Jwk[],
  expected: { issuer: string; audience: string; nonce?: string },
): Record<string, unknown> {
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) throw new Error('SSO id_token malformed.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== 'RS256') throw new Error('SSO id_token algorithm rejected.');
  const key = keys.find((k) => k.kty === 'RSA' && (!header.kid || k.kid === header.kid));
  if (!key) throw new Error('SSO signing key not found.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  const ok = verifier.verify(
    createPublicKey({ key, format: 'jwk' }),
    Buffer.from(s, 'base64url'),
  );
  if (!ok) throw new Error('SSO id_token signature invalid.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<
    string,
    unknown
  >;
  if (claims.iss !== expected.issuer) throw new Error('SSO issuer mismatch.');
  const aud = claims.aud;
  const audOk =
    aud === expected.audience || (Array.isArray(aud) && aud.includes(expected.audience));
  if (!audOk) throw new Error('SSO audience mismatch.');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) {
    throw new Error('SSO id_token expired.');
  }
  if (expected.nonce && claims.nonce !== expected.nonce) {
    throw new Error('SSO nonce mismatch.');
  }
  return claims;
}

export class EntraSsoProvider implements SsoProvider {
  readonly key = 'entra';
  readonly displayName = 'Microsoft Entra ID';
  readonly protocol = 'oidc' as const;
  private readonly config: EntraConfig;

  constructor(config: EntraConfig) {
    this.config = config;
  }

  async start(context: SsoStartContext): Promise<SsoAuthorizationRequest> {
    const { authorization_endpoint } = await discover(this.config.issuer);
    const state = signState(context.organisationId, this.config.stateSecret);
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: context.callbackUrl,
      response_mode: 'query',
      scope: 'openid profile email',
      state,
    });
    return { redirectUrl: `${authorization_endpoint}?${params.toString()}`, state };
  }

  async complete(context: SsoCallbackContext): Promise<FederatedIdentity> {
    const url = new URL(context.callbackUrl);
    const code = url.searchParams.get('code');
    const state = context.state || url.searchParams.get('state');
    if (!code || !state) throw new Error('SSO callback missing code or state.');
    const organisationId = verifyState(state, this.config.stateSecret);
    if (organisationId !== context.organisationId) {
      throw new Error('SSO organisation mismatch.');
    }
    const discovery = await discover(this.config.issuer);
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: `${url.origin}${url.pathname}`,
      }).toString(),
    });
    if (!tokenRes.ok) throw new Error('SSO code exchange failed.');
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error('SSO token response missing id_token.');
    const keys = await jwks(discovery.jwks_uri);
    const claims = verifyIdToken(tokens.id_token, keys, {
      issuer: this.config.issuer,
      audience: this.config.clientId,
    });
    const subject = claims.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new Error('SSO identity missing subject.');
    }
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    return {
      subject,
      ...(email ? { email } : {}),
      emailVerified: claims.email_verified === true,
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      claims,
    };
  }
}

/**
 * Register the Entra provider from env when configured. Call once at startup
 * (instrumentation). Missing env = provider unavailable (secure default).
 */
export function registerEntraFromEnv(): boolean {
  const clientId = env.SSO_ENTRA_CLIENT_ID;
  const clientSecret = env.SSO_ENTRA_CLIENT_SECRET;
  const issuer = env.SSO_ENTRA_ISSUER ?? 'https://login.microsoftonline.com/common/v2.0';
  if (!clientId || !clientSecret) return false;
  registerSsoProvider(
    new EntraSsoProvider({
      issuer,
      clientId,
      clientSecret,
      stateSecret: env.BETTER_AUTH_SECRET,
    }),
  );
  return true;
}
