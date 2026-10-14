import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    user: { id: 'user-1', email: 'ada@example.com', emailVerified: true },
    session: { id: 'sess-1' },
  })),
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  StepUpRequiredError: class StepUpRequiredError extends Error {},
}));

vi.mock('@/domains/memberships', () => ({
  createInvitedAccount: vi.fn(async () => ({ userId: 'user-1' })),
  acceptMembershipInvitation: vi.fn(async () => ({ id: 'mem-1' })),
}));

vi.mock('@/domains/forms', () => ({
  FormTokenError: class FormTokenError extends Error {},
  submitPublicResponse: vi.fn(async () => undefined),
}));

vi.mock('@/domains/applications', () => ({
  listApplications: vi.fn(async () => ({ items: [], limit: 20, offset: 0 })),
  // The v1 route validates the query before the key check.
  listApplicationsSchema: { parse: (value: unknown) => value },
}));

vi.mock('@/domains/mcp', () => ({
  handleMcpMessage: vi.fn(async () => ({ jsonrpc: '2.0', id: 1, result: {} })),
  mcpHttpStatus: vi.fn(() => 200),
  hasMcpScope: vi.fn(() => true),
  tenantAiOptedIn: vi.fn(async () => true),
  consumeMcpRateLimit: vi.fn(async () => undefined),
  mcpAuditAfter: vi.fn(() => ({})),
  McpRateLimitError: class McpRateLimitError extends Error {},
}));

vi.mock('@/domains/scim', () => ({
  authenticateScim: vi.fn(),
  provisionScimUser: vi.fn(async () => ({ id: 'scim-1', userName: 'ada@example.com' })),
  setScimUserActive: vi.fn(),
}));

vi.mock('@/domains/email', () => ({
  recordSuppression: vi.fn(),
}));

vi.mock('@/domains/api-keys', async () => {
  const actual = (await vi.importActual('@/domains/api-keys')) as Record<string, unknown>;
  return {
    ...actual,
    resolveApiKeyContext: vi.fn(async (raw: string) => {
      const id = raw.includes('_b_') ? 'key-b' : 'key-a';
      return {
        organisationId: 'org-1',
        userId: id,
        membershipId: id,
        permissions: new Set(),
        roles: ['api-key'],
        sessionId: id,
        correlationId: 'corr-1',
        requestId: 'req-1',
      };
    }),
  };
});

import { createInvitedAccount, acceptMembershipInvitation } from '@/domains/memberships';
import { submitPublicResponse } from '@/domains/forms';
import { listApplications } from '@/domains/applications';
import { handleMcpMessage } from '@/domains/mcp';
import { authenticateScim, provisionScimUser } from '@/domains/scim';
import { resolveApiKeyContext } from '@/domains/api-keys';
import { requireSession } from '@/lib/auth/session';
import { __resetEnvCache } from '@/lib/env';
import {
  createMemoryCounterStore,
  setCounterStore,
  type MemoryCounterStore,
} from '@/lib/http/counter-store';
import { ORIGIN_VERIFY_HEADER } from '@/lib/http/client-ip';
import { REQUEST_LIMITS, counterKey, hashIdentity } from '@/lib/http/request-limits';
import { POST as createAccount } from '@/app/api/membership-invitations/create-account/route';
import { POST as acceptInvite } from '@/app/api/membership-invitations/accept/route';
import { POST as submitForm } from '@/app/api/public/forms/[token]/route';
import { GET as listV1 } from '@/app/api/v1/applications/route';
import { POST as mcp } from '@/app/api/mcp/route';
import { POST as scimCreate } from '@/app/api/scim/v2/[orgId]/Users/route';
import { POST as emailEvents } from '@/app/api/email/events/route';
import { proxy } from '@/proxy';

const createAccountMock = vi.mocked(createInvitedAccount);
const acceptMock = vi.mocked(acceptMembershipInvitation);
const submitMock = vi.mocked(submitPublicResponse);
const listMock = vi.mocked(listApplications);
const mcpMock = vi.mocked(handleMcpMessage);
const scimVerify = vi.mocked(authenticateScim);
const scimProvision = vi.mocked(provisionScimUser);
const resolveKey = vi.mocked(resolveApiKeyContext);
const sessionMock = vi.mocked(requireSession);

let store: MemoryCounterStore;

/** Client addresses count only on requests that carry the origin-verify secret. */
const ORIGIN_SECRET = 'origin-verify-secret-for-rate-limit-tests';

beforeEach(() => {
  store = createMemoryCounterStore();
  setCounterStore(store);
  process.env.EMAIL_WEBHOOK_SECRET = 'webhook-secret-value';
  process.env.ORIGIN_VERIFY_SECRET = ORIGIN_SECRET;
  process.env.EMAIL_SNS_TOPIC_ARN =
    'arn:aws:sns:ap-southeast-2:000000000000:email-events';
  __resetEnvCache();
});

afterEach(() => {
  delete process.env.ORIGIN_VERIFY_SECRET;
  delete process.env.EMAIL_SNS_TOPIC_ARN;
  setCounterStore(undefined);
  vi.clearAllMocks();
});

function post(
  url: string,
  ip: string,
  body: unknown,
  headers?: Record<string, string>,
): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
      [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function saturate(
  scope: string,
  kind: 'ip' | 'token' | 'key',
  identity: string,
  max: number,
  windowSec: number,
): Promise<void> {
  await store.set(counterKey(scope, kind, identity), max, windowSec);
}

describe('endpoint request limits', () => {
  it('returns 429 for create-account past the IP and token limits', async () => {
    const policy = REQUEST_LIMITS.createAccount;
    await saturate(policy.scope, 'ip', '203.0.113.10', policy.ipMax, policy.windowSec);
    const blocked = await createAccount(
      post('http://localhost/api/membership-invitations/create-account', '203.0.113.10', {
        token: 'a'.repeat(24),
        name: 'Ada',
        password: 'correct-horse',
      }),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    expect(createAccountMock).not.toHaveBeenCalled();

    store = createMemoryCounterStore();
    setCounterStore(store);
    const token = 'b'.repeat(24);
    await saturate(
      policy.scope,
      'token',
      hashIdentity(token),
      policy.subjectMax,
      policy.windowSec,
    );
    const tokenBlocked = await createAccount(
      post('http://localhost/api/membership-invitations/create-account', '203.0.113.11', {
        token,
        name: 'Ada',
        password: 'correct-horse',
      }),
    );
    expect(tokenBlocked.status).toBe(429);
    const allowed = await createAccount(
      post('http://localhost/api/membership-invitations/create-account', '203.0.113.11', {
        token: 'c'.repeat(24),
        name: 'Ada',
        password: 'correct-horse',
      }),
    );
    expect(allowed.status).toBe(201);
    expect(createAccountMock).toHaveBeenCalledTimes(1);
  });

  it('returns 429 for invitation accept past the IP and token limits', async () => {
    const policy = REQUEST_LIMITS.invitationAccept;
    await saturate(policy.scope, 'ip', '203.0.113.12', policy.ipMax, policy.windowSec);
    const blocked = await acceptInvite(
      post('http://localhost/api/membership-invitations/accept', '203.0.113.12', {
        token: 'd'.repeat(24),
      }),
    );
    expect(blocked.status).toBe(429);
    expect(sessionMock).not.toHaveBeenCalled();

    store = createMemoryCounterStore();
    setCounterStore(store);
    const token = 'e'.repeat(24);
    await saturate(
      policy.scope,
      'token',
      hashIdentity(token),
      policy.subjectMax,
      policy.windowSec,
    );
    const tokenBlocked = await acceptInvite(
      post('http://localhost/api/membership-invitations/accept', '203.0.113.13', {
        token,
      }),
    );
    expect(tokenBlocked.status).toBe(429);
    expect(acceptMock).not.toHaveBeenCalled();
    const allowed = await acceptInvite(
      post('http://localhost/api/membership-invitations/accept', '203.0.113.13', {
        token: 'f'.repeat(24),
      }),
    );
    expect(allowed.status).toBe(200);
  });

  it('returns 429 for a public form post past the IP and token limits', async () => {
    const policy = REQUEST_LIMITS.publicFormPost;
    await saturate(policy.scope, 'ip', '203.0.113.14', policy.ipMax, policy.windowSec);
    const blocked = await submitForm(
      post('http://localhost/api/public/forms/tok-a', '203.0.113.14', { answers: {} }),
      { params: Promise.resolve({ token: 'tok-a' }) },
    );
    expect(blocked.status).toBe(429);
    expect(submitMock).not.toHaveBeenCalled();

    store = createMemoryCounterStore();
    setCounterStore(store);
    await saturate(
      policy.scope,
      'token',
      hashIdentity('tok-a'),
      policy.subjectMax,
      policy.windowSec,
    );
    const tokenBlocked = await submitForm(
      post('http://localhost/api/public/forms/tok-a', '203.0.113.15', { answers: {} }),
      { params: Promise.resolve({ token: 'tok-a' }) },
    );
    expect(tokenBlocked.status).toBe(429);
    const allowed = await submitForm(
      post('http://localhost/api/public/forms/tok-b', '203.0.113.15', { answers: {} }),
      { params: Promise.resolve({ token: 'tok-b' }) },
    );
    expect(allowed.status).toBe(200);
  });

  it('returns 429 for form and verify pages from the proxy', async () => {
    const form = REQUEST_LIMITS.formPage;
    await saturate(form.scope, 'ip', '203.0.113.16', form.ipMax, form.windowSec);
    const blocked = await proxy(
      new NextRequest('http://localhost/form/page-token', {
        headers: {
          'cf-connecting-ip': '203.0.113.16',
          [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
        },
      }),
    );
    expect(blocked.status).toBe(429);

    store = createMemoryCounterStore();
    setCounterStore(store);
    await saturate(
      form.scope,
      'token',
      hashIdentity('page-token'),
      form.subjectMax,
      form.windowSec,
    );
    const tokenBlocked = await proxy(
      new NextRequest('http://localhost/form/page-token', {
        headers: {
          'cf-connecting-ip': '203.0.113.17',
          [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
        },
      }),
    );
    expect(tokenBlocked.status).toBe(429);
    const other = await proxy(
      new NextRequest('http://localhost/form/other-token', {
        headers: {
          'cf-connecting-ip': '203.0.113.17',
          [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
        },
      }),
    );
    expect(other.status).toBe(200);

    const verify = REQUEST_LIMITS.verifyPage;
    await saturate(
      verify.scope,
      'token',
      hashIdentity('CERT1'),
      verify.subjectMax,
      verify.windowSec,
    );
    const codeBlocked = await proxy(
      new NextRequest('http://localhost/verify/CERT1', {
        headers: {
          'cf-connecting-ip': '203.0.113.18',
          [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
        },
      }),
    );
    expect(codeBlocked.status).toBe(429);
    const codeAllowed = await proxy(
      new NextRequest('http://localhost/verify/CERT2', {
        headers: {
          'cf-connecting-ip': '203.0.113.18',
          [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
        },
      }),
    );
    expect(codeAllowed.status).toBe(200);
  });

  it('returns 429 for v1 and mcp past the IP limit and past the key id', async () => {
    const api = REQUEST_LIMITS.api;
    await saturate(api.scope, 'ip', '203.0.113.20', api.ipMax, api.windowSec);
    const ipBlocked = await listV1(
      new NextRequest('http://localhost/api/v1/applications', {
        headers: {
          authorization: 'Bearer bp_key_a_0123456789',
          'cf-connecting-ip': '203.0.113.20',
          [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
        },
      }),
    );
    expect(ipBlocked.status).toBe(429);
    expect(resolveKey).not.toHaveBeenCalled();

    store = createMemoryCounterStore();
    setCounterStore(store);
    await saturate(api.scope, 'key', 'key-a', api.subjectMax, api.windowSec);
    const keyBlocked = await listV1(
      new NextRequest('http://localhost/api/v1/applications', {
        headers: {
          authorization: 'Bearer bp_key_a_0123456789',
          'cf-connecting-ip': '203.0.113.21',
          [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
        },
      }),
    );
    expect(keyBlocked.status).toBe(429);
    expect(listMock).not.toHaveBeenCalled();
    expect(store.keys().join(' ')).not.toContain('bp_key_a_0123456789');

    const otherKey = await listV1(
      new NextRequest('http://localhost/api/v1/applications', {
        headers: {
          authorization: 'Bearer bp_key_b_0123456789',
          'cf-connecting-ip': '203.0.113.21',
          [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
        },
      }),
    );
    expect(otherKey.status).toBe(200);

    const mcpPolicy = REQUEST_LIMITS.mcp;
    await saturate(
      mcpPolicy.scope,
      'key',
      'key-a',
      mcpPolicy.subjectMax,
      mcpPolicy.windowSec,
    );
    const mcpBlocked = await mcp(
      post(
        'http://localhost/api/mcp',
        '203.0.113.22',
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        {
          authorization: 'Bearer bp_key_a_0123456789',
        },
      ),
    );
    expect(mcpBlocked.status).toBe(429);
    expect(mcpMock).not.toHaveBeenCalled();
    const mcpAllowed = await mcp(
      post(
        'http://localhost/api/mcp',
        '203.0.113.22',
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        {
          authorization: 'Bearer bp_key_b_0123456789',
        },
      ),
    );
    expect(mcpAllowed.status).toBe(200);
  });

  it('returns 429 for scim past the IP and bearer limits', async () => {
    const policy = REQUEST_LIMITS.scim;
    await saturate(policy.scope, 'ip', '203.0.113.30', policy.ipMax, policy.windowSec);
    const blocked = await scimCreate(
      post(
        'http://localhost/api/scim/v2/org-1/Users',
        '203.0.113.30',
        { userName: 'ada@example.com' },
        { authorization: 'Bearer scim-secret-value' },
      ),
      { params: Promise.resolve({ orgId: 'org-1' }) },
    );
    expect(blocked.status).toBe(429);
    expect(scimVerify).not.toHaveBeenCalled();

    store = createMemoryCounterStore();
    setCounterStore(store);
    await saturate(
      policy.scope,
      'token',
      hashIdentity('scim-secret-value'),
      policy.subjectMax,
      policy.windowSec,
    );
    const tokenBlocked = await scimCreate(
      post(
        'http://localhost/api/scim/v2/org-1/Users',
        '203.0.113.31',
        { userName: 'ada@example.com' },
        { authorization: 'Bearer scim-secret-value' },
      ),
      { params: Promise.resolve({ orgId: 'org-1' }) },
    );
    expect(tokenBlocked.status).toBe(429);
    expect(scimProvision).not.toHaveBeenCalled();
    const allowed = await scimCreate(
      post(
        'http://localhost/api/scim/v2/org-1/Users',
        '203.0.113.31',
        { userName: 'ada@example.com' },
        { authorization: 'Bearer other-scim-secret' },
      ),
      { params: Promise.resolve({ orgId: 'org-1' }) },
    );
    expect(allowed.status).toBe(201);
  });

  it('returns 429 for email events past the IP and secret limits', async () => {
    const policy = REQUEST_LIMITS.emailEvents;
    await saturate(policy.scope, 'ip', '203.0.113.40', policy.ipMax, policy.windowSec);
    const blocked = await emailEvents(
      post(
        'http://localhost/api/email/events?secret=webhook-secret-value',
        '203.0.113.40',
        { Type: 'Notification' },
      ),
    );
    expect(blocked.status).toBe(429);

    store = createMemoryCounterStore();
    setCounterStore(store);
    await saturate(
      policy.scope,
      'token',
      hashIdentity('webhook-secret-value'),
      policy.subjectMax,
      policy.windowSec,
    );
    const secretBlocked = await emailEvents(
      new NextRequest('http://localhost/api/email/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.41',
          [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
          'x-email-webhook-secret': 'webhook-secret-value',
        },
        body: JSON.stringify({ Type: 'Notification' }),
      }),
    );
    expect(secretBlocked.status).toBe(429);
    const other = await emailEvents(
      new NextRequest(
        'http://localhost/api/email/events?secret=different-webhook-secret',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': '203.0.113.41',
            [ORIGIN_VERIFY_HEADER]: ORIGIN_SECRET,
          },
          body: JSON.stringify({ Type: 'Notification' }),
        },
      ),
    );
    expect(other.status).toBe(403);
  });
});
