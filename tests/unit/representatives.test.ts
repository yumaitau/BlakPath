import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_ID, tenantContext } from './helpers/tenant';
import { expectAuditedInTransaction, script, trackAudit } from './helpers/scripted-db';

const audit = vi.hoisted(() => ({
  recordAudit: vi.fn(async (_input: unknown, _tx?: unknown) => undefined),
}));

vi.mock('@/db/tenant-db', async () => {
  const { scriptedTenantModule } = await import('./helpers/scripted-db');
  const { ORG_ID: orgId } = await import('./helpers/tenant');
  return scriptedTenantModule(orgId);
});

vi.mock('@/domains/audit/service', () => ({
  recordAudit: audit.recordAudit,
}));

const {
  requestRepresentativeAccess,
  activateRepresentativeAccess,
  revokeRepresentativeAccess,
} = await import('@/domains/representatives');
const { AuthorizationError } = await import('@/lib/permissions/errors');
const { runWithTenantContext } = await import('@/lib/tenancy/context');

const SUBJECT = '00000000-0000-4000-8000-000000000001';
const REP = '00000000-0000-4000-8000-000000000002';
const CONSENT = '00000000-0000-4000-8000-000000000003';
const AUTH_ID = '00000000-0000-4000-8000-000000000004';

const request = {
  subjectUserId: SUBJECT,
  representativeUserId: REP,
  purpose: 'Help with the form',
  consentRecordId: CONSENT,
};

function asIntake<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(tenantContext(['application:create']), fn);
}

beforeEach(() => {
  script.reset();
  audit.recordAudit.mockClear();
  trackAudit(audit.recordAudit);
});

describe('representative access', () => {
  it('refuses a person authorising themselves, before any consent lookup', async () => {
    await expect(
      asIntake(() =>
        requestRepresentativeAccess({
          ...request,
          representativeUserId: SUBJECT,
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(script.ops).toEqual([]);
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('refuses the request when consent is missing, revoked, or expired', async () => {
    script.results.push([]);
    await expect(
      asIntake(() => requestRepresentativeAccess(request)),
    ).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });

    script.results.push([{ id: CONSENT }], [{ revokedAt: new Date(), expiresAt: null }]);
    await expect(
      asIntake(() => requestRepresentativeAccess(request)),
    ).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });

    script.results.push(
      [{ id: CONSENT }],
      [{ revokedAt: null, expiresAt: new Date(Date.now() - 1_000) }],
    );
    await expect(
      asIntake(() => requestRepresentativeAccess(request)),
    ).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });

    expect(script.ops.filter((op) => op === 'insert')).toEqual([]);
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'representative.requested', result: 'denied' }),
    );
  });

  it('stores a pending authorisation and does not activate it', async () => {
    script.results.push(
      [{ id: CONSENT }],
      [{ revokedAt: null, expiresAt: null }],
      [{ id: AUTH_ID, status: 'pending' }],
    );

    const row = await asIntake(() => requestRepresentativeAccess(request));

    expect(row).toMatchObject({ id: AUTH_ID, status: 'pending' });
    expect(script.writes[0]?.payload).toMatchObject({
      organisationId: ORG_ID,
      subjectUserId: SUBJECT,
      representativeUserId: REP,
      status: 'pending',
      consentRecordId: CONSENT,
    });
    expect(script.writes[0]?.payload).not.toMatchObject({ status: 'active' });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'representative.requested',
        resourceId: AUTH_ID,
        result: 'success',
      }),
      expect.anything(),
    );
    expectAuditedInTransaction('representative.requested');
  });

  it('activates only a pending row that still has live consent', async () => {
    const pending = {
      id: AUTH_ID,
      organisationId: ORG_ID,
      status: 'pending',
      consentRecordId: CONSENT,
      subjectUserId: SUBJECT,
    };
    script.results.push([{ ...pending, status: 'active' }]);
    await expect(
      asIntake(() => activateRepresentativeAccess(AUTH_ID)),
    ).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });

    script.results.push([pending], []);
    await expect(
      asIntake(() => activateRepresentativeAccess(AUTH_ID)),
    ).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'representative.activated',
        result: 'denied',
        reason: 'representative.consent_lapsed',
      }),
    );

    script.results.push(
      [pending],
      [{ id: CONSENT }],
      [{ revokedAt: null, expiresAt: null }],
      [{ id: AUTH_ID, status: 'active' }],
    );
    await expect(
      asIntake(() => activateRepresentativeAccess(AUTH_ID)),
    ).resolves.toMatchObject({
      status: 'active',
    });
    expect(script.writes.at(-1)?.payload).toMatchObject({ status: 'active' });
  });

  it('does not activate a row from another organisation', async () => {
    script.results.push([
      {
        id: AUTH_ID,
        organisationId: '00000000-0000-4000-8000-000000000099',
        status: 'pending',
        consentRecordId: CONSENT,
        subjectUserId: SUBJECT,
      },
    ]);
    await expect(asIntake(() => activateRepresentativeAccess(AUTH_ID))).rejects.toThrow(
      /tenant scope/,
    );
  });

  it('revokes an authorisation and refuses a row the tenant does not own', async () => {
    script.results.push([]);
    await expect(
      asIntake(() => revokeRepresentativeAccess(AUTH_ID)),
    ).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });

    script.results.push([{ id: AUTH_ID, status: 'revoked' }]);
    await expect(
      asIntake(() => revokeRepresentativeAccess(AUTH_ID)),
    ).resolves.toMatchObject({
      status: 'revoked',
    });
    expect(script.writes.at(-1)?.payload).toMatchObject({ status: 'revoked' });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'representative.revoked', result: 'success' }),
      expect.anything(),
    );
    expectAuditedInTransaction('representative.revoked');
  });
});
