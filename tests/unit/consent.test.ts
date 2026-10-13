import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_ID, USER_ID, tenantContext } from './helpers/tenant';
import { script } from './helpers/scripted-db';

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));

vi.mock('@/db/tenant-db', async () => {
  const { scriptedTenantModule } = await import('./helpers/scripted-db');
  const { ORG_ID: orgId } = await import('./helpers/tenant');
  return scriptedTenantModule(orgId);
});

vi.mock('@/domains/audit/service', () => ({
  recordAudit: audit.recordAudit,
}));

const { recordConsent, withdrawConsent, listConsents, hasLiveConsent } =
  await import('@/domains/consent');
const { consentRecords } = await import('@/db/schema');
const { AuthorizationError } = await import('@/lib/permissions/errors');
const { TenantContextError, runWithTenantContext } =
  await import('@/lib/tenancy/context');

const SUBJECT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  script.reset();
  audit.recordAudit.mockClear();
});

describe('consent', () => {
  it('refuses to record a grant with no tenant context or no intake permission', async () => {
    await expect(
      recordConsent({ subjectUserId: SUBJECT, purpose: 'representative-access' }),
    ).rejects.toBeInstanceOf(TenantContextError);

    await expect(
      runWithTenantContext(tenantContext([]), () =>
        recordConsent({ subjectUserId: SUBJECT, purpose: 'representative-access' }),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(script.ops).toEqual([]);
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('records an explicit grant and nothing that decides identity', async () => {
    script.results.push([{ id: 'consent-1', status: 'granted' }]);

    const row = await runWithTenantContext(tenantContext(['application:create']), () =>
      recordConsent({
        subjectUserId: SUBJECT,
        purpose: '  representative-access  ',
        notes: 'Spoken consent at intake',
      }),
    );

    expect(row).toMatchObject({ id: 'consent-1', status: 'granted' });
    expect(script.ops).toEqual(['insert']);
    expect(script.writes[0]?.payload).toMatchObject({
      organisationId: ORG_ID,
      subjectUserId: SUBJECT,
      recordedByUserId: USER_ID,
      purpose: 'representative-access',
      status: 'granted',
      notes: 'Spoken consent at intake',
    });
    expect(script.writes[0]?.payload).not.toHaveProperty('score');
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'consent.recorded', result: 'success' }),
    );
    expect(script.wheres).toEqual([]);
  });

  it('rejects a blank purpose before writing', async () => {
    await expect(
      runWithTenantContext(tenantContext(['application:update-intake']), () =>
        recordConsent({ subjectUserId: SUBJECT, purpose: '   ' }),
      ),
    ).rejects.toThrow();
    expect(script.ops).toEqual([]);
  });

  it('withdraws a grant and hides a missing row as a generic refusal', async () => {
    script.results.push([]);
    await expect(
      runWithTenantContext(tenantContext(['application:assign']), () =>
        withdrawConsent('missing'),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      runWithTenantContext(tenantContext(['application:assign']), () =>
        withdrawConsent('missing'),
      ),
    ).rejects.toThrow(/permission/i);

    script.results.push([{ id: 'consent-1', status: 'withdrawn' }]);
    await expect(
      runWithTenantContext(tenantContext(['application:assign']), () =>
        withdrawConsent('consent-1'),
      ),
    ).resolves.toMatchObject({ status: 'withdrawn' });
    expect(script.writes.at(-1)?.payload).toMatchObject({ status: 'withdrawn' });
    expect(script.wheres[0]).toBe(consentRecords.organisationId);
  });

  it('lists grants and reports whether a live grant is on file', async () => {
    script.results.push([{ id: 'consent-1', purpose: 'representative-access' }]);
    await expect(
      runWithTenantContext(tenantContext(['application:read-assigned']), () =>
        listConsents(SUBJECT),
      ),
    ).resolves.toEqual([{ id: 'consent-1', purpose: 'representative-access' }]);

    script.results.push([]);
    await expect(
      runWithTenantContext(tenantContext(['application:read-any']), () =>
        hasLiveConsent(SUBJECT, 'representative-access'),
      ),
    ).resolves.toBe(false);

    script.results.push([{ id: 'consent-1' }]);
    await expect(
      runWithTenantContext(tenantContext(['application:read-any']), () =>
        hasLiveConsent(SUBJECT, 'representative-access'),
      ),
    ).resolves.toBe(true);
  });
});
