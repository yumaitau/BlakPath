import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ConcurrencyConflictError } from '@/lib/concurrency/error';

/**
 * Real row races. Skipped unless RUN_INTEGRATION=true and DATABASE_URL points
 * at a migrated database. A claim barrier holds both attempts after their
 * reads so exactly one conditional update can win.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

type ClaimHost = { __blakpathClaimBarrier?: () => Promise<void> };

function holdClaims(parties: number): () => void {
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  (globalThis as ClaimHost).__blakpathClaimBarrier = async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await Promise.race([
      gate,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('claim barrier timed out')), 10_000);
      }),
    ]);
  };
  return () => {
    delete (globalThis as ClaimHost).__blakpathClaimBarrier;
  };
}

function assertOneConflict(results: PromiseSettledResult<unknown>[]): void {
  const won = results.filter((result) => result.status === 'fulfilled');
  const lost = results.filter(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected' && result.reason instanceof ConcurrencyConflictError,
  );
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(lost[0]?.reason).toMatchObject({ status: 409, code: 'CONCURRENCY_CONFLICT' });
}

integration('optimistic concurrency', () => {
  let closeDatabase: (() => Promise<unknown>) | undefined;
  const organisationIds: string[] = [];
  const userIds: string[] = [];

  afterAll(async () => {
    delete (globalThis as ClaimHost).__blakpathClaimBarrier;
    delete process.env.COA_SIGNING_LOCAL_KEY_PEM;
    if (!closeDatabase) return;
    const [{ db }, schema, drizzle, env] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('drizzle-orm'),
      import('@/lib/env'),
    ]);
    env.__resetEnvCache();
    // audit_events is append-only; its rows stay behind by design.
    for (const organisationId of organisationIds) {
      await db
        .delete(schema.organisations)
        .where(drizzle.eq(schema.organisations.id, organisationId));
    }
    for (const userId of userIds) {
      await db.delete(schema.users).where(drizzle.eq(schema.users.id, userId));
    }
    await closeDatabase();
  });

  async function runtime() {
    const [
      { db, sqlClient },
      schema,
      tenancy,
      applications,
      certificates,
      decisions,
      forms,
      reviews,
      drizzle,
      env,
    ] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/lib/tenancy/context'),
      import('@/domains/applications'),
      import('@/domains/certificates'),
      import('@/domains/decisions'),
      import('@/domains/forms'),
      import('@/domains/reviews'),
      import('drizzle-orm'),
      import('@/lib/env'),
    ]);
    closeDatabase = () => sqlClient.end({ timeout: 5 });
    return {
      db,
      schema,
      tenancy,
      applications,
      certificates,
      decisions,
      forms,
      reviews,
      drizzle,
      env,
    };
  }

  async function staffContext() {
    const rt = await runtime();
    const orgId = randomUUID();
    const actorId = randomUUID();
    const membershipId = randomUUID();
    const suffix = orgId.slice(0, 8);
    organisationIds.push(orgId);
    userIds.push(actorId);
    await rt.db.insert(rt.schema.users).values({
      id: actorId,
      name: 'Concurrency Test Staff',
      email: `concurrency-${suffix}@example.test`,
      emailVerified: true,
    });
    await rt.db.insert(rt.schema.organisations).values({
      id: orgId,
      legalName: 'Concurrency Test Organisation',
      slug: `concurrency-${suffix}`,
      status: 'active',
    });
    const { ensureOrganisationKey } = await import('@/domains/organisation-keys');
    await ensureOrganisationKey(orgId);
    await rt.db.insert(rt.schema.memberships).values({
      id: membershipId,
      organisationId: orgId,
      userId: actorId,
      status: 'active',
    });
    const ctx = {
      organisationId: orgId,
      userId: actorId,
      membershipId,
      permissions: new Set([
        'application:create',
        'application:read-any',
        'application:update-intake',
        'review:create',
        'review:finalise',
        'decision:propose',
        'decision:finalise',
        'certificate:sign',
      ]),
      roles: ['integration-tester'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
    return { rt, ctx };
  }

  it('lets one application transition win and writes one history row', async () => {
    const { rt, ctx } = await staffContext();
    const application = await rt.tenancy.runWithTenantContext(ctx, () =>
      rt.applications.createApplication({
        applicantName: 'Name supplied for concurrency testing',
        priority: 'normal',
      }),
    );
    const release = holdClaims(2);
    try {
      const results = await Promise.allSettled([
        rt.tenancy.runWithTenantContext(ctx, () =>
          rt.applications.transitionApplication(application.id, 'submit'),
        ),
        rt.tenancy.runWithTenantContext(ctx, () =>
          rt.applications.transitionApplication(application.id, 'submit'),
        ),
      ]);
      assertOneConflict(results);
    } finally {
      release();
    }

    const history = await rt.db
      .select({
        fromStatus: rt.schema.applicationStatusHistory.fromStatus,
        toStatus: rt.schema.applicationStatusHistory.toStatus,
        action: rt.schema.applicationStatusHistory.action,
      })
      .from(rt.schema.applicationStatusHistory)
      .where(
        rt.drizzle.eq(rt.schema.applicationStatusHistory.applicationId, application.id),
      );
    expect(history.filter((row) => row.action === 'submit')).toEqual([
      { fromStatus: 'draft', toStatus: 'submitted', action: 'submit' },
    ]);
    const [stored] = await rt.db
      .select({ status: rt.schema.applications.status })
      .from(rt.schema.applications)
      .where(rt.drizzle.eq(rt.schema.applications.id, application.id));
    expect(stored?.status).toBe('submitted');
  });

  it('lets one certificate sign win', async () => {
    const { rt, ctx } = await staffContext();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.COA_SIGNING_LOCAL_KEY_PEM = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    rt.env.__resetEnvCache();

    const applicationId = randomUUID();
    const decisionId = randomUUID();
    const certificateId = randomUUID();
    await rt.db.insert(rt.schema.applications).values({
      id: applicationId,
      organisationId: ctx.organisationId,
      reference: `APP-RACE-${applicationId.slice(0, 8)}`,
      applicantName: 'Name supplied for certificate concurrency',
      status: 'decided',
    });
    await rt.db.insert(rt.schema.decisions).values({
      id: decisionId,
      organisationId: ctx.organisationId,
      applicationId,
      proposedOutcome: 'confirmed',
      finalOutcome: 'confirmed',
      status: 'finalised',
    });
    await rt.db.insert(rt.schema.certificates).values({
      id: certificateId,
      organisationId: ctx.organisationId,
      applicationId,
      decisionId,
      reference: `CERT-RACE-${certificateId.slice(0, 8)}`,
      verificationCode: randomUUID().replace(/-/g, ''),
      status: 'draft',
      // Signing seals the PDF digest and holder binding; supply both so the
      // race is over the status claim, not fixture gaps.
      sha256: 'a'.repeat(64),
      holderBindingSalt: 'b'.repeat(32),
      holderNameHash: 'c'.repeat(64),
    });

    const release = holdClaims(2);
    try {
      const results = await Promise.allSettled([
        rt.tenancy.runWithTenantContext(ctx, () =>
          rt.certificates.signCertificate(certificateId),
        ),
        rt.tenancy.runWithTenantContext(ctx, () =>
          rt.certificates.signCertificate(certificateId),
        ),
      ]);
      assertOneConflict(results);
    } finally {
      release();
    }

    const [stored] = await rt.db
      .select({
        status: rt.schema.certificates.status,
        signature: rt.schema.certificates.signature,
      })
      .from(rt.schema.certificates)
      .where(rt.drizzle.eq(rt.schema.certificates.id, certificateId));
    expect(stored?.status).toBe('signed');
    expect(stored?.signature).toEqual(expect.any(String));
  });

  it('lets one public form submit win and stores one response', async () => {
    const { rt, ctx } = await staffContext();
    const fieldId = randomUUID();
    const { token, invitationId } = await rt.tenancy.runWithTenantContext(
      ctx,
      async () => {
        const form = await rt.forms.createForm({
          title: 'Concurrency public form',
          description: 'Collects information supplied by the recipient.',
        });
        await rt.forms.updateForm(form.id, {
          fields: [
            {
              id: fieldId,
              key: 'supplied_name',
              label: 'Name as supplied',
              type: 'text',
              required: true,
            },
          ],
        });
        await rt.forms.publishForm(form.id);
        const invitation = await rt.forms.createInvitation(form.id, {
          recipientName: 'Concurrency recipient',
        });
        return { token: invitation.token, invitationId: invitation.invitation.id };
      },
    );

    const answers = { supplied_name: 'Name supplied once' };
    const release = holdClaims(2);
    try {
      const results = await Promise.allSettled([
        rt.forms.submitPublicResponse(token, answers),
        rt.forms.submitPublicResponse(token, answers),
      ]);
      assertOneConflict(results);
    } finally {
      release();
    }

    const responses = await rt.db
      .select({ id: rt.schema.formResponses.id })
      .from(rt.schema.formResponses)
      .where(rt.drizzle.eq(rt.schema.formResponses.invitationId, invitationId));
    expect(responses).toHaveLength(1);
    const [invitation] = await rt.db
      .select({ status: rt.schema.formInvitations.status })
      .from(rt.schema.formInvitations)
      .where(rt.drizzle.eq(rt.schema.formInvitations.id, invitationId));
    expect(invitation?.status).toBe('completed');
  });

  it('lets one review finalise and one decision finalise win', async () => {
    const { rt, ctx } = await staffContext();
    const application = await rt.tenancy.runWithTenantContext(ctx, () =>
      rt.applications.createApplication({
        applicantName: 'Name supplied for governance concurrency',
        priority: 'normal',
      }),
    );
    await rt.db
      .update(rt.schema.applications)
      .set({ status: 'in_committee' })
      .where(rt.drizzle.eq(rt.schema.applications.id, application.id));

    const review = await rt.tenancy.runWithTenantContext(ctx, () =>
      rt.reviews.createReview(application.id, {
        content: 'Observations recorded by a person for the committee.',
      }),
    );
    const decision = await rt.tenancy.runWithTenantContext(ctx, () =>
      rt.decisions.proposeDecision(application.id, {
        outcome: 'confirmed',
        rationale: 'Outcome the committee will record.',
      }),
    );

    const releaseReviews = holdClaims(2);
    try {
      const reviewResults = await Promise.allSettled([
        rt.tenancy.runWithTenantContext(ctx, () => rt.reviews.finaliseReview(review.id)),
        rt.tenancy.runWithTenantContext(ctx, () => rt.reviews.finaliseReview(review.id)),
      ]);
      assertOneConflict(reviewResults);
    } finally {
      releaseReviews();
    }

    const releaseDecisions = holdClaims(2);
    try {
      const decisionResults = await Promise.allSettled([
        rt.tenancy.runWithTenantContext(ctx, () =>
          rt.decisions.finaliseDecision(decision.id, {
            outcome: 'confirmed',
            note: 'Recorded by an authorised person.',
          }),
        ),
        rt.tenancy.runWithTenantContext(ctx, () =>
          rt.decisions.finaliseDecision(decision.id, {
            outcome: 'not_confirmed',
            note: 'Conflicting concurrent finalise.',
          }),
        ),
      ]);
      assertOneConflict(decisionResults);
    } finally {
      releaseDecisions();
    }

    const history = await rt.db
      .select({ action: rt.schema.applicationStatusHistory.action })
      .from(rt.schema.applicationStatusHistory)
      .where(
        rt.drizzle.eq(rt.schema.applicationStatusHistory.applicationId, application.id),
      );
    expect(history.filter((row) => row.action === 'record_decision')).toHaveLength(1);
  });
});
