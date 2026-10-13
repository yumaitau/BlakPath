import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetEnvCache } from '@/lib/env';
import { script } from './helpers/scripted-db';

const TOKEN = 'scim-test-token-must-be-32-characters';
const ORG = '00000000-0000-4000-8000-0000000000aa';

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));

vi.mock('@/db/client', async () => {
  const { scriptedDatabase } = await import('./helpers/scripted-db');
  return { db: scriptedDatabase() };
});

vi.mock('@/domains/audit/service', () => ({
  recordAudit: audit.recordAudit,
}));

const { provisionScimUser, setScimUserActive, verifyScimBearer } =
  await import('@/domains/scim');
const { AuthorizationError } = await import('@/lib/permissions/errors');

function request(authorization?: string): Request {
  return new Request('https://council.example/scim/Users', {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  script.reset();
  audit.recordAudit.mockClear();
  process.env.SCIM_BEARER_TOKEN = TOKEN;
  __resetEnvCache();
});

describe('SCIM bearer', () => {
  it('denies every request when SCIM is off or the bearer does not match', () => {
    delete process.env.SCIM_BEARER_TOKEN;
    __resetEnvCache();
    expect(() => verifyScimBearer(request(`Bearer ${TOKEN}`))).toThrow(
      AuthorizationError,
    );

    process.env.SCIM_BEARER_TOKEN = TOKEN;
    __resetEnvCache();
    expect(() => verifyScimBearer(request())).toThrow(AuthorizationError);
    expect(() => verifyScimBearer(request(`bearer ${TOKEN}`))).toThrow(
      AuthorizationError,
    );
    expect(() =>
      verifyScimBearer(request('Bearer wrong-token-value-padded-0000')),
    ).toThrow(AuthorizationError);
    expect(() => verifyScimBearer(request(`Bearer ${TOKEN}`))).not.toThrow();
  });
});

describe('SCIM provisioning', () => {
  it('rejects a payload that is not a user before any write', async () => {
    await expect(provisionScimUser(ORG, { userName: 'not-an-email' })).rejects.toThrow();
    expect(script.ops).toEqual([]);
  });

  it('refuses to provision into an organisation that is not active', async () => {
    script.results.push([{ id: ORG, status: 'suspended' }]);
    await expect(
      provisionScimUser(ORG, { userName: 'staff@council.example' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(script.ops).toEqual(['select']);
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('creates a suspended membership and ignores groups outside the role allowlist', async () => {
    script.results.push([{ id: ORG, status: 'active' }], [], [], [], []);

    const created = await provisionScimUser(ORG, {
      userName: 'Staff@Council.Example',
      active: false,
      name: { formatted: '  Staff Member  ' },
      groups: [{ display: 'Platform Owner' }, { display: 'intake-officer' }],
    });

    expect(created.userName).toBe('staff@council.example');
    const userInsert = script.writes.find(
      (write) =>
        write.op === 'values' &&
        typeof write.payload === 'object' &&
        write.payload !== null &&
        'email' in write.payload,
    );
    expect(userInsert?.payload).toMatchObject({
      email: 'staff@council.example',
      name: 'Staff Member',
      emailVerified: true,
    });
    const membershipInsert = script.writes.find(
      (write) =>
        write.op === 'values' &&
        typeof write.payload === 'object' &&
        write.payload !== null &&
        'status' in write.payload,
    );
    expect(membershipInsert?.payload).toMatchObject({
      organisationId: ORG,
      status: 'suspended',
    });
    // intake-officer is allowlisted, so roles are loaded. Platform Owner is not a slug.
    expect(script.ops).toEqual([
      'select',
      'select',
      'insert',
      'select',
      'insert',
      'select',
    ]);
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'scim provision', organisationId: ORG }),
    );
  });

  it('maps an allowlisted group onto an existing tenant role and no other role', async () => {
    const roleId = '00000000-0000-4000-8000-000000000010';
    script.results.push(
      [{ id: ORG, status: 'active' }],
      [{ id: 'user-1' }],
      [{ id: 'membership-1' }],
      [],
      [{ id: roleId, slug: 'intake-officer' }],
      [],
    );

    await provisionScimUser(ORG, {
      userName: 'staff@council.example',
      groups: [{ display: 'intake-officer' }, { display: 'super-admin' }],
    });

    expect(script.writes.filter((write) => write.op === 'set')[0]?.payload).toMatchObject(
      {
        status: 'active',
      },
    );
    const roleWrite = script.writes.filter((write) => write.op === 'values').at(-1);
    expect(roleWrite?.payload).toMatchObject({ membershipId: 'membership-1', roleId });
    expect(script.writes.filter((write) => write.op === 'values')).toHaveLength(1);
  });

  it('suspends and restores by email, and refuses an unknown user', async () => {
    script.results.push([]);
    await expect(
      setScimUserActive(ORG, 'missing@council.example', false),
    ).rejects.toBeInstanceOf(AuthorizationError);

    script.results.push([{ id: 'user-1' }], []);
    await expect(
      setScimUserActive(ORG, 'Staff@Council.Example', false),
    ).rejects.toBeInstanceOf(AuthorizationError);

    script.results.push([{ id: 'user-1' }], [{ id: 'membership-1' }]);
    await setScimUserActive(ORG, 'staff@council.example', true);
    expect(script.writes.at(-1)?.payload).toMatchObject({ status: 'active' });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'membership.reinstated', reason: 'scim' }),
    );
  });
});
