import { describe, expect, it, vi } from 'vitest';
import {
  emailDomain,
  selectSsoBinding,
  type SsoBindingCandidate,
} from '@/domains/sso/sign-in';
import {
  SsoDenied,
  decodeFlowCookie,
  encodeFlowCookie,
  resolveMember,
  ssoAccountProviderId,
  type SsoAccountStore,
} from '@/lib/auth/sso-plugin';

/**
 * Tenant-bound sign-in decisions: binding selection by verified domain and the
 * invite-only mapping from a verified identity to an existing active member.
 */

const binding = {
  id: 'binding-1',
  organisationId: 'org-1',
  providerKey: 'entra',
  issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
  clientId: 'client',
  domain: 'council.example',
};

const candidate = (over: Partial<SsoBindingCandidate> = {}): SsoBindingCandidate => ({
  ...binding,
  enabled: true,
  domainVerified: true,
  ...over,
});

const registered = (key: string) => key === 'entra';

describe('emailDomain', () => {
  it('extracts a lower-cased domain and rejects malformed input', () => {
    expect(emailDomain('Staff@Council.Example')).toBe('council.example');
    expect(emailDomain('a@b@council.example')).toBe('council.example');
    expect(emailDomain('no-at-sign')).toBeNull();
    expect(emailDomain('@council.example')).toBeNull();
    expect(emailDomain('staff@')).toBeNull();
  });
});

describe('selectSsoBinding', () => {
  it('offers nothing when no binding exists for the domain', () => {
    expect(selectSsoBinding([], registered)).toEqual({ kind: 'none' });
  });

  it('selects an enabled binding on a verified domain with a registered provider', () => {
    expect(selectSsoBinding([candidate()], registered)).toEqual({ kind: 'ok', binding });
  });

  it.each([
    [{ domainVerified: false }, 'DOMAIN_UNVERIFIED'],
    [{ enabled: false }, 'BINDING_DISABLED'],
    [{ providerKey: 'google' }, 'PROVIDER_UNAVAILABLE'],
  ] as const)('denies %o as %s, attributed to the organisation', (over, reason) => {
    expect(selectSsoBinding([candidate(over)], registered)).toMatchObject({
      kind: 'denied',
      organisationId: 'org-1',
      bindingId: 'binding-1',
      reason,
    });
  });
});

describe('flow cookie', () => {
  it('round-trips binding id and sealed transaction', () => {
    const value = encodeFlowCookie('binding-1', 'iv.body.tag');
    expect(decodeFlowCookie(value)).toEqual({
      bindingId: 'binding-1',
      transaction: 'iv.body.tag',
    });
    expect(decodeFlowCookie(undefined)).toBeNull();
    expect(decodeFlowCookie('.x')).toBeNull();
  });
});

describe('resolveMember', () => {
  function store(over: Partial<SsoAccountStore> = {}): SsoAccountStore {
    return {
      findAccountByProviderId: vi.fn(async () => null),
      findUserByEmail: vi.fn(async () => ({
        user: { id: 'user-1', emailVerified: true },
      })),
      linkAccount: vi.fn(async () => ({})),
      ...over,
    };
  }
  const identity = { subject: 'sub-1', email: 'Staff@council.example' };
  const member = vi.fn(async () => true);

  async function denial(promise: Promise<unknown>): Promise<string> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SsoDenied);
    return (error as SsoDenied).reason;
  }

  it('links an invited, verified, active member on first sign-in', async () => {
    const accounts = store();
    await expect(
      resolveMember({ accounts, isActiveMember: member }, binding, identity),
    ).resolves.toBe('user-1');
    expect(accounts.linkAccount).toHaveBeenCalledWith({
      userId: 'user-1',
      providerId: ssoAccountProviderId('binding-1'),
      accountId: 'sub-1',
    });
  });

  it('resolves later sign-ins by subject without relinking', async () => {
    const accounts = store({
      findAccountByProviderId: vi.fn(async () => ({ userId: 'user-9' })),
    });
    await expect(
      resolveMember({ accounts, isActiveMember: member }, binding, {
        subject: 'sub-1',
      }),
    ).resolves.toBe('user-9');
    expect(accounts.linkAccount).not.toHaveBeenCalled();
    expect(accounts.findUserByEmail).not.toHaveBeenCalled();
  });

  it('denies an email outside the verified domain', async () => {
    const deps = { accounts: store(), isActiveMember: member };
    expect(
      await denial(
        resolveMember(deps, binding, { subject: 's', email: 'x@attacker.example' }),
      ),
    ).toBe('EMAIL_DOMAIN_MISMATCH');
    expect(
      await denial(
        resolveMember(deps, binding, { subject: 's', email: 'x@evilcouncil.example' }),
      ),
    ).toBe('EMAIL_DOMAIN_MISMATCH');
    expect(await denial(resolveMember(deps, binding, { subject: 's' }))).toBe(
      'EMAIL_DOMAIN_MISMATCH',
    );
  });

  it('never creates accounts: unknown email is denied', async () => {
    const accounts = store({ findUserByEmail: vi.fn(async () => null) });
    expect(
      await denial(
        resolveMember({ accounts, isActiveMember: member }, binding, identity),
      ),
    ).toBe('NO_ACCOUNT');
  });

  it('denies a user who has not verified their email', async () => {
    const accounts = store({
      findUserByEmail: vi.fn(async () => ({ user: { id: 'u', emailVerified: false } })),
    });
    expect(
      await denial(
        resolveMember({ accounts, isActiveMember: member }, binding, identity),
      ),
    ).toBe('EMAIL_UNVERIFIED');
  });

  it('denies without an active membership of the binding organisation, and does not link', async () => {
    const accounts = store();
    const notMember = vi.fn(async () => false);
    expect(
      await denial(
        resolveMember({ accounts, isActiveMember: notMember }, binding, identity),
      ),
    ).toBe('NO_ACTIVE_MEMBERSHIP');
    expect(notMember).toHaveBeenCalledWith('user-1', 'org-1');
    expect(accounts.linkAccount).not.toHaveBeenCalled();
  });
});
