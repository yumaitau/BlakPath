import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAuditedInTransaction, script, trackAudit } from './helpers/scripted-db';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000ab';
const ROLE = '00000000-0000-4000-8000-000000000010';

const audit = vi.hoisted(() => ({
  recordAudit: vi.fn(async (_input: unknown, _tx?: unknown) => undefined),
}));

vi.mock('@/db/client', async () => {
  const { scriptedDatabase } = await import('./helpers/scripted-db');
  return { db: scriptedDatabase() };
});

vi.mock('@/domains/audit/service', () => ({
  recordAudit: audit.recordAudit,
}));

const { authenticateScim, provisionScimUser, setScimUserActive } =
  await import('@/domains/scim');
const { AuthorizationError } = await import('@/lib/permissions/errors');

const principal = {
  organisationId: ORG,
  credentialId: 'credential-1',
  allowOrganisationAdmin: false,
} as const;

function auditActions(): string[] {
  return audit.recordAudit.mock.calls.map(
    (call) => (call as unknown as [{ action: string }])[0].action,
  );
}

beforeEach(() => {
  script.reset();
  audit.recordAudit.mockClear();
  trackAudit(audit.recordAudit);
});

describe('SCIM bearer', () => {
  it('denies a missing, mis-cased or non-SCIM bearer before any lookup', async () => {
    for (const authorization of [
      undefined,
      'Basic abc',
      'Bearer not-a-scim-token-value-padded-000',
    ]) {
      const request = new Request(`https://council.example/scim/${ORG}/Users`, {
        headers: authorization ? { authorization } : {},
      });
      await expect(authenticateScim(request, ORG)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    }
    expect(script.ops).toEqual([]);
  });
});

describe('SCIM provisioning', () => {
  it('refuses a path organisation that is not the credential organisation', async () => {
    await expect(
      provisionScimUser(principal, OTHER_ORG, { userName: 'staff@council.example' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      setScimUserActive(principal, OTHER_ORG, 'staff@council.example', true),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(script.ops).toEqual([]);
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('rejects a payload that is not a user before any write', async () => {
    await expect(
      provisionScimUser(principal, ORG, { userName: 'not-an-email' }),
    ).rejects.toThrow();
    expect(script.ops).toEqual([]);
  });

  it('creates a suspended membership and ignores groups outside the role allowlist', async () => {
    script.results.push(
      [], // user lookup (a new user has no membership to look up)
      [], // user insert, inside the provisioning transaction
      [], // membership insert
      [{ id: ROLE, slug: 'intake-officer' }], // tenant roles
      [], // current SCIM-managed roles
      [], // role insert
      [{ id: 'session-1' }], // sessions deleted on suspend
    );

    const created = await provisionScimUser(principal, ORG, {
      userName: 'Staff@Council.Example',
      active: false,
      name: { formatted: '  Staff Member  ' },
      groups: [{ display: 'Platform Owner' }, { display: 'intake-officer' }],
    });

    expect(created).toMatchObject({ userName: 'staff@council.example', active: false });
    const inserts = script.writes.filter((write) => write.op === 'values');
    expect(inserts).toHaveLength(3);
    expect(inserts[0]?.payload).toMatchObject({
      email: 'staff@council.example',
      name: 'Staff Member',
      emailVerified: true,
    });
    expect(inserts[1]?.payload).toMatchObject({
      organisationId: ORG,
      status: 'suspended',
    });
    // Only the allowlisted slug becomes a role. Platform Owner is not a slug.
    expect(inserts[2]?.payload).toMatchObject({ roleId: ROLE });
    expect(script.ops).toEqual([
      'select',
      'insert',
      'insert',
      'select',
      'select',
      'insert',
      'delete',
    ]);
    expect(auditActions()).toEqual([
      'membership.role_assigned',
      'session.revoked',
      'membership.invitation_accepted',
    ]);
    expect(audit.recordAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'scim.provision', organisationId: ORG }),
      expect.anything(),
    );
    // The user, membership, roles and every audit row commit or roll back together.
    expect(script.audits.every((entry) => entry.inTransaction)).toBe(true);
    expect(new Set(script.audits.map((entry) => entry.tx)).size).toBe(1);
  });

  it('maps an allowlisted group onto an existing tenant role and no other role', async () => {
    script.results.push(
      [{ id: 'user-1' }],
      [{ id: 'membership-1', status: 'active' }],
      [], // membership status update
      [{ id: ROLE, slug: 'intake-officer' }],
      [],
      [],
    );

    await provisionScimUser(principal, ORG, {
      userName: 'staff@council.example',
      groups: [{ display: 'intake-officer' }, { display: 'super-admin' }],
    });

    expect(script.writes.filter((write) => write.op === 'set')[0]?.payload).toMatchObject(
      { status: 'active' },
    );
    const roleWrites = script.writes.filter((write) => write.op === 'values');
    expect(roleWrites).toHaveLength(1);
    expect(roleWrites[0]?.payload).toMatchObject({
      membershipId: 'membership-1',
      roleId: ROLE,
    });
    // Active stays active: no sessions are ended and no status change is audited.
    expect(script.ops).not.toContain('delete');
    expect(auditActions()).toEqual(['membership.role_assigned']);
    expectAuditedInTransaction('membership.role_assigned');
  });

  it('never reactivates a revoked membership', async () => {
    script.results.push([{ id: 'user-1' }], [{ id: 'membership-1', status: 'revoked' }]);

    await expect(
      provisionScimUser(principal, ORG, { userName: 'staff@council.example' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(script.ops).toEqual(['select', 'select']);
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'membership.reinstated', result: 'denied' }),
    );
  });

  it('suspends and restores by email, and refuses an unknown user', async () => {
    script.results.push([]);
    await expect(
      setScimUserActive(principal, ORG, 'missing@council.example', false),
    ).rejects.toBeInstanceOf(AuthorizationError);

    script.results.push([{ id: 'user-1' }], []);
    await expect(
      setScimUserActive(principal, ORG, 'Staff@Council.Example', false),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(script.writes).toEqual([]);

    script.results.push(
      [{ id: 'user-1' }],
      [{ id: 'membership-1', status: 'suspended' }],
    );
    await setScimUserActive(principal, ORG, 'staff@council.example', true);
    expect(script.writes.at(-1)?.payload).toMatchObject({ status: 'active' });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'membership.reinstated', reason: 'scim' }),
      expect.anything(),
    );
    expectAuditedInTransaction('membership.reinstated');
  });
});
