import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Consent ledger service, against a scripted in-memory query chain. Each
 * awaited query takes the next queued result; inserts and updates are captured
 * so the tests can prove the ledger is only ever appended to.
 */
const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  ctx: {
    organisationId: 'org-a',
    userId: 'staff-1',
    permissions: new Set<string>(),
  },
  audit: vi.fn(async (..._args: unknown[]) => ({})),
}));

vi.mock('@/db/tenant-db', () => {
  function chain() {
    const builder: Record<string, unknown> = {};
    const passthrough = () => builder;
    for (const method of ['from', 'where', 'orderBy', 'limit', 'for']) {
      builder[method] = passthrough;
    }
    builder.values = (values: Record<string, unknown>) => {
      state.inserts.push(values);
      return builder;
    };
    builder.set = (values: Record<string, unknown>) => {
      state.updates.push(values);
      return builder;
    };
    builder.returning = () => Promise.resolve(state.results.shift() ?? []);
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(state.results.shift() ?? []).then(resolve, reject);
    return builder;
  }
  const db = {
    select: () => chain(),
    insert: () => chain(),
    update: () => chain(),
    delete: () => {
      throw new Error('consent ledger must never delete');
    },
    transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  const scope = {
    organisationId: 'org-a',
    db,
    where: () => ({}),
    assertOwned: <T>(row: T) => row,
    insertValues: <T extends object>(values: T) => ({
      ...values,
      organisationId: 'org-a',
    }),
  };
  return { currentScope: () => scope, scopeFor: () => scope };
});

vi.mock('@/lib/tenancy/context', () => ({
  requireTenantContext: () => state.ctx,
}));

vi.mock('@/domains/audit/service', () => ({ recordAudit: state.audit }));

const { recordConsent, withdrawConsent, listMyConsents } =
  await import('@/domains/consent/service');
const { AuthorizationError } = await import('@/lib/permissions/errors');

const CLIENT = '0190f0a0-0000-7000-8000-000000000001';
const WORDING = '0190f0a0-0000-7000-8000-000000000003';
const APPLICANT = '0190f0a0-0000-7000-8000-000000000004';

function asStaff(): void {
  state.ctx = {
    organisationId: 'org-a',
    userId: 'staff-1',
    permissions: new Set(['application:update-intake']),
  };
}

function asApplicant(userId = APPLICANT): void {
  state.ctx = {
    organisationId: 'org-a',
    userId,
    permissions: new Set(['application:create', 'application:read-own']),
  };
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant-1',
    organisationId: 'org-a',
    kind: 'granted',
    subjectUserId: APPLICANT,
    subjectClientId: null,
    purpose: 'evidence-handling',
    representativeUserId: null,
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.results.length = 0;
  state.inserts.length = 0;
  state.updates.length = 0;
  state.audit.mockClear();
});

describe('recordConsent', () => {
  it('staff record consent for a client with no account, linked to its wording', async () => {
    asStaff();
    state.results.push(
      [{ id: CLIENT, organisationId: 'org-a', linkedUserId: null }],
      [{ id: WORDING, organisationId: 'org-a', purpose: 'evidence-handling' }],
      [{ id: 'grant-1', purpose: 'evidence-handling', wordingVersionId: WORDING }],
    );

    await recordConsent({
      subjectClientId: CLIENT,
      purpose: 'evidence-handling',
      wordingVersionId: WORDING,
      method: 'signed-form',
      evidenceReference: 'Form 117',
    });

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({
      kind: 'granted',
      subjectUserId: null,
      subjectClientId: CLIENT,
      wordingVersionId: WORDING,
      method: 'signed-form',
      evidenceReference: 'Form 117',
      channel: 'staff',
      actorUserId: 'staff-1',
      organisationId: 'org-a',
    });
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'consent.recorded', result: 'success' }),
    );
  });

  it('refuses a wording version for a different purpose', async () => {
    asStaff();
    state.results.push(
      [{ id: CLIENT, organisationId: 'org-a', linkedUserId: null }],
      [{ id: WORDING, organisationId: 'org-a', purpose: 'communications' }],
    );
    await expect(
      recordConsent({
        subjectClientId: CLIENT,
        purpose: 'evidence-handling',
        wordingVersionId: WORDING,
        method: 'signed-form',
        evidenceReference: 'Form 117',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(state.inserts).toHaveLength(0);
  });

  it('applicants cannot record staff-channel consent', async () => {
    asApplicant();
    await expect(
      recordConsent({
        subjectUserId: APPLICANT,
        purpose: 'evidence-handling',
        wordingVersionId: WORDING,
        method: 'signed-form',
        evidenceReference: 'Form 117',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('a person may acknowledge online for themselves, never for someone else', async () => {
    asApplicant();
    state.results.push(
      [{ id: WORDING, organisationId: 'org-a', purpose: 'communications' }],
      [{ id: 'grant-2' }],
    );
    await recordConsent({
      subjectUserId: APPLICANT,
      purpose: 'communications',
      wordingVersionId: WORDING,
      method: 'online-acknowledgement',
    });
    expect(state.inserts[0]).toMatchObject({
      channel: 'self-service',
      givenBy: 'subject',
    });

    await expect(
      recordConsent({
        subjectUserId: '0190f0a0-0000-7000-8000-000000000099',
        purpose: 'communications',
        wordingVersionId: WORDING,
        method: 'online-acknowledgement',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('withdrawConsent', () => {
  it('the subject can withdraw through the portal without staff permissions', async () => {
    asApplicant();
    state.results.push(
      [grant()],
      [],
      [],
      [{ id: 'withdrawal-1', method: 'online-acknowledgement', channel: 'self-service' }],
    );

    const result = await withdrawConsent('grant-1', { method: 'online-acknowledgement' });

    expect(result.withdrawal.id).toBe('withdrawal-1');
    expect(state.updates).toHaveLength(0); // the grant is never edited
    expect(state.inserts[0]).toMatchObject({
      kind: 'withdrawn',
      grantEventId: 'grant-1',
      subjectUserId: APPLICANT,
      purpose: 'evidence-handling',
      channel: 'self-service',
      actorUserId: APPLICANT,
    });
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'consent.withdrawn',
        resourceId: 'grant-1',
        result: 'success',
      }),
    );
  });

  it('another person cannot withdraw someone else’s consent online', async () => {
    asApplicant('0190f0a0-0000-7000-8000-000000000099');
    state.results.push([grant()], []); // no active representation
    await expect(
      withdrawConsent('grant-1', {
        method: 'online-acknowledgement',
        givenBy: 'representative',
        representativeName: 'Not Authorised',
        representativeRelationship: 'friend',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(state.inserts).toHaveLength(0);
  });

  it('withdrawing representative access revokes the authorisations it backs', async () => {
    asStaff();
    state.results.push(
      [grant({ purpose: 'representative-access' })],
      [],
      [],
      [{ id: 'withdrawal-1', method: 'written-request', channel: 'staff' }],
      [{ id: 'rep-1' }, { id: 'rep-2' }],
    );

    const result = await withdrawConsent('grant-1', {
      method: 'written-request',
      evidenceReference: 'Letter received 2026-10-14',
    });

    expect(result.revokedRepresentativeAuthorisationIds).toEqual(['rep-1', 'rep-2']);
    expect(state.updates).toEqual([
      expect.objectContaining({ status: 'revoked', revokedAt: expect.any(Date) }),
    ]);
    const actions = state.audit.mock.calls.map(
      (call) => (call[0] as { action: string }).action,
    );
    expect(actions).toEqual([
      'representative.revoked',
      'representative.revoked',
      'consent.withdrawn',
    ]);
  });

  it('a grant can be withdrawn only once; the refusal is audited', async () => {
    asStaff();
    state.results.push([grant()], [], [{ id: 'withdrawal-0' }]);
    await expect(
      withdrawConsent('grant-1', {
        method: 'verbal-witnessed',
        witnessName: 'A. Officer',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(state.inserts).toHaveLength(0);
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'consent.withdrawn', result: 'denied' }),
    );
  });

  it('an unknown grant is refused without revealing whether it exists', async () => {
    asStaff();
    state.results.push([]);
    await expect(
      withdrawConsent('missing', {
        method: 'verbal-witnessed',
        witnessName: 'A. Officer',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('listMyConsents', () => {
  it('derives state from grant + withdrawal events', async () => {
    asApplicant();
    state.results.push(
      [{ id: CLIENT }],
      [grant(), grant({ id: 'grant-2', purpose: 'communications' })],
      [{ id: 'withdrawal-1', grantEventId: 'grant-2', kind: 'withdrawn' }],
    );
    const views = await listMyConsents();
    expect(views.map((v) => [v.grant.id, v.state])).toEqual([
      ['grant-1', 'live'],
      ['grant-2', 'withdrawn'],
    ]);
  });
});
