import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { hash as argon2Hash } from '@node-rs/argon2';
import { uuidv7 } from 'uuidv7';
import { db, sqlClient } from '@/db/client';
import { decideDevSeed } from '@/db/seeds/dev-seed-policy';
import { env } from '@/lib/env';
import {
  accounts,
  applicationNotes,
  applicationStatusHistory,
  applications,
  certificateTemplates,
  clients,
  evidenceRequests,
  memberships,
  membershipRoles,
  organisations,
  passkeys,
  permissions,
  rolePermissions,
  roles,
  teamMemberships,
  teams,
  users,
} from '@/db/schema';
import {
  DEFAULT_CERTIFICATE_WORDING,
  templateContentHash,
} from '@/domains/certificates/template';
import { PERMISSION_SEED } from '@/lib/permissions/catalog';
import { SYSTEM_ROLES, SYSTEM_ROLE_SEED } from '@/lib/permissions/roles';
import { DEV_TEAM_FIXTURE, DEV_TENANT_B } from '@/db/seeds/dev-tenants';

/**
 * Idempotent database seed.
 *
 * Seeds the two things the application cannot run without: the permission
 * catalogue and the system role templates (with their permission grants). Local
 * development can also create a bootstrap organisation and administrator so a
 * developer can sign in and exercise the app end to end.
 *
 * SAFETY: developer accounts require ALLOW_DEV_SEED=1 and a loopback database
 * host. NODE_ENV=production never creates them. Any other non-local host fails
 * the process. Seeding is idempotent — re-running never duplicates rows.
 * Further organisations are created with `pnpm org:provision`, which does not
 * grant the operator a tenant membership.
 */

const ARGON2_OPTIONS = {
  algorithm: 2, // Argon2id
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** Upsert every catalogue permission. */
async function seedPermissions(): Promise<void> {
  for (const def of PERMISSION_SEED) {
    await db
      .insert(permissions)
      .values({ key: def.key, description: def.description, category: def.category })
      .onConflictDoNothing({ target: permissions.key });
  }
  console.info(`[seed] permissions: ${PERMISSION_SEED.length} ensured`);
}

/**
 * Ensure the system role templates exist (organisation_id NULL). Because NULLs
 * are distinct under the (organisation_id, slug) unique index, we check by slug
 * first rather than relying on ON CONFLICT.
 */
async function seedRoles(): Promise<Map<string, string>> {
  const existing = await db
    .select({ id: roles.id, slug: roles.slug })
    .from(roles)
    .where(isNull(roles.organisationId));
  const bySlug = new Map(existing.map((r) => [r.slug, r.id]));

  for (const template of SYSTEM_ROLE_SEED) {
    if (bySlug.has(template.slug)) continue;
    const id = uuidv7();
    await db.insert(roles).values({
      id,
      organisationId: null,
      slug: template.slug,
      name: template.name,
      description: template.description,
      isSystem: true,
    });
    bySlug.set(template.slug, id);
  }
  console.info(`[seed] system roles: ${bySlug.size} ensured`);
  return bySlug;
}

/** Grant each system role its catalogue permission keys. */
async function seedRolePermissions(roleIdBySlug: Map<string, string>): Promise<void> {
  let grants = 0;
  for (const template of Object.values(SYSTEM_ROLES)) {
    const roleId = roleIdBySlug.get(template.slug);
    if (!roleId) continue;
    for (const key of template.permissions) {
      await db
        .insert(rolePermissions)
        .values({ roleId, permissionKey: key })
        .onConflictDoNothing({
          target: [rolePermissions.roleId, rolePermissions.permissionKey],
        });
      grants += 1;
    }
  }
  console.info(`[seed] role→permission grants ensured (${grants} pairs checked)`);
}

async function ensureCredentialUser(input: {
  email: string;
  name: string;
  password: string;
}): Promise<string> {
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (existingUser) return existingUser.id;
  const userId = uuidv7();
  await db.insert(users).values({
    id: userId,
    name: input.name,
    email: input.email,
    emailVerified: true,
  });
  await db.insert(accounts).values({
    id: uuidv7(),
    userId,
    providerId: 'credential',
    accountId: userId,
    password: await argon2Hash(input.password, ARGON2_OPTIONS),
  });
  return userId;
}

/**
 * Staff fixture user: credential login plus the development passkey, so the
 * second-factor gate lets the browser suite into the workspace.
 */
async function ensureStaffUser(input: {
  email: string;
  name: string;
  password: string;
}): Promise<string> {
  const userId = await ensureCredentialUser(input);
  await ensureDevPasskey(userId);
  return userId;
}

/** Insert one fixture application with its applicant name sealed like the services do. */
async function ensureSealedApplication(input: {
  id: string;
  organisationId: string;
  reference: string;
  applicantName: string;
  clientId: string;
}): Promise<void> {
  const [existing] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.id, input.id))
    .limit(1);
  if (existing) return;
  const { sealApplicationFields } = await import('@/lib/encryption/tenant-fields');
  const sealed = await sealApplicationFields(input.organisationId, input.id, {
    applicantName: input.applicantName,
    reference: input.reference,
  });
  if (!sealed.applicantName) throw new Error('Seed applicant name was not sealed');
  await db.insert(applications).values({
    id: input.id,
    organisationId: input.organisationId,
    reference: input.reference,
    applicantName: sealed.applicantName,
    referenceBidx: sealed.referenceBidx,
    applicantNameBidx: sealed.applicantNameBidx,
    applicantNameTokenBidx: sealed.applicantNameTokenBidx,
    clientId: input.clientId,
    status: 'draft',
  });
}

async function ensureActiveMembership(
  organisationId: string,
  userId: string,
): Promise<string> {
  const [existingMembership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.organisationId, organisationId), eq(memberships.userId, userId)),
    )
    .limit(1);
  if (existingMembership) {
    await db
      .update(memberships)
      .set({ status: 'active' })
      .where(eq(memberships.id, existingMembership.id));
    return existingMembership.id;
  }
  const membershipId = uuidv7();
  await db.insert(memberships).values({
    id: membershipId,
    organisationId,
    userId,
    status: 'active',
  });
  return membershipId;
}

async function grantRoles(
  membershipId: string,
  slugs: readonly string[],
  roleIdBySlug: Map<string, string>,
): Promise<void> {
  for (const slug of slugs) {
    const roleId = roleIdBySlug.get(slug);
    if (!roleId) continue;
    await db
      .insert(membershipRoles)
      .values({ id: uuidv7(), membershipId, roleId })
      .onConflictDoNothing({
        target: [membershipRoles.membershipId, membershipRoles.roleId],
      });
  }
}

const DEVELOPMENT_ROLES = [
  'organisation-admin',
  'intake-officer',
  'case-officer',
  'committee-chair',
  'records-officer',
] as const;

/**
 * Local bootstrap accounts that hold staff roles need a registered passkey so
 * password sign-in can open the workspace. The credential is not a real
 * WebAuthn key and is never created in production.
 */
async function ensureDevPasskey(userId: string): Promise<void> {
  const [existing] = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .limit(1);
  if (existing) return;
  await db.insert(passkeys).values({
    id: uuidv7(),
    userId,
    name: 'Development bootstrap passkey',
    credentialID: `dev-bootstrap-${userId}`,
    publicKey: 'development-bootstrap-passkey',
    counter: 0,
  });
}

/** Local opt-in only: a ready-to-use organisation + admin login. */
async function seedDevBootstrap(roleIdBySlug: Map<string, string>): Promise<void> {
  const adminEmail = 'admin@blakpath.local';
  const devPassword = 'blakpath-dev-admin-2026';
  const staffEmail = 'staff@blakpath.local';
  const staffPassword = 'blakpath-dev-staff-2026';
  const pendingMfaEmail = 'mfa-pending@blakpath.local';
  const pendingMfaPassword = 'blakpath-dev-mfa-2026';

  const orgId = uuidv7();
  await db
    .insert(organisations)
    .values({
      id: orgId,
      legalName: 'BlakPath Development Organisation',
      slug: 'dev-org',
      // Non-production only. Production uses activateOrganisation, which
      // refuses until the key handshake has passed.
      status: 'active',
      publicApplicationsOpen: true,
    })
    .onConflictDoNothing({ target: organisations.slug });

  // Resolve the org id whether we just inserted it or it already existed.
  const orgRow = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.slug, 'dev-org'))
    .limit(1);
  const organisationId = orgRow[0]?.id ?? orgId;
  const { ensureOrganisationKey } = await import('@/domains/organisation-keys');
  await ensureOrganisationKey(organisationId);

  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, adminEmail))
    .limit(1);
  const userId = existingUser?.id ?? uuidv7();
  if (!existingUser) {
    await db.insert(users).values({
      id: userId,
      name: 'Dev Admin',
      email: adminEmail,
      emailVerified: true,
    });

    await db.insert(accounts).values({
      id: uuidv7(),
      userId,
      providerId: 'credential',
      accountId: userId,
      password: await argon2Hash(devPassword, ARGON2_OPTIONS),
    });
  }
  await ensureDevPasskey(userId);

  const [existingMembership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.organisationId, organisationId), eq(memberships.userId, userId)),
    )
    .limit(1);
  const membershipId = existingMembership?.id ?? uuidv7();
  if (!existingMembership) {
    await db.insert(memberships).values({
      id: membershipId,
      organisationId,
      userId,
      status: 'active',
    });
  } else {
    await db
      .update(memberships)
      .set({ status: 'active' })
      .where(eq(memberships.id, membershipId));
  }

  // The development user deliberately combines the operational roles needed to
  // exercise every staff screen in the local end-to-end suite. This exception is
  // confined to the non-production bootstrap; production memberships must keep
  // the documented separation of duties and are assigned explicitly by an
  // organisation administrator.
  for (const slug of DEVELOPMENT_ROLES) {
    const roleId = roleIdBySlug.get(slug);
    if (roleId) {
      await db
        .insert(membershipRoles)
        .values({ id: uuidv7(), membershipId, roleId })
        .onConflictDoNothing({
          target: [membershipRoles.membershipId, membershipRoles.roleId],
        });
    }
  }

  await db
    .update(organisations)
    .set({ abn: '51824753556' })
    .where(and(eq(organisations.id, organisationId), isNull(organisations.abn)));

  const [existingTemplate] = await db
    .select({ id: certificateTemplates.id })
    .from(certificateTemplates)
    .where(eq(certificateTemplates.organisationId, organisationId))
    .limit(1);
  if (!existingTemplate) {
    const signatoryName = 'Dev Admin';
    const signatoryRole = 'Development signatory';
    await db.insert(certificateTemplates).values({
      id: uuidv7(),
      organisationId,
      templateVersion: 1,
      wording: DEFAULT_CERTIFICATE_WORDING,
      signatoryName,
      signatoryRole,
      contentHash: templateContentHash({
        wording: DEFAULT_CERTIFICATE_WORDING,
        signatoryName,
        signatoryRole,
        logoSha256: null,
      }),
      createdByUserId: userId,
    });
  }

  console.info('[seed] developer bootstrap ensured:');
  console.info(`         org:      dev-org (${organisationId})`);
  console.info(`         login:    ${adminEmail}`);
  console.info(`         password: ${devPassword}`);
  console.info(`         roles:    ${DEVELOPMENT_ROLES.join(', ')}`);

  // A verified account with no membership lets the browser suite exercise the
  // administrator's add/role/suspend/restore/revoke lifecycle without reaching
  // into the database from Playwright.
  const [existingStaff] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, staffEmail))
    .limit(1);
  if (!existingStaff) {
    const staffUserId = uuidv7();
    await db.insert(users).values({
      id: staffUserId,
      name: 'Dev Staff Member',
      email: staffEmail,
      emailVerified: true,
    });
    await db.insert(accounts).values({
      id: uuidv7(),
      userId: staffUserId,
      providerId: 'credential',
      accountId: staffUserId,
      password: await argon2Hash(staffPassword, ARGON2_OPTIONS),
    });
  }
  const [staffUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, staffEmail))
    .limit(1);
  if (staffUser) await ensureDevPasskey(staffUser.id);
  console.info(`         spare:    ${staffEmail} / ${staffPassword} (no membership)`);

  // Staff membership with no second factor, so the enrolment gate can be
  // exercised locally. Do not attach a passkey or a verified TOTP row.
  const intakeRoleId = roleIdBySlug.get('intake-officer');
  if (!intakeRoleId) {
    throw new Error('intake-officer system role is missing');
  }
  const [existingPending] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, pendingMfaEmail))
    .limit(1);
  const pendingUserId = existingPending?.id ?? uuidv7();
  if (!existingPending) {
    await db.insert(users).values({
      id: pendingUserId,
      name: 'Dev Staff Pending MFA',
      email: pendingMfaEmail,
      emailVerified: true,
    });
    await db.insert(accounts).values({
      id: uuidv7(),
      userId: pendingUserId,
      providerId: 'credential',
      accountId: pendingUserId,
      password: await argon2Hash(pendingMfaPassword, ARGON2_OPTIONS),
    });
  }
  const [existingPendingMembership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organisationId, organisationId),
        eq(memberships.userId, pendingUserId),
      ),
    )
    .limit(1);
  const pendingMembershipId = existingPendingMembership?.id ?? uuidv7();
  if (!existingPendingMembership) {
    await db.insert(memberships).values({
      id: pendingMembershipId,
      organisationId,
      userId: pendingUserId,
      status: 'active',
    });
  }
  await db
    .insert(membershipRoles)
    .values({ id: uuidv7(), membershipId: pendingMembershipId, roleId: intakeRoleId })
    .onConflictDoNothing({
      target: [membershipRoles.membershipId, membershipRoles.roleId],
    });
  console.info(
    `         pending:  ${pendingMfaEmail} / ${pendingMfaPassword} (no second factor)`,
  );

  await seedApplicantPortalFixture({
    organisationId,
    adminUserId: userId,
    applicantRoleId: roleIdBySlug.get('applicant'),
  });

  await seedSecondCouncil(roleIdBySlug);
  await seedTeamReadFixture(roleIdBySlug, organisationId);
}

/**
 * Non-production applicant account plus one own case and one other case.
 * The portal end-to-end test uses these references. Re-running the seed does
 * not duplicate them.
 */
async function seedApplicantPortalFixture(input: {
  organisationId: string;
  adminUserId: string;
  applicantRoleId: string | undefined;
}): Promise<void> {
  // Seal applicant data under the dev organisation key, like the services do.
  const { sealApplicationFields, sealNoteBody } =
    await import('@/lib/encryption/tenant-fields');
  const must = (value: string | undefined): string => {
    if (!value) throw new Error('Seed applicant name was not sealed');
    return value;
  };
  const applicantEmail = 'applicant@blakpath.local';
  const applicantPassword = 'blakpath-dev-applicant-2026';
  const [existingApplicant] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, applicantEmail))
    .limit(1);
  const applicantUserId = existingApplicant?.id ?? uuidv7();
  if (!existingApplicant) {
    await db.insert(users).values({
      id: applicantUserId,
      name: 'Dev Applicant',
      email: applicantEmail,
      emailVerified: true,
    });
    await db.insert(accounts).values({
      id: uuidv7(),
      userId: applicantUserId,
      providerId: 'credential',
      accountId: applicantUserId,
      password: await argon2Hash(applicantPassword, ARGON2_OPTIONS),
    });
  }

  const [existingMembership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organisationId, input.organisationId),
        eq(memberships.userId, applicantUserId),
      ),
    )
    .limit(1);
  const membershipId = existingMembership?.id ?? uuidv7();
  if (!existingMembership) {
    await db.insert(memberships).values({
      id: membershipId,
      organisationId: input.organisationId,
      userId: applicantUserId,
      status: 'active',
    });
  }
  if (!input.applicantRoleId) {
    throw new Error('Seed requires the applicant system role.');
  }
  await db
    .insert(membershipRoles)
    .values({ id: uuidv7(), membershipId, roleId: input.applicantRoleId })
    .onConflictDoNothing({
      target: [membershipRoles.membershipId, membershipRoles.roleId],
    });

  const [ownCase] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.organisationId, input.organisationId),
        eq(applications.reference, 'APP-OWN-CASE'),
      ),
    )
    .limit(1);
  if (!ownCase) {
    const applicationId = uuidv7();
    const sealed = await sealApplicationFields(input.organisationId, applicationId, {
      applicantName: 'Dev Applicant',
      reference: 'APP-OWN-CASE',
    });
    await db.insert(applications).values({
      id: applicationId,
      organisationId: input.organisationId,
      reference: 'APP-OWN-CASE',
      applicantUserId,
      applicantName: must(sealed.applicantName),
      referenceBidx: sealed.referenceBidx,
      applicantNameBidx: sealed.applicantNameBidx,
      applicantNameTokenBidx: sealed.applicantNameTokenBidx,
      status: 'awaiting_evidence',
      createdByUserId: input.adminUserId,
      submittedAt: new Date('2026-09-02T01:00:00.000Z'),
    });
    await db.insert(applicationStatusHistory).values([
      {
        id: uuidv7(),
        organisationId: input.organisationId,
        applicationId,
        fromStatus: null,
        toStatus: 'draft',
        action: 'create',
        actorUserId: applicantUserId,
        createdAt: new Date('2026-09-01T01:00:00.000Z'),
      },
      {
        id: uuidv7(),
        organisationId: input.organisationId,
        applicationId,
        fromStatus: 'draft',
        toStatus: 'submitted',
        action: 'submit',
        actorUserId: applicantUserId,
        createdAt: new Date('2026-09-02T01:00:00.000Z'),
      },
      {
        id: uuidv7(),
        organisationId: input.organisationId,
        applicationId,
        fromStatus: 'submitted',
        toStatus: 'awaiting_evidence',
        action: 'request_evidence',
        actorUserId: input.adminUserId,
        createdAt: new Date('2026-09-03T01:00:00.000Z'),
      },
    ]);
    const sharedNoteId = uuidv7();
    const staffNoteId = uuidv7();
    await db.insert(applicationNotes).values([
      {
        id: sharedNoteId,
        organisationId: input.organisationId,
        applicationId,
        authorUserId: input.adminUserId,
        body: await sealNoteBody(
          input.organisationId,
          sharedNoteId,
          'Please bring a birth certificate if you have one.',
        ),
        visibility: 'shared',
      },
      {
        id: staffNoteId,
        organisationId: input.organisationId,
        applicationId,
        authorUserId: input.adminUserId,
        body: await sealNoteBody(
          input.organisationId,
          staffNoteId,
          'Internal staffing note not for the applicant.',
        ),
        visibility: 'staff',
      },
    ]);
    await db.insert(evidenceRequests).values({
      id: uuidv7(),
      organisationId: input.organisationId,
      applicationId,
      requestedByUserId: input.adminUserId,
      description: 'A photo of a birth certificate, if you have one.',
      status: 'open',
    });
  }

  const [otherCase] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.organisationId, input.organisationId),
        eq(applications.reference, 'APP-OTHER-CASE'),
      ),
    )
    .limit(1);
  if (!otherCase) {
    const otherId = uuidv7();
    const sealed = await sealApplicationFields(input.organisationId, otherId, {
      applicantName: 'Someone Else',
      reference: 'APP-OTHER-CASE',
    });
    await db.insert(applications).values({
      id: otherId,
      organisationId: input.organisationId,
      reference: 'APP-OTHER-CASE',
      applicantUserId: input.adminUserId,
      applicantName: must(sealed.applicantName),
      referenceBidx: sealed.referenceBidx,
      applicantNameBidx: sealed.applicantNameBidx,
      applicantNameTokenBidx: sealed.applicantNameTokenBidx,
      status: 'submitted',
      createdByUserId: input.adminUserId,
    });
  }

  await db
    .insert(organisations)
    .values({
      id: uuidv7(),
      legalName: 'Closed Directory Organisation',
      slug: 'closed-org',
      status: 'active',
      publicApplicationsOpen: false,
    })
    .onConflictDoNothing({ target: organisations.slug });

  console.info(`         applicant: ${applicantEmail} / ${applicantPassword}`);
  console.info('         portal:    APP-OWN-CASE (own) and APP-OTHER-CASE (not theirs)');
}

/**
 * Second council with its own admin and one application. E2E isolation checks
 * use these ids; the admin is not a member of the development organisation.
 */
async function seedSecondCouncil(roleIdBySlug: Map<string, string>): Promise<void> {
  await db
    .insert(organisations)
    .values({
      id: DEV_TENANT_B.organisationId,
      legalName: DEV_TENANT_B.legalName,
      slug: DEV_TENANT_B.slug,
      status: 'active',
      publicApplicationsOpen: false,
    })
    .onConflictDoNothing({ target: organisations.slug });

  const [orgRow] = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.slug, DEV_TENANT_B.slug))
    .limit(1);
  const organisationId = orgRow?.id ?? DEV_TENANT_B.organisationId;
  const { ensureOrganisationKey } = await import('@/domains/organisation-keys');
  await ensureOrganisationKey(organisationId);

  const userId = await ensureStaffUser({
    email: DEV_TENANT_B.adminEmail,
    name: 'Second Council Admin',
    password: DEV_TENANT_B.adminPassword,
  });
  const membershipId = await ensureActiveMembership(organisationId, userId);
  await grantRoles(membershipId, DEVELOPMENT_ROLES, roleIdBySlug);

  await db
    .insert(clients)
    .values({
      id: DEV_TENANT_B.clientId,
      organisationId,
      displayName: DEV_TENANT_B.clientName,
    })
    .onConflictDoNothing({ target: clients.id });

  await ensureSealedApplication({
    id: DEV_TENANT_B.applicationId,
    organisationId,
    reference: DEV_TENANT_B.applicationReference,
    applicantName: DEV_TENANT_B.applicantName,
    clientId: DEV_TENANT_B.clientId,
  });

  console.info(`[seed] second council ensured: ${DEV_TENANT_B.slug} (${organisationId})`);
  console.info(`         login:    ${DEV_TENANT_B.adminEmail}`);
}

/**
 * One team-scoped application in the primary council, plus two case officers:
 * one on the team, one not. Proves assigned read versus unassigned deny.
 */
async function seedTeamReadFixture(
  roleIdBySlug: Map<string, string>,
  organisationId: string,
): Promise<void> {
  await db
    .insert(teams)
    .values({
      id: DEV_TEAM_FIXTURE.teamId,
      organisationId,
      slug: DEV_TEAM_FIXTURE.teamSlug,
      name: DEV_TEAM_FIXTURE.teamName,
    })
    .onConflictDoNothing({ target: [teams.organisationId, teams.slug] });

  const [teamRow] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(
        eq(teams.organisationId, organisationId),
        eq(teams.slug, DEV_TEAM_FIXTURE.teamSlug),
      ),
    )
    .limit(1);
  const teamId = teamRow?.id;
  if (!teamId) return;

  const assignedUserId = await ensureStaffUser({
    email: DEV_TEAM_FIXTURE.assignedEmail,
    name: 'E2E Case Officer',
    password: DEV_TEAM_FIXTURE.assignedPassword,
  });
  const unassignedUserId = await ensureStaffUser({
    email: DEV_TEAM_FIXTURE.unassignedEmail,
    name: 'E2E Unassigned Officer',
    password: DEV_TEAM_FIXTURE.unassignedPassword,
  });

  const assignedMembershipId = await ensureActiveMembership(
    organisationId,
    assignedUserId,
  );
  const unassignedMembershipId = await ensureActiveMembership(
    organisationId,
    unassignedUserId,
  );
  await grantRoles(assignedMembershipId, ['case-officer'], roleIdBySlug);
  await grantRoles(unassignedMembershipId, ['case-officer'], roleIdBySlug);

  await db
    .insert(teamMemberships)
    .values({
      id: uuidv7(),
      organisationId,
      teamId,
      userId: assignedUserId,
      role: 'member',
    })
    .onConflictDoNothing({
      target: [teamMemberships.teamId, teamMemberships.userId],
    });

  await db
    .insert(clients)
    .values({
      id: DEV_TEAM_FIXTURE.clientId,
      organisationId,
      displayName: DEV_TEAM_FIXTURE.clientName,
      assignedTeamId: teamId,
    })
    .onConflictDoNothing({ target: clients.id });

  await ensureSealedApplication({
    id: DEV_TEAM_FIXTURE.applicationId,
    organisationId,
    reference: DEV_TEAM_FIXTURE.applicationReference,
    applicantName: DEV_TEAM_FIXTURE.applicantName,
    clientId: DEV_TEAM_FIXTURE.clientId,
  });

  console.info(`[seed] team read fixture ensured: ${DEV_TEAM_FIXTURE.teamSlug}`);
}

async function main(): Promise<void> {
  console.info('[seed] starting…');
  const decision = decideDevSeed({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    allowDevSeed: env.ALLOW_DEV_SEED,
  });
  if (decision.action === 'refuse') {
    throw new Error(`[seed] ${decision.reason}`);
  }

  await seedPermissions();
  const roleIdBySlug = await seedRoles();
  await seedRolePermissions(roleIdBySlug);
  if (decision.action === 'create') {
    await seedDevBootstrap(roleIdBySlug);
  } else {
    console.info(`[seed] skipping developer accounts: ${decision.reason}`);
  }
  console.info('[seed] done');
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void sqlClient.end({ timeout: 5 });
  });
