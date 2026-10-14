import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { isolateSignInClient } from './helpers/auth';

/**
 * Federated sign-in journey (#20) against a MOCK Entra-style IdP — no real
 * tenant. The mock runs in this test process on loopback and behaves like
 * Entra's v2 endpoints: tenant-specific discovery, JWKS, authorize (auto
 * consents for `login_hint`) and a token endpoint that enforces client
 * credentials, redirect_uri and PKCE S256 before issuing an RS256 id_token
 * echoing the nonce.
 *
 * The app under test must run with SSO_ENTRA_CLIENT_ID / SSO_ENTRA_CLIENT_SECRET
 * / SSO_STATE_SECRET set (CI does); otherwise the journey is skipped.
 */

const CLIENT_ID = process.env.SSO_ENTRA_CLIENT_ID;
const CLIENT_SECRET = process.env.SSO_ENTRA_CLIENT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const IDP_PORT = Number(process.env.SSO_E2E_IDP_PORT ?? 4455);
const IDP_BASE = `http://localhost:${IDP_PORT}`;
const ISSUER = `${IDP_BASE}/e2e-tenant/v2.0`;
const DOMAIN = 'sso-e2e.blakpath.test';
const SSO_EMAIL = `staff@${DOMAIN}`;
const SSO_FAILURE_TEXT = 'Single sign-on isn’t available for this account';

test.skip(
  !CLIENT_ID || !CLIENT_SECRET || !process.env.SSO_STATE_SECRET || !DATABASE_URL,
  'SSO e2e needs SSO_ENTRA_CLIENT_ID, SSO_ENTRA_CLIENT_SECRET, SSO_STATE_SECRET and DATABASE_URL',
);
test.describe.configure({ mode: 'serial' });

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'e2e-key', use: 'sig' };
const grants = new Map<
  string,
  { challenge: string; nonce: string; redirectUri: string; email: string }
>();
/** When set, the mock IdP signs a token with a nonce the app never issued. */
let forgeNonce = false;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function idToken(claims: Record<string, unknown>): string {
  const head = b64url({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' });
  const body = b64url(claims);
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(keys.privateKey);
  return `${head}.${body}.${sig.toString('base64url')}`;
}

let idp: Server;
let sql: ReturnType<typeof postgres>;
let organisationId: string;

function startMockIdp(): Promise<void> {
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', IDP_BASE);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/e2e-tenant/v2.0/.well-known/openid-configuration') {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${IDP_BASE}/authorize`,
        token_endpoint: `${IDP_BASE}/token`,
        jwks_uri: `${IDP_BASE}/keys`,
      });
    }
    if (url.pathname === '/keys') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (
        p.get('client_id') !== CLIENT_ID ||
        p.get('response_type') !== 'code' ||
        p.get('code_challenge_method') !== 'S256' ||
        !p.get('nonce') ||
        !p.get('state')
      ) {
        return json(400, { error: 'invalid_request' });
      }
      const code = randomUUID();
      grants.set(code, {
        challenge: p.get('code_challenge') ?? '',
        nonce: p.get('nonce') ?? '',
        redirectUri: p.get('redirect_uri') ?? '',
        email: p.get('login_hint') ?? '',
      });
      const back = new URL(p.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        const grant = grants.get(form.get('code') ?? '');
        grants.delete(form.get('code') ?? '');
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (
          !grant ||
          form.get('client_id') !== CLIENT_ID ||
          form.get('client_secret') !== CLIENT_SECRET ||
          form.get('redirect_uri') !== grant.redirectUri ||
          challenge !== grant.challenge
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        const now = Math.floor(Date.now() / 1000);
        return json(200, {
          id_token: idToken({
            iss: ISSUER,
            aud: CLIENT_ID,
            sub: `mock-${createHash('sha256').update(grant.email).digest('hex').slice(0, 24)}`,
            preferred_username: grant.email,
            amr: ['pwd', 'mfa'],
            name: 'SSO E2E Staff',
            nonce: forgeNonce ? 'forged-nonce' : grant.nonce,
            iat: now,
            exp: now + 600,
          }),
          access_token: 'mock-access-token-never-stored',
        });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  return new Promise((resolve) => idp.listen(IDP_PORT, 'localhost', resolve));
}

/** Idempotent fixtures: verified domain, binding, invited active member. */
async function seedFixtures(): Promise<void> {
  const [org] = await sql<{ id: string }[]>`
    select id from organisations where slug = 'dev-org' limit 1`;
  if (!org) throw new Error('dev-org missing; run pnpm db:seed');
  organisationId = org.id;
  await sql`
    insert into organisation_domains (id, organisation_id, domain, verified)
    values (${randomUUID()}, ${organisationId}, ${DOMAIN}, true)
    on conflict (domain) do update set verified = true`;
  await sql`
    insert into organisation_sso_providers
      (id, organisation_id, provider_key, issuer, client_id, domain, enabled)
    values (${randomUUID()}, ${organisationId}, 'entra', ${ISSUER}, ${CLIENT_ID!}, ${DOMAIN}, false)
    on conflict (organisation_id, provider_key) do update
      set issuer = excluded.issuer, client_id = excluded.client_id,
          domain = excluded.domain, enabled = false`;
  await sql`
    insert into users (id, name, email, email_verified)
    values (${randomUUID()}, 'SSO E2E Staff', ${SSO_EMAIL}, true)
    on conflict do nothing`;
  const [user] = await sql<{ id: string }[]>`
    select id from users where email = ${SSO_EMAIL} limit 1`;
  await sql`
    insert into memberships (id, organisation_id, user_id, status)
    values (${randomUUID()}, ${organisationId}, ${user!.id}, 'active')
    on conflict (organisation_id, user_id) do update set status = 'active'`;
  const [membership] = await sql<{ id: string }[]>`
    select id from memberships
    where organisation_id = ${organisationId} and user_id = ${user!.id}`;
  const [role] = await sql<{ id: string }[]>`
    select id from roles where slug = 'intake-officer' and organisation_id is null`;
  await sql`
    insert into membership_roles (id, membership_id, role_id)
    values (${randomUUID()}, ${membership!.id}, ${role!.id})
    on conflict do nothing`;
  // Staff MFA policy still applies to federated users: the staff shell needs
  // an enrolled factor. Fixture passkey only, like the dev seed's.
  await sql`
    insert into passkeys (id, user_id, name, credential_id, public_key, counter)
    select ${randomUUID()}, ${user!.id}, 'SSO E2E fixture passkey',
           ${`sso-e2e-${user!.id}`}, 'sso-e2e-fixture-passkey', 0
    where not exists (select 1 from passkeys where user_id = ${user!.id})`;
}

async function setBindingEnabled(enabled: boolean): Promise<void> {
  await sql`
    update organisation_sso_providers set enabled = ${enabled}
    where organisation_id = ${organisationId} and provider_key = 'entra'`;
}

async function signInAuditCount(result: string, reasonLike: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from audit_events
    where organisation_id = ${organisationId} and action = 'auth.sign_in'
      and result = ${result} and reason like ${reasonLike}`;
  return row?.n ?? 0;
}

async function startSso(page: Page): Promise<void> {
  await isolateSignInClient(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(SSO_EMAIL);
  await page.getByRole('button', { name: 'Sign in with organisation SSO' }).click();
}

test.beforeAll(async () => {
  sql = postgres(DATABASE_URL!, { max: 2 });
  await seedFixtures();
  await startMockIdp();
});

test.afterAll(async () => {
  await setBindingEnabled(false);
  await new Promise((resolve) => idp.close(resolve));
  await sql.end();
});

test('sso: disabled binding denies with a generic error and an audited denial', async ({
  page,
}) => {
  await setBindingEnabled(false);
  const before = await signInAuditCount('denied', 'sso.binding_disabled:entra');
  await startSso(page);
  await expect(page.getByText(SSO_FAILURE_TEXT)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
  expect(await signInAuditCount('denied', 'sso.binding_disabled:entra')).toBe(before + 1);
});

test('sso: mock IdP sign-in lands in the bound tenant with permissions unchanged', async ({
  page,
}) => {
  await setBindingEnabled(true);
  const before = await signInAuditCount('success', 'sso.sign_in:entra');
  await startSso(page);
  // The staff shell only renders with a session whose active organisation is
  // a verified membership — i.e. the session is scoped to the bound tenant.
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  expect(await signInAuditCount('success', 'sso.sign_in:entra')).toBe(before + 1);

  // Permission checks are unchanged: an intake officer cannot configure SSO.
  const admin = await page.request.get('/api/sso/providers');
  expect(admin.status()).toBe(403);

  // The flow cookie is single-use and IdP tokens are never persisted.
  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name.includes('sso_flow'))).toBe(false);
  const [stored] = await sql<{ n: number }[]>`
    select count(*)::int as n from accounts a join users u on u.id = a.user_id
    where u.email = ${SSO_EMAIL} and a.provider_id like 'sso:%'
      and a.access_token is null and a.id_token is null and a.refresh_token is null`;
  expect(stored?.n).toBe(1);
});

test('sso: an id_token failing verification is denied and audited', async ({ page }) => {
  await setBindingEnabled(true);
  forgeNonce = true;
  try {
    const before = await signInAuditCount('denied', 'sso.verification_failed:entra');
    await startSso(page);
    await expect(page).toHaveURL(/\/sign-in\?error=sso$/);
    await expect(page.getByText(SSO_FAILURE_TEXT)).toBeVisible();
    expect(await signInAuditCount('denied', 'sso.verification_failed:entra')).toBe(
      before + 1,
    );
  } finally {
    forgeNonce = false;
  }
});

test('sso: a callback without the browser-bound flow cookie is refused', async ({
  page,
}) => {
  await page.goto('/api/auth/sso/callback?code=stolen&state=stolen');
  await expect(page).toHaveURL(/\/sign-in\?error=sso$/);
});
