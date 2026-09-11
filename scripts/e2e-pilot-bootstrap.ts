import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hash as argon2Hash } from '@node-rs/argon2';
import { uuidv7 } from 'uuidv7';
import { db, sqlClient } from '../src/db/client';
import {
  accounts,
  membershipRoles,
  memberships,
  organisations,
  rolePermissions,
  roles,
  users,
} from '../src/db/schema';

/**
 * TEMPORARY pilot bootstrap for live EKS verification only.
 *
 * Creates one pilot council org and one admin login, prints the credentials
 * ONCE to stdout (collect from the Job logs, then delete the Job). Remove the
 * org and the account after verification — this must never back real records.
 */

const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

const PILOT_ROLES = [
  'organisation-admin',
  'intake-officer',
  'case-officer',
  'committee-chair',
  'records-officer',
] as const;

async function main(): Promise<void> {
  const email = 'pilot-admin@blakpath.yumait.au';
  const password = `Pilot-${randomBytes(18).toString('base64url')}`;

  const [existingOrg] = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.slug, 'pilot-council'))
    .limit(1);
  const organisationId = existingOrg?.id ?? uuidv7();
  if (!existingOrg) {
    await db.insert(organisations).values({
      id: organisationId,
      legalName: 'Pilot Council (E2E verification only)',
      organisationType: 'council',
      slug: 'pilot-council',
      status: 'active',
      publicApplicationsOpen: false,
    });
  }

  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const userId = existingUser?.id ?? uuidv7();
  if (!existingUser) {
    await db.insert(users).values({ id: userId, name: 'Pilot Admin', email, emailVerified: true });
    await db.insert(accounts).values({
      id: uuidv7(),
      userId,
      providerId: 'credential',
      accountId: userId,
      password: await argon2Hash(password, ARGON2_OPTIONS),
    });
  }

  const [existingMembership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  const membershipId = existingMembership?.id ?? uuidv7();
  if (!existingMembership) {
    await db.insert(memberships).values({
      id: membershipId,
      organisationId,
      userId,
      status: 'active',
    });
  }

  // Adopt system role templates into tenant roles with copied grants.
  const allRoles = await db.select().from(roles);
  for (const slug of PILOT_ROLES) {
    const template = allRoles.find((r) => r.organisationId === null && r.slug === slug);
    if (!template) continue;
    let tenant = allRoles.find((r) => r.organisationId === organisationId && r.slug === slug);
    if (!tenant) {
      const tenantRoleId = uuidv7();
      await db.insert(roles).values({
        id: tenantRoleId,
        organisationId,
        slug: template.slug,
        name: template.name,
        description: template.description,
        isSystem: false,
      });
      tenant = { ...template, id: tenantRoleId, organisationId } as typeof template;
      allRoles.push(tenant);
    }
    const templateGrants = await db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, template.id));
    for (const g of templateGrants) {
      await db
        .insert(rolePermissions)
        .values({ id: uuidv7(), roleId: tenant.id, permissionKey: g.permissionKey })
        .onConflictDoNothing();
    }
    await db
      .insert(membershipRoles)
      .values({ id: uuidv7(), membershipId, roleId: tenant.id })
      .onConflictDoNothing();
  }

  console.info(JSON.stringify({ email, password, organisationId }));
}

main()
  .catch((err) => {
    console.error('[pilot] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void sqlClient.end({ timeout: 5 });
  });
