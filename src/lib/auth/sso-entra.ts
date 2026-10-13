import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  createVerify,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '@/lib/env';
import {
  registerSsoProvider,
  resolveSsoProvider,
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
 * in-memory for 10 minutes), authorization code flow with PKCE (S256) and a
 * nonce. The flow transaction (state, nonce, PKCE verifier, tenant, issuer) is
 * sealed with AES-256-GCM under a dedicated `SSO_STATE_SECRET` and kept in an
 * httpOnly cookie by the caller, so a callback only completes in the browser
 * that started it. Client credentials come from `SSO_ENTRA_CLIENT_ID` /
 * `SSO_ENTRA_CLIENT_SECRET` (Secrets Manager via the runtime secret). The
 * issuer is per tenant — taken from the binding (`organisation_sso_providers`),
 * never a multi-tenant `common` endpoint — and is checked against the discovery
 * document and the id_token `iss`.
 */

const TRANSACTION_TTL_MS = 10 * 60_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const JWKS_TTL_MS = 10 * 60_000;
/** Tolerated clock skew between us and the IdP, in seconds. */
const CLOCK_SKEW_S = 60;

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

/** HTTPS only; plain HTTP is tolerated for loopback mock IdPs in tests. */
function assertSecureIssuer(issuer: string): void {
  const url = new URL(issuer);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('SSO issuer must use HTTPS.');
  }
}

/**
 * OIDC discovery for a tenant issuer. The document's `issuer` MUST be
 * identical to the issuer it was fetched for (OIDC Discovery §4.3), which also
 * rejects Entra's multi-tenant endpoints (their issuer is a `{tenantid}`
 * template that matches no real token).
 */
export async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc;
  assertSecureIssuer(issuer);
  const base = issuer.replace(/\/$/, '');
  const doc = (await fetchJson(`${base}/.well-known/openid-configuration`)) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('SSO discovery document incomplete.');
  }
  if (doc.issuer !== issuer) throw new Error('SSO discovery issuer mismatch.');
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

async function jwks(uri: string, refresh = false): Promise<Jwk[]> {
  const cached = jwksCache.get(uri);
  if (!refresh && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const doc = (await fetchJson(uri)) as { keys?: Jwk[] };
  if (!Array.isArray(doc.keys)) throw new Error('SSO JWKS malformed.');
  jwksCache.set(uri, { at: Date.now(), keys: doc.keys });
  return doc.keys;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Everything the callback needs, sealed so the browser can hold but not read it. */
export interface SsoTransaction {
  org: string;
  iss: string;
  state: string;
  nonce: string;
  /** PKCE code_verifier. */
  cv: string;
  exp: number;
}

function transactionKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', 'blakpath.sso.transaction.v1', 32));
}

/** Seal a transaction with AES-256-GCM (confidential + tamper-evident). */
export function sealTransaction(tx: SsoTransaction, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', transactionKey(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(tx), 'utf8'), cipher.final()]);
  return [iv, body, cipher.getAuthTag()]
    .map((part) => part.toString('base64url'))
    .join('.');
}

/** Open a sealed transaction. Throws on tampering, wrong key or expiry. */
export function openTransaction(sealed: string, secret: string): SsoTransaction {
  const [iv, body, tag] = sealed.split('.');
  if (!iv || !body || !tag) throw new Error('SSO transaction malformed.');
  let tx: Partial<SsoTransaction>;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      transactionKey(secret),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]);
    tx = JSON.parse(plain.toString('utf8')) as Partial<SsoTransaction>;
  } catch {
    throw new Error('SSO transaction invalid.');
  }
  if (
    !tx.org ||
    !tx.iss ||
    !tx.state ||
    !tx.nonce ||
    !tx.cv ||
    typeof tx.exp !== 'number' ||
    tx.exp < Date.now()
  ) {
    throw new Error('SSO transaction expired or invalid.');
  }
  return tx as SsoTransaction;
}

export interface EntraConfig {
  clientId: string;
  clientSecret: string;
  /** Dedicated transaction-sealing secret (never BETTER_AUTH_SECRET). */
  stateSecret: string;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString()) as T;
}

async function verifyIdToken(
  idToken: string,
  jwksUri: string,
  expected: { issuer: string; audience: string; nonce: string },
): Promise<Record<string, unknown>> {
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) throw new Error('SSO id_token malformed.');
  const header = decodeSegment<{ alg?: string; kid?: string }>(h);
  if (header.alg !== 'RS256') throw new Error('SSO id_token algorithm rejected.');
  if (!header.kid) throw new Error('SSO id_token missing key id.');
  const find = (keys: Jwk[]) => keys.find((k) => k.kty === 'RSA' && k.kid === header.kid);
  // Unknown kid: refetch once to pick up an IdP key rotation.
  const key = find(await jwks(jwksUri)) ?? find(await jwks(jwksUri, true));
  if (!key) throw new Error('SSO signing key not found.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  const ok = verifier.verify(
    createPublicKey({ key, format: 'jwk' }),
    Buffer.from(s, 'base64url'),
  );
  if (!ok) throw new Error('SSO id_token signature invalid.');
  const claims = decodeSegment<Record<string, unknown>>(p);
  if (claims.iss !== expected.issuer) throw new Error('SSO issuer mismatch.');
  const aud = claims.aud;
  const audOk =
    aud === expected.audience || (Array.isArray(aud) && aud.includes(expected.audience));
  if (!audOk) throw new Error('SSO audience mismatch.');
  if (Array.isArray(aud) && aud.length > 1 && claims.azp !== expected.audience) {
    throw new Error('SSO authorized party mismatch.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) {
    throw new Error('SSO id_token expired.');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) {
    throw new Error('SSO id_token not yet valid.');
  }
  if (typeof claims.nonce !== 'string' || !sameString(claims.nonce, expected.nonce)) {
    throw new Error('SSO nonce mismatch.');
  }
  return claims;
}

/**
 * Email for first-time account linking. Entra only emits `email` when the
 * optional claim is configured; otherwise `preferred_username` (the UPN, whose
 * suffix Entra requires to be a domain verified in that tenant) is used. The
 * caller still requires the domain to equal the binding's verified domain.
 */
function emailFrom(claims: Record<string, unknown>): string | undefined {
  if (typeof claims.email === 'string' && claims.email.includes('@')) return claims.email;
  const upn = claims.preferred_username;
  return typeof upn === 'string' && upn.includes('@') ? upn : undefined;
}

export class EntraSsoProvider implements SsoProvider {
  readonly key = 'entra';
  readonly displayName = 'Microsoft Entra ID';
  readonly protocol = 'oidc' as const;
  private readonly config: EntraConfig;

  constructor(config: EntraConfig) {
    this.config = config;
  }

  private assertClient(clientId: string): void {
    if (clientId !== this.config.clientId) {
      throw new Error('SSO binding client does not match the configured client.');
    }
  }

  async start(context: SsoStartContext): Promise<SsoAuthorizationRequest> {
    this.assertClient(context.clientId);
    const { authorization_endpoint } = await discover(context.issuer);
    const tx: SsoTransaction = {
      org: context.organisationId,
      iss: context.issuer,
      state: randomToken(),
      nonce: randomToken(),
      cv: randomToken(),
      exp: Date.now() + TRANSACTION_TTL_MS,
    };
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: context.callbackUrl,
      response_mode: 'query',
      scope: 'openid profile email',
      state: tx.state,
      nonce: tx.nonce,
      code_challenge: createHash('sha256').update(tx.cv).digest('base64url'),
      code_challenge_method: 'S256',
    });
    if (context.loginHint) params.set('login_hint', context.loginHint);
    return {
      redirectUrl: `${authorization_endpoint}?${params.toString()}`,
      state: tx.state,
      transaction: sealTransaction(tx, this.config.stateSecret),
    };
  }

  async complete(context: SsoCallbackContext): Promise<FederatedIdentity> {
    this.assertClient(context.clientId);
    const url = new URL(context.callbackUrl);
    if (url.searchParams.get('error')) throw new Error('SSO provider returned an error.');
    const code = url.searchParams.get('code');
    const state = context.state || url.searchParams.get('state');
    if (!code || !state) throw new Error('SSO callback missing code or state.');
    if (!context.transaction) throw new Error('SSO transaction missing.');
    const tx = openTransaction(context.transaction, this.config.stateSecret);
    if (!sameString(state, tx.state)) throw new Error('SSO state mismatch.');
    if (tx.org !== context.organisationId) {
      throw new Error('SSO organisation mismatch.');
    }
    if (tx.iss !== context.issuer) throw new Error('SSO issuer mismatch.');
    const discovery = await discover(tx.iss);
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        code_verifier: tx.cv,
        redirect_uri: `${url.origin}${url.pathname}`,
      }).toString(),
    });
    if (!tokenRes.ok) throw new Error('SSO code exchange failed.');
    // Only the id_token is read; IdP access/refresh tokens are never stored.
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error('SSO token response missing id_token.');
    const claims = await verifyIdToken(tokens.id_token, discovery.jwks_uri, {
      issuer: tx.iss,
      audience: this.config.clientId,
      nonce: tx.nonce,
    });
    const subject = claims.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new Error('SSO identity missing subject.');
    }
    const email = emailFrom(claims);
    return {
      subject,
      ...(email ? { email } : {}),
      emailVerified: claims.email_verified === true || claims.xms_edov === true,
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      claims,
    };
  }
}

/**
 * Register the Entra provider from env when configured. Idempotent: safe to
 * call from instrumentation and again lazily from the auth plugin (Next.js may
 * load those in separate module graphs). Missing env = provider unavailable
 * (secure default) — including a missing dedicated `SSO_STATE_SECRET`.
 */
export function registerEntraFromEnv(): boolean {
  if (resolveSsoProvider('entra')) return true;
  const clientId = env.SSO_ENTRA_CLIENT_ID;
  const clientSecret = env.SSO_ENTRA_CLIENT_SECRET;
  const stateSecret = env.SSO_STATE_SECRET;
  if (!clientId || !clientSecret || !stateSecret) return false;
  registerSsoProvider(new EntraSsoProvider({ clientId, clientSecret, stateSecret }));
  return true;
}
