import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Consent ledger against a migrated PostgreSQL database: the append-only
 * trigger, consent for a person without an account, and withdrawal with its
 * downstream effect on representative access. Rows created here cannot be
 * deleted (that is the point), so the test uses a fresh organisation.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, consent, representatives, drizzle] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/domains/consent'),
    import('@/domains/representatives'),
    import('drizzle-orm'),
  ]);
  return { ...client, schema, tenancy, consent, representatives, drizzle };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type TenantContext = Parameters<Runtime['tenancy']['runWithTenantContext']>[0];

/** Postgres error text, whether or not drizzle wrapped the driver error. */
function errorText(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } };
  return `${e.message ?? ''} ${e.cause?.message ?? ''}`;
}

integration('consent ledger (database)', () => {
  let runtime: Runtime;
  let organisationId: string;
  let staffUserId: string;
  let applicantUserId: string;
  let representativeUserId: string;
  let staff: TenantContext;
  let applicant: TenantContext;

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationId = randomUUID();
    staffUserId = randomUUID();
    applicantUserId = randomUUID();
    representativeUserId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await runtime.db.insert(runtime.schema.users).values(
      [staffUserId, applicantUserId, representativeUserId].map((id, i) => ({
        id,
        name: `Consent Integration ${i}`,
        email: `consent-${i}-${suffix}@example.test`,
        emailVerified: true,
      })),
    );
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: 'Consent Ledger Integration Organisation',
      slug: `consent-ledger-${suffix}`,
      status: 'active',
    });
    const base = {
      organisationId,
      roles: ['integration-tester'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
    staff = {
      ...base,
      userId: staffUserId,
      membershipId: randomUUID(),
      permissions: new Set([
        'tenant:configure',
        'client:create',
        'application:update-intake',
        'application:read-any',
      ]),
    };
    applicant = {
      ...base,
      userId: applicantUserId,
      membershipId: randomUUID(),
      permissions: new Set(['application:create', 'application:read-own']),
    };
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  it('records consent for a client without an account, and the DB refuses edits', async () => {
    const { consent, schema, db, drizzle, tenancy } = runtime;
    const [client] = await db
      .insert(schema.clients)
      .values({ organisationId, displayName: 'Paper intake person' })
      .returning();
    if (!client) throw new Error('client not created');

    const grant = await tenancy.runWithTenantContext(staff, async () => {
      const wording = await consent.publishWordingVersion({
        purpose: 'evidence-handling',
        title: 'Handling your documents',
        body: 'We will keep your documents securely and use them only for your application.',
      });
      expect(wording.version).toBe(1);
      return consent.recordConsent({
        subjectClientId: client.id,
        purpose: 'evidence-handling',
        wordingVersionId: wording.id,
        method: 'signed-form',
        evidenceReference: 'Signed intake form #1',
      });
    });
    expect(grant).toMatchObject({ subjectUserId: null, subjectClientId: client.id });

    const where = drizzle.eq(schema.consentEvents.id, grant.id);
    await expect(
      db.update(schema.consentEvents).set({ purpose: 'communications' }).where(where),
    ).rejects.toSatisfy((e: unknown) => /append-only/.test(errorText(e)));
    await expect(db.delete(schema.consentEvents).where(where)).rejects.toSatisfy(
      (e: unknown) => /append-only/.test(errorText(e)),
    );
    await expect(
      db.execute(drizzle.sql`truncate table consent_events cascade`),
    ).rejects.toSatisfy((e: unknown) => /append-only/.test(errorText(e)));
    await expect(
      db
        .update(schema.consentWordingVersions)
        .set({ body: 'rewritten' })
        .where(drizzle.eq(schema.consentWordingVersions.organisationId, organisationId)),
    ).rejects.toSatisfy((e: unknown) => /append-only/.test(errorText(e)));

    const views = await tenancy.runWithTenantContext(staff, () =>
      consent.listConsents({ subjectClientId: client.id }),
    );
    expect(views.map((v) => v.state)).toEqual(['live']);
  });

  it('subject withdraws online; representative access it backed is revoked', async () => {
    const { consent, representatives, schema, db, drizzle, tenancy } = runtime;
    const grant = await tenancy.runWithTenantContext(staff, async () => {
      const wording = await consent.publishWordingVersion({
        purpose: 'representative-access',
        title: 'Someone acting for you',
        body: 'You agree that the named person may act for you on your application.',
      });
      return consent.recordConsent({
        subjectUserId: applicantUserId,
        purpose: 'representative-access',
        wordingVersionId: wording.id,
        method: 'verbal-witnessed',
        witnessName: 'Intake officer on duty',
      });
    });
    const authorisation = await tenancy.runWithTenantContext(staff, async () => {
      const requested = await representatives.requestRepresentativeAccess({
        subjectUserId: applicantUserId,
        representativeUserId,
        purpose: 'Parent acting on application',
        consentEventId: grant.id,
      });
      return representatives.activateRepresentativeAccess(requested.id);
    });
    expect(authorisation.status).toBe('active');

    const result = await tenancy.runWithTenantContext(applicant, () =>
      consent.withdrawConsent(grant.id, { method: 'online-acknowledgement' }),
    );
    expect(result.withdrawal).toMatchObject({
      kind: 'withdrawn',
      grantEventId: grant.id,
      channel: 'self-service',
    });
    expect(result.revokedRepresentativeAuthorisationIds).toEqual([authorisation.id]);

    const [after] = await db
      .select({ status: schema.representativeAuthorisations.status })
      .from(schema.representativeAuthorisations)
      .where(drizzle.eq(schema.representativeAuthorisations.id, authorisation.id));
    expect(after?.status).toBe('revoked');

    // Withdrawal appended; the grant row is unchanged and cannot be withdrawn twice.
    await expect(
      tenancy.runWithTenantContext(applicant, () =>
        consent.withdrawConsent(grant.id, { method: 'online-acknowledgement' }),
      ),
    ).rejects.toThrow();
    const mine = await tenancy.runWithTenantContext(applicant, () =>
      consent.listMyConsents(),
    );
    expect(mine.map((v) => [v.grant.id, v.state])).toEqual([[grant.id, 'withdrawn']]);

    const audit = await db
      .select({ action: schema.auditEvents.action, result: schema.auditEvents.result })
      .from(schema.auditEvents)
      .where(
        drizzle.and(
          drizzle.eq(schema.auditEvents.organisationId, organisationId),
          drizzle.eq(schema.auditEvents.resourceId, grant.id),
        ),
      );
    expect(audit).toEqual(
      expect.arrayContaining([
        { action: 'consent.withdrawn', result: 'success' },
        { action: 'consent.withdrawn', result: 'denied' },
      ]),
    );
  });
});
