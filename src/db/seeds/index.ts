import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { hash as argon2Hash } from '@node-rs/argon2';
import { uuidv7 } from 'uuidv7';
import { db, sqlClient } from '@/db/client';
import { env } from '@/lib/env';
import {
  accounts,
  memberships,
  membershipRoles,
  organisations,
  permissions,
  rolePermissions,
  roles,
  users,
} from '@/db/schema';
import { PERMISSION_SEED } from '@/lib/permissions/catalog';
import { SYSTEM_ROLES, SYSTEM_ROLE_SEED } from '@/lib/permissions/roles';

/**
 * Idempotent database seed.
 *
 * Seeds the two things the application cannot run without: the permission
 * catalogue and the system role templates (with their permission grants). In
 * non-production it also creates a bootstrap organisation and administrator so a
 * developer can sign in and exercise the app end to end.
 *
 * SAFETY: the developer bootstrap is refused when NODE_ENV=production. Seeding
 * is idempotent — re-running never duplicates rows.
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

/** Non-production only: a ready-to-use organisation + admin login. */
async function seedDevBootstrap(roleIdBySlug: Map<string, string>): Promise<void> {
  if (env.NODE_ENV === 'production') {
    console.info('[seed] production — skipping developer bootstrap');
    return;
  }

  const adminEmail = 'admin@blakpath.local';
  const devPassword = 'blakpath-dev-admin-2026';
  const staffEmail = 'staff@blakpath.local';
  const staffPassword = 'blakpath-dev-staff-2026';

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
  const developmentRoles = [
    'organisation-admin',
    'intake-officer',
    'case-officer',
    'committee-chair',
    'records-officer',
  ] as const;
  for (const slug of developmentRoles) {
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

  console.info('[seed] developer bootstrap ensured:');
  console.info(`         org:      dev-org (${organisationId})`);
  console.info(`         login:    ${adminEmail}`);
  console.info(`         password: ${devPassword}`);
  console.info(`         roles:    ${developmentRoles.join(', ')}`);

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
  console.info(`         spare:    ${staffEmail} / ${staffPassword} (no membership)`);
}

async function main(): Promise<void> {
  console.info('[seed] starting…');
  await seedPermissions();
  const roleIdBySlug = await seedRoles();
  await seedRolePermissions(roleIdBySlug);
  await seedDevBootstrap(roleIdBySlug);
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
