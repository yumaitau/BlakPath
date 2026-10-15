import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Operator provisioning against a migrated PostgreSQL database. Email is
 * stubbed; the tenant key uses the local provider (no KMS in CI). Gated like
 * the other integration suites.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

const mail = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string; text: string }>,
}));
vi.mock('@/lib/email/mailer', () => ({
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    mail.sent.push(message);
  },
}));

async function loadRuntime() {
  const [client, schema, drizzle, onboarding, keys] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('drizzle-orm'),
    import('@/domains/onboarding'),
    import('@/domains/organisation-keys'),
  ]);
  return { ...client, schema, drizzle, onboarding, keys };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

const KEY_ARN =
  'arn:aws:kms:ap-southeast-2:444444444444:key/dddddddd-0000-4000-8000-000000000004';

integration('operator organisation provisioning', () => {
  let runtime: Runtime;
  let operatorId: string;
  let operatorEmail: string;
  let slug: string;

  beforeAll(async () => {
    runtime = await loadRuntime();
    const suffix = randomUUID().slice(0, 8);
    operatorId = randomUUID();
    operatorEmail = `operator-${suffix}@blakpath.test`;
    slug = `provisioned-${suffix}`;
    await runtime.db.insert(runtime.schema.users).values({
      id: operatorId,
      name: 'Platform Operator',
      email: operatorEmail,
      emailVerified: true,
      isPlatformOperator: true,
    });
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  async function platformEvents(organisationId: string) {
    const { and, eq, isNull } = runtime.drizzle;
    const { auditEvents } = runtime.schema;
    return runtime.db
      .select({
        action: auditEvents.action,
        result: auditEvents.result,
        reason: auditEvents.reason,
        actorUserId: auditEvents.actorUserId,
      })
      .from(auditEvents)
      .where(
        and(
          isNull(auditEvents.organisationId),
          eq(auditEvents.resourceId, organisationId),
        ),
      )
      .orderBy(auditEvents.timestamp);
  }

  it('refuses an email without a platform operator account', async () => {
    await expect(
      runtime.onboarding.provisionOrganisation({
        legalName: 'Nobody Corporation',
        slug,
        adminEmail: 'admin@example.test',
        operatorEmail: 'not-an-operator@example.test',
      }),
    ).rejects.toMatchObject({ code: 'OPERATOR_NOT_FOUND' });
    expect(mail.sent).toHaveLength(0);
  });

  it('provisions once, emails once, and audits on the platform chain', async () => {
    const input = {
      legalName: 'Provisioned Aboriginal Corporation',
      slug,
      adminEmail: 'First.Admin@Example.test',
      operatorEmail,
    };
    const first = await runtime.onboarding.provisionOrganisation(input);
    const again = await runtime.onboarding.provisionOrganisation(input);
    expect(first).toMatchObject({ created: true, invitationSent: true, slug });
    expect(again).toMatchObject({
      created: false,
      invitationSent: false,
      organisationId: first.organisationId,
    });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toBe('first.admin@example.test');

    const { eq } = runtime.drizzle;
    const { organisations, roles, memberships, membershipInvitations } = runtime.schema;
    const [org] = await runtime.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, first.organisationId));
    expect(org).toMatchObject({ status: 'onboarding', publicApplicationsOpen: false });

    const tenantRoles = await runtime.db
      .select({ slug: roles.slug })
      .from(roles)
      .where(eq(roles.organisationId, first.organisationId));
    expect(tenantRoles.map((role) => role.slug)).toContain('organisation-admin');
    expect(tenantRoles.map((role) => role.slug)).not.toContain('platform-operator');

    const members = await runtime.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.organisationId, first.organisationId));
    expect(members).toHaveLength(0);

    const [invite] = await runtime.db
      .select({ tokenHash: membershipInvitations.tokenHash })
      .from(membershipInvitations)
      .where(eq(membershipInvitations.organisationId, first.organisationId));
    expect(invite?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first)).not.toContain(invite?.tokenHash ?? 'missing');

    expect(await platformEvents(first.organisationId)).toEqual([
      {
        action: 'admin.organisation_provisioned',
        result: 'success',
        reason: null,
        actorUserId: operatorId,
      },
    ]);
  });

  it('activates only after the key, checklist and agreement are in place', async () => {
    const { onboarding, keys } = runtime;
    await expect(
      onboarding.activateOrganisation({ slug, operatorEmail }),
    ).rejects.toMatchObject({
      code: 'ACTIVATION_REFUSED',
      reasons: ['key_not_validated', 'checklist_incomplete', 'agreement_missing'],
    });

    for (const item of onboarding.READINESS_ITEMS) {
      await onboarding.recordOperatorReadiness({
        slug,
        item: item.key,
        complete: true,
        operatorEmail,
      });
    }
    await onboarding.recordSignedAgreement({
      slug,
      reference: 'MSA-2026-099',
      signedAt: '2026-10-01',
      operatorEmail,
    });
    await expect(
      onboarding.activateOrganisation({ slug, operatorEmail }),
    ).rejects.toMatchObject({ reasons: ['key_not_validated'] });

    const { eq } = runtime.drizzle;
    const [org] = await runtime.db
      .select({ id: runtime.schema.organisations.id })
      .from(runtime.schema.organisations)
      .where(eq(runtime.schema.organisations.slug, slug));
    if (!org) throw new Error('organisation missing');
    await keys.registerOrganisationKey({
      organisationId: org.id,
      custodyMode: 'blakpath_managed',
      kmsKeyArn: KEY_ARN,
    });
    await keys.validateOrganisationKey(org.id, KEY_ARN);

    const activated = await onboarding.activateOrganisation({ slug, operatorEmail });
    expect(activated).toMatchObject({ status: 'active', changed: true });
    const again = await onboarding.activateOrganisation({ slug, operatorEmail });
    expect(again.changed).toBe(false);

    const events = await platformEvents(org.id);
    expect(events.map((event) => `${event.action}:${event.result}`)).toEqual([
      'admin.organisation_provisioned:success',
      'admin.organisation_activated:denied',
      ...onboarding.READINESS_ITEMS.map(() => 'admin.readiness_recorded:success'),
      'admin.agreement_recorded:success',
      'admin.organisation_activated:denied',
      'admin.organisation_activated:success',
    ]);
    expect(events.every((event) => event.actorUserId === operatorId)).toBe(true);
  });
});
