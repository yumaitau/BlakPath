import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * These tests deliberately require a disposable, migrated PostgreSQL database.
 * They stay skipped during the ordinary unit-only loop and run in CI after the
 * development bootstrap has been seeded.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

async function loadRuntime() {
  const [
    client,
    schema,
    tenancy,
    tenantDb,
    applications,
    evidence,
    decisions,
    forms,
    memberships,
    audit,
  ] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/db/tenant-db'),
    import('@/domains/applications'),
    import('@/domains/evidence'),
    import('@/domains/decisions'),
    import('@/domains/forms'),
    import('@/domains/memberships'),
    import('@/domains/audit'),
  ]);

  return {
    ...client,
    schema,
    tenancy,
    tenantDb,
    applications,
    evidence,
    decisions,
    forms,
    memberships,
    audit,
  };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type TenantContext = Parameters<Runtime['tenancy']['runWithTenantContext']>[0];

integration('database-backed security boundaries', () => {
  let runtime: Runtime;
  let organisationA: string;
  let organisationB: string;
  let userId: string;
  let invitedUserId: string;
  let invitedUserEmail: string;
  let contextA: TenantContext;
  let contextB: TenantContext;

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationA = randomUUID();
    organisationB = randomUUID();
    userId = randomUUID();
    invitedUserId = randomUUID();
    const membershipA = randomUUID();
    const membershipB = randomUUID();
    const suffix = randomUUID().slice(0, 8);

    invitedUserEmail = `invited-${suffix}@example.test`;
    await runtime.db.insert(runtime.schema.users).values([
      {
        id: userId,
        name: 'Integration Test Staff Member',
        email: `integration-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        id: invitedUserId,
        name: 'Invited Integration Staff Member',
        email: invitedUserEmail,
        emailVerified: true,
      },
    ]);
    await runtime.db.insert(runtime.schema.organisations).values([
      {
        id: organisationA,
        legalName: 'Integration Organisation A',
        slug: `integration-a-${suffix}`,
        status: 'active',
      },
      {
        id: organisationB,
        legalName: 'Integration Organisation B',
        slug: `integration-b-${suffix}`,
        status: 'active',
      },
    ]);
    await runtime.db.insert(runtime.schema.memberships).values([
      {
        id: membershipA,
        organisationId: organisationA,
        userId,
        status: 'active',
      },
      {
        id: membershipB,
        organisationId: organisationB,
        userId,
        status: 'active',
      },
    ]);
    const { ensureOrganisationKey } = await import('@/domains/organisation-keys');
    await ensureOrganisationKey(organisationA);
    await ensureOrganisationKey(organisationB);

    const permissions = new Set([
      'application:create',
      'application:read-any',
      'application:update-intake',
      'evidence:upload-own',
      'evidence:request',
      'review:finalise',
      'meeting:agenda-manage',
      'decision:propose',
      'decision:vote',
      'decision:finalise',
      'membership:manage',
    ]);
    const baseContext = {
      userId,
      permissions,
      roles: ['integration-tester'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
    contextA = {
      ...baseContext,
      organisationId: organisationA,
      membershipId: membershipA,
    };
    contextB = {
      ...baseContext,
      organisationId: organisationB,
      membershipId: membershipB,
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  it('prevents cross-tenant reads and writes while domain workflows remain usable', async () => {
    const application = await runtime.tenancy.runWithTenantContext(contextA, () =>
      runtime.applications.createApplication({
        applicantName: 'Name supplied for integration testing',
        applicantUserId: userId,
        priority: 'high',
      }),
    );

    const upload = await runtime.tenancy.runWithTenantContext(contextA, () =>
      runtime.evidence.requestUpload(application.id, {
        fileName: 'supporting-record.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      }),
    );
    expect(upload.evidence).toMatchObject({
      organisationId: organisationA,
      applicationId: application.id,
      status: 'pending',
    });
    expect(upload.upload.url).toMatch(/^https?:\/\//);

    await runtime.tenancy.runWithTenantContext(contextA, async () => {
      await runtime.applications.transitionApplication(application.id, 'submit');
      await runtime.applications.transitionApplication(application.id, 'begin_intake');
      const request = await runtime.evidence.requestFurtherEvidence(application.id, {
        description: 'Please provide the requested supporting record.',
      });
      expect(request.organisationId).toBe(organisationA);
      await runtime.applications.transitionApplication(application.id, 'start_review');
      await runtime.applications.transitionApplication(
        application.id,
        'ready_for_committee',
      );
      await runtime.applications.transitionApplication(
        application.id,
        'schedule_committee',
      );

      const decision = await runtime.decisions.proposeDecision(application.id, {
        outcome: 'confirmed',
        rationale: 'Outcome recorded by the authorised committee.',
      });
      await runtime.decisions.castVote(decision.id, { choice: 'for' });
      const finalised = await runtime.decisions.finaliseDecision(decision.id, {
        outcome: 'confirmed',
        note: 'Human decision recorded in the integration test.',
      });
      expect(finalised).toMatchObject({
        organisationId: organisationA,
        status: 'finalised',
        finalOutcome: 'confirmed',
      });
    });

    const tenantBList = await runtime.tenancy.runWithTenantContext(contextB, () =>
      runtime.applications.listApplications({ limit: 100 }),
    );
    expect(tenantBList.items.some(({ id }) => id === application.id)).toBe(false);
    await expect(
      runtime.tenancy.runWithTenantContext(contextB, () =>
        runtime.applications.getApplication(application.id),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      runtime.tenancy.runWithTenantContext(contextB, () =>
        runtime.applications.updateIntake(application.id, {
          applicantName: 'Cross-tenant overwrite attempt',
        }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    const storedApplications = await runtime.db
      .select({
        applicantName: runtime.schema.applications.applicantName,
        organisationId: runtime.schema.applications.organisationId,
        status: runtime.schema.applications.status,
      })
      .from(runtime.schema.applications)
      .where(
        (await import('drizzle-orm')).eq(runtime.schema.applications.id, application.id),
      );
    expect(storedApplications[0]?.organisationId).toBe(organisationA);
    expect(storedApplications[0]?.status).toBe('decided');
    expect(storedApplications[0]?.applicantName.startsWith('{"v":2')).toBe(true);
    const { isTenantCiphertext } = await import('@/lib/encryption/field-codec');
    expect(isTenantCiphertext(storedApplications[0]?.applicantName)).toBe(true);

    const guarded = runtime.tenantDb.scopeFor(organisationB).insertValues({
      organisationId: organisationA,
      title: 'Attempted forged tenant value',
    });
    expect(guarded.organisationId).toBe(organisationB);
  });

  it('enforces valid, expired, revoked and single-use public form tokens', async () => {
    const fieldId = randomUUID();
    const { form, valid, revoked, expired } = await runtime.tenancy.runWithTenantContext(
      contextA,
      async () => {
        const created = await runtime.forms.createForm({
          title: 'Integration public form',
          description: 'Collects information supplied by the recipient.',
        });
        await runtime.forms.updateForm(created.id, {
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
        await runtime.forms.publishForm(created.id);
        return {
          form: created,
          valid: await runtime.forms.createInvitation(created.id, {
            recipientName: 'Valid recipient',
          }),
          revoked: await runtime.forms.createInvitation(created.id, {
            recipientName: 'Revoked recipient',
          }),
          expired: await runtime.forms.createInvitation(created.id, {
            recipientName: 'Expired recipient',
          }),
        };
      },
    );

    await runtime.tenancy.runWithTenantContext(contextA, () =>
      runtime.forms.revokeInvitation(revoked.invitation.id),
    );
    const { eq } = await import('drizzle-orm');
    await runtime.db
      .update(runtime.schema.formInvitations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(runtime.schema.formInvitations.id, expired.invitation.id));

    const publicForm = await runtime.forms.getPublicForm(valid.token);
    expect(publicForm).toMatchObject({
      formId: form.id,
      title: 'Integration public form',
    });
    await expect(
      runtime.forms.submitPublicResponse(valid.token, {
        supplied_name: '',
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      runtime.forms.submitPublicResponse(valid.token, {
        supplied_name: 'Name supplied by recipient',
      }),
    ).resolves.toEqual({ ok: true });

    await expect(runtime.forms.getPublicForm(valid.token)).rejects.toMatchObject({
      code: 'FORM_TOKEN_INVALID',
    });
    await expect(
      runtime.forms.submitPublicResponse(valid.token, {
        supplied_name: 'Second submission attempt',
      }),
    ).rejects.toMatchObject({ code: 'FORM_TOKEN_INVALID' });
    await expect(runtime.forms.getPublicForm(revoked.token)).rejects.toMatchObject({
      code: 'FORM_TOKEN_INVALID',
    });
    await expect(runtime.forms.getPublicForm(expired.token)).rejects.toMatchObject({
      code: 'FORM_TOKEN_INVALID',
    });
    await expect(runtime.forms.getPublicForm('not-a-real-token')).rejects.toMatchObject({
      code: 'FORM_TOKEN_INVALID',
    });

    const responsesA = await runtime.tenancy.runWithTenantContext(contextA, () =>
      runtime.forms.listResponses(form.id),
    );
    const responsesB = await runtime.tenancy.runWithTenantContext(contextB, () =>
      runtime.forms.listResponses(form.id),
    );
    expect(responsesA).toHaveLength(1);
    expect(responsesA[0]).toMatchObject({
      organisationId: organisationA,
      answers: { supplied_name: 'Name supplied by recipient' },
    });
    expect(responsesB).toEqual([]);

    const [storedInvitation] = await runtime.db
      .select({ tokenHash: runtime.schema.formInvitations.tokenHash })
      .from(runtime.schema.formInvitations)
      .where(eq(runtime.schema.formInvitations.id, valid.invitation.id));
    expect(storedInvitation?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedInvitation?.tokenHash).not.toBe(valid.token);
  });

  it('binds membership invitations to one tenant and one verified email', async () => {
    const { and, eq } = await import('drizzle-orm');
    const [role] = await runtime.db
      .select({ id: runtime.schema.roles.id, name: runtime.schema.roles.name })
      .from(runtime.schema.roles)
      .where(eq(runtime.schema.roles.slug, 'intake-officer'))
      .limit(1);
    expect(role).toBeTruthy();
    if (!role) throw new Error('Expected the seeded intake-officer role.');

    const [administratorRole] = await runtime.db
      .select({ id: runtime.schema.roles.id })
      .from(runtime.schema.roles)
      .where(eq(runtime.schema.roles.slug, 'organisation-admin'))
      .limit(1);
    if (!administratorRole) {
      throw new Error('Expected the seeded organisation-admin role.');
    }
    const lastAdministratorUserId = randomUUID();
    const lastAdministratorMembershipId = randomUUID();
    await runtime.db.insert(runtime.schema.users).values({
      id: lastAdministratorUserId,
      name: 'Last Integration Administrator',
      email: `last-admin-${randomUUID()}@example.test`,
      emailVerified: true,
    });
    await runtime.db.insert(runtime.schema.memberships).values({
      id: lastAdministratorMembershipId,
      organisationId: organisationA,
      userId: lastAdministratorUserId,
      status: 'active',
    });
    await runtime.db.insert(runtime.schema.membershipRoles).values({
      id: randomUUID(),
      membershipId: lastAdministratorMembershipId,
      roleId: administratorRole.id,
    });
    await expect(
      runtime.tenancy.runWithTenantContext(contextA, () =>
        runtime.memberships.changeMemberRole(lastAdministratorMembershipId, role.id),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      runtime.tenancy.runWithTenantContext(contextA, () =>
        runtime.memberships.changeMemberStatus(lastAdministratorMembershipId, 'revoked'),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    const invitationId = randomUUID();
    const token = `membership-${randomUUID()}-${randomUUID()}`;
    await runtime.db.insert(runtime.schema.membershipInvitations).values({
      id: invitationId,
      organisationId: organisationA,
      email: invitedUserEmail,
      roleId: role.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const preview = await runtime.memberships.getMembershipInvitationPreview(token);
    expect(preview).toMatchObject({
      organisationName: 'Integration Organisation A',
      roleName: role.name,
    });
    expect(preview.emailHint).not.toBe(invitedUserEmail);

    const listedInA = await runtime.tenancy.runWithTenantContext(contextA, () =>
      runtime.memberships.listMembershipInvitations(),
    );
    const listedInB = await runtime.tenancy.runWithTenantContext(contextB, () =>
      runtime.memberships.listMembershipInvitations(),
    );
    expect(listedInA.map(({ id }) => id)).toContain(invitationId);
    expect(listedInB.map(({ id }) => id)).not.toContain(invitationId);

    await expect(
      runtime.tenancy.runWithTenantContext(contextB, () =>
        runtime.memberships.revokeMembershipInvitation(invitationId),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    await expect(
      runtime.memberships.acceptMembershipInvitation({
        token,
        userId: invitedUserId,
        userEmail: 'different@example.test',
        emailVerified: true,
        sessionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    await expect(
      runtime.memberships.acceptMembershipInvitation({
        token,
        userId: invitedUserId,
        userEmail: invitedUserEmail,
        emailVerified: true,
        sessionId: randomUUID(),
      }),
    ).resolves.toMatchObject({ organisationId: organisationA });
    await expect(
      runtime.memberships.acceptMembershipInvitation({
        token,
        userId: invitedUserId,
        userEmail: invitedUserEmail,
        emailVerified: true,
        sessionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    const [acceptedMembership] = await runtime.db
      .select({
        organisationId: runtime.schema.memberships.organisationId,
        status: runtime.schema.memberships.status,
        roleId: runtime.schema.membershipRoles.roleId,
      })
      .from(runtime.schema.memberships)
      .innerJoin(
        runtime.schema.membershipRoles,
        eq(runtime.schema.membershipRoles.membershipId, runtime.schema.memberships.id),
      )
      .where(
        and(
          eq(runtime.schema.memberships.userId, invitedUserId),
          eq(runtime.schema.memberships.organisationId, organisationA),
        ),
      );
    expect(acceptedMembership).toEqual({
      organisationId: organisationA,
      status: 'active',
      roleId: role.id,
    });

    const invitationAudit = await runtime.db
      .select({
        organisationId: runtime.schema.auditEvents.organisationId,
        result: runtime.schema.auditEvents.result,
      })
      .from(runtime.schema.auditEvents)
      .where(eq(runtime.schema.auditEvents.action, 'membership.invitation_accepted'));
    expect(invitationAudit).toEqual(
      expect.arrayContaining([
        { organisationId: organisationA, result: 'denied' },
        { organisationId: organisationA, result: 'success' },
      ]),
    );
    const deniedCrossTenant = await runtime.db
      .select({ result: runtime.schema.auditEvents.result })
      .from(runtime.schema.auditEvents)
      .where(
        and(
          eq(runtime.schema.auditEvents.organisationId, organisationB),
          eq(runtime.schema.auditEvents.action, 'membership.invitation_revoked'),
          eq(runtime.schema.auditEvents.resourceId, invitationId),
        ),
      );
    expect(deniedCrossTenant).toEqual([{ result: 'denied' }]);
  });

  it('appends and verifies an intact tenant audit chain', async () => {
    const appended = await Promise.all([
      runtime.audit.recordAudit({
        organisationId: organisationB,
        actorUserId: userId,
        actingRole: 'integration-tester',
        action: 'record.created',
        resourceType: 'record',
        resourceId: randomUUID(),
        result: 'success',
      }),
      runtime.audit.recordAudit({
        organisationId: organisationB,
        actorUserId: userId,
        actingRole: 'integration-tester',
        action: 'record.created',
        resourceType: 'record',
        resourceId: randomUUID(),
        result: 'success',
      }),
    ]);
    expect(new Set(appended.map(({ hash }) => hash)).size).toBe(2);

    const result = await runtime.audit.verifyChain(organisationB);
    expect(result.ok).toBe(true);
    expect(result.divergence).toBeNull();
    expect(result.eventCount).toBeGreaterThanOrEqual(2);
    expect(result.endHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
