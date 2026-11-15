import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_ID, USER_ID, tenantContext } from './helpers/tenant';
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

// Field sealing is covered by tenant-fields tests. Here it is a visible
// passthrough so the service's own writes can be asserted.
const sealing = vi.hoisted(() => ({
  sealWordingSnapshot: vi.fn(
    async (organisationId: string, _rowId: string, wording: unknown) =>
      wording === null ? null : `sealed:${organisationId}:${JSON.stringify(wording)}`,
  ),
  openConsentRows: vi.fn(async (_organisationId: string, rows: readonly unknown[]) => [
    ...rows,
  ]),
}));

vi.mock('@/lib/encryption/tenant-fields', () => sealing);

const { recordConsent, withdrawConsent, listConsents, hasLiveConsent } =
  await import('@/domains/consent');
const { consentRecords } = await import('@/db/schema');
const { AuthorizationError } = await import('@/lib/permissions/errors');
const { TenantContextError, runWithTenantContext } =
  await import('@/lib/tenancy/context');

const SUBJECT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-0000000000ee';
const asApplicant = <T>(fn: () => Promise<T>) =>
  runWithTenantContext(
    { ...tenantContext(['application:create']), roles: ['applicant'] },
    fn,
  );

beforeEach(() => {
  script.reset();
  audit.recordAudit.mockClear();
  trackAudit(audit.recordAudit);
  sealing.sealWordingSnapshot.mockClear();
  sealing.openConsentRows.mockClear();
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
    script.results.push(
      [], // no tenant consent wording configured
      [{ id: 'consent-1', status: 'granted', wordingSnapshot: null }],
    );

    const row = await runWithTenantContext(tenantContext(['application:create']), () =>
      recordConsent({
        subjectUserId: SUBJECT,
        purpose: '  representative-access  ',
        notes: 'Spoken consent at intake',
      }),
    );

    expect(row).toMatchObject({ id: 'consent-1', status: 'granted' });
    expect(script.ops).toEqual(['select', 'insert']);
    expect(script.writes[0]?.payload).toMatchObject({
      organisationId: ORG_ID,
      subjectUserId: SUBJECT,
      recordedByUserId: USER_ID,
      purpose: 'representative-access',
      status: 'granted',
      notes: 'Spoken consent at intake',
      wordingSnapshot: null,
    });
    expect(script.writes[0]?.payload).not.toHaveProperty('score');
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'consent.recorded', result: 'success' }),
      expect.anything(),
    );
    expectAuditedInTransaction('consent.recorded');
    expect(script.wheres).toEqual([]);
  });

  it('snapshots the tenant consent wording sealed to the new row', async () => {
    const wording = { version: 2, text: 'I agree to share my records.' };
    script.results.push(
      [{ consentWording: wording }],
      [{ id: 'consent-2', status: 'granted', wordingSnapshot: 'sealed' }],
    );

    await runWithTenantContext(tenantContext(['application:create']), () =>
      recordConsent({ subjectUserId: SUBJECT, purpose: 'representative-access' }),
    );

    const payload = script.writes[0]?.payload as { id: string; wordingSnapshot: unknown };
    expect(sealing.sealWordingSnapshot).toHaveBeenCalledWith(ORG_ID, payload.id, wording);
    expect(payload.wordingSnapshot).toBe(`sealed:${ORG_ID}:${JSON.stringify(wording)}`);
    expect(sealing.openConsentRows).toHaveBeenCalledWith(ORG_ID, [
      expect.objectContaining({ id: 'consent-2' }),
    ]);
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

describe('applicant-only callers', () => {
  it('refuses to record consent in another person name before any query', async () => {
    await expect(
      asApplicant(() =>
        recordConsent({ subjectUserId: OTHER, purpose: 'representative-access' }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(script.ops).toEqual([]);
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'consent.recorded',
        result: 'denied',
        reason: 'consent.subject_not_self',
      }),
    );
  });

  it('records consent about themselves', async () => {
    script.results.push(
      [],
      [{ id: 'consent-9', status: 'granted', wordingSnapshot: null }],
    );
    await expect(
      asApplicant(() =>
        recordConsent({ subjectUserId: USER_ID, purpose: 'representative-access' }),
      ),
    ).resolves.toMatchObject({ id: 'consent-9', status: 'granted' });
    expect(script.ops).toEqual(['select', 'insert']);
    expect(script.writes[0]?.payload).toMatchObject({
      subjectUserId: USER_ID,
      recordedByUserId: USER_ID,
    });
  });

  it('refuses to list another person consent', async () => {
    await expect(asApplicant(() => listConsents(OTHER))).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(script.ops).toEqual([]);
  });

  it('lists their own consent', async () => {
    script.results.push([{ id: 'consent-1', subjectUserId: USER_ID }]);
    await expect(asApplicant(() => listConsents(USER_ID))).resolves.toEqual([
      { id: 'consent-1', subjectUserId: USER_ID },
    ]);
  });

  it('refuses to withdraw another person consent without updating', async () => {
    script.results.push([{ subjectUserId: OTHER }]);
    await expect(asApplicant(() => withdrawConsent('consent-1'))).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(script.ops).toEqual(['select']);
  });

  it('refuses a missing record the same way as a foreign one', async () => {
    script.results.push([]);
    await expect(asApplicant(() => withdrawConsent('missing'))).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(script.ops).toEqual(['select']);
  });

  it('withdraws their own consent', async () => {
    script.results.push(
      [{ subjectUserId: USER_ID }],
      [{ id: 'consent-1', status: 'withdrawn' }],
    );
    await expect(asApplicant(() => withdrawConsent('consent-1'))).resolves.toMatchObject({
      status: 'withdrawn',
    });
    expect(script.ops).toEqual(['select', 'update']);
  });

  it('leaves staff able to read consent for any person', async () => {
    script.results.push([{ id: 'consent-1', subjectUserId: OTHER }]);
    await expect(
      runWithTenantContext(tenantContext(['application:update-intake']), () =>
        listConsents(OTHER),
      ),
    ).resolves.toEqual([{ id: 'consent-1', subjectUserId: OTHER }]);
  });
});
