import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Disposable migrated Postgres. Skipped unless RUN_INTEGRATION=true.
 * Covers no factor, an unconfirmed TOTP row, a confirmed TOTP row, a passkey,
 * and an applicant-only membership.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, policy] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/with-tenant'),
    import('@/lib/auth/staff-policy'),
  ]);
  return { ...client, schema, ...tenancy, ...policy };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

integration('staff second-factor enrolment matrix', () => {
  let runtime: Runtime;
  let organisationId: string;
  let roleId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationId = randomUUID();
    roleId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: 'Staff MFA Integration Org',
      slug: `staff-mfa-${suffix}`,
      status: 'active',
    });
    await runtime.db.insert(runtime.schema.roles).values({
      id: roleId,
      organisationId,
      slug: 'intake-officer',
      name: 'Intake Officer',
      isSystem: false,
    });
  });

  afterAll(async () => {
    if (!runtime) return;
    const { membershipRoles, memberships, passkeys, roles, twoFactors, users } =
      runtime.schema;
    if (userIds.length > 0) {
      for (const userId of userIds) {
        await runtime.db.delete(passkeys).where(eq(passkeys.userId, userId));
        await runtime.db.delete(twoFactors).where(eq(twoFactors.userId, userId));
      }
    }
    await runtime.db.delete(membershipRoles).where(eq(membershipRoles.roleId, roleId));
    await runtime.db
      .delete(memberships)
      .where(eq(memberships.organisationId, organisationId));
    await runtime.db.delete(roles).where(eq(roles.id, roleId));
    await runtime.db
      .delete(runtime.schema.organisations)
      .where(eq(runtime.schema.organisations.id, organisationId));
    for (const userId of userIds) {
      await runtime.db.delete(users).where(eq(users.id, userId));
    }
  });

  async function addUser(name: string): Promise<string> {
    const userId = randomUUID();
    userIds.push(userId);
    await runtime.db.insert(runtime.schema.users).values({
      id: userId,
      name,
      email: `${name}-${userId}@example.test`,
      emailVerified: true,
    });
    return userId;
  }

  async function addMembership(userId: string, slug: string): Promise<void> {
    let assignedRoleId = roleId;
    if (slug !== 'intake-officer') {
      assignedRoleId = randomUUID();
      await runtime.db.insert(runtime.schema.roles).values({
        id: assignedRoleId,
        organisationId,
        slug,
        name: slug,
        isSystem: false,
      });
    }
    const membershipId = randomUUID();
    await runtime.db.insert(runtime.schema.memberships).values({
      id: membershipId,
      organisationId,
      userId,
      status: 'active',
    });
    await runtime.db.insert(runtime.schema.membershipRoles).values({
      id: randomUUID(),
      membershipId,
      roleId: assignedRoleId,
    });
  }

  function enter(userId: string) {
    return runtime.withTenant(
      {
        userId,
        sessionId: randomUUID(),
        organisationId,
        correlationId: randomUUID(),
        requestId: randomUUID(),
      },
      () => 'allowed',
    );
  }

  it('refuses a staff account with no factor and audits the denial', async () => {
    const userId = await addUser('unenrolled');
    await addMembership(userId, 'intake-officer');

    await expect(enter(userId)).rejects.toBeInstanceOf(runtime.StaffMfaRequiredError);
    const denials = await runtime.db
      .select({
        result: runtime.schema.auditEvents.result,
        reason: runtime.schema.auditEvents.reason,
      })
      .from(runtime.schema.auditEvents)
      .where(
        and(
          eq(runtime.schema.auditEvents.actorUserId, userId),
          eq(runtime.schema.auditEvents.action, 'mfa.access_denied'),
        ),
      );
    expect(denials).toEqual([
      expect.objectContaining({ result: 'denied', reason: 'no_second_factor' }),
    ]);
  });

  it('does not treat an unconfirmed authenticator row as enrolled', async () => {
    const userId = await addUser('unverified');
    await addMembership(userId, 'intake-officer');
    await runtime.db.insert(runtime.schema.twoFactors).values({
      id: randomUUID(),
      userId,
      secret: 'ciphertext-not-a-secret',
      backupCodes: 'ciphertext-not-codes',
      verified: false,
    });

    const enrolment = await runtime.getMfaEnrolment(userId);
    expect(enrolment).toEqual({ hasPasskey: false, hasTotp: false });
    await expect(enter(userId)).rejects.toMatchObject({ code: 'STAFF_MFA_REQUIRED' });
  });

  it('allows a confirmed authenticator factor', async () => {
    const userId = await addUser('totp');
    await addMembership(userId, 'intake-officer');
    await runtime.db.insert(runtime.schema.twoFactors).values({
      id: randomUUID(),
      userId,
      secret: 'ciphertext-not-a-secret',
      backupCodes: 'ciphertext-not-codes',
      verified: true,
    });

    await expect(enter(userId)).resolves.toBe('allowed');
  });

  it('allows a passkey without an authenticator factor', async () => {
    const userId = await addUser('passkey');
    await addMembership(userId, 'intake-officer');
    await runtime.db.insert(runtime.schema.passkeys).values({
      id: randomUUID(),
      userId,
      credentialID: `integration-${userId}`,
      publicKey: 'integration-public-key',
      counter: 0,
    });

    await expect(enter(userId)).resolves.toBe('allowed');
  });

  it('does not force an applicant-only membership', async () => {
    const userId = await addUser('applicant');
    await addMembership(userId, 'applicant');

    await expect(enter(userId)).resolves.toBe('allowed');
  });
});
