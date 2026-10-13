import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { hash as argon2Hash } from '@node-rs/argon2';
import { uuidv7 } from 'uuidv7';
import { type NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import {
  accounts,
  membershipRoles,
  memberships,
  organisations,
  rolePermissions,
  roles,
  users,
} from '@/db/schema';
import { env } from '@/lib/env';
import { recordAudit } from '@/domains/audit/service';

/**
 * POST /api/admin/pilot-bootstrap — one-time live-verification bootstrap.
 *
 * Guarded by PILOT_BOOTSTRAP_TOKEN (timing-safe compare). Unset token = 503.
 * Refuses when ANY organisation already exists, so it can only ever run on a
 * fresh database. Creates one pilot council + verified admin login and returns
 * the credentials ONCE. Rotate/remove the account and unset the token after
 * verification — this must never back real records.
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

export async function POST(request: NextRequest): Promise<Response> {
  const expected = env.PILOT_BOOTSTRAP_TOKEN;
  if (!expected) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  let body: { token?: string };
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const provided = createHash('sha256')
    .update(body.token ?? '')
    .digest();
  const wanted = createHash('sha256').update(expected).digest();
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const existingOrgs = await db
    .select({ id: organisations.id })
    .from(organisations)
    .limit(1);
  if (existingOrgs.length > 0) {
    return NextResponse.json({ error: 'Already bootstrapped' }, { status: 409 });
  }

  const email = 'pilot-admin@blakpath.yumait.au';
  const password = `Pilot-${randomBytes(18).toString('base64url')}`;
  const passwordHash = await argon2Hash(password, ARGON2_OPTIONS);
  const organisationId = uuidv7();
  const userId = uuidv7();
  const membershipId = uuidv7();

  const allRoles = await db.select().from(roles);
  const templates = PILOT_ROLES.flatMap((slug) => {
    const template = allRoles.find(
      (role) => role.organisationId === null && role.slug === slug,
    );
    return template ? [template] : [];
  });
  const grants =
    templates.length === 0
      ? []
      : await db
          .select()
          .from(rolePermissions)
          .where(
            inArray(
              rolePermissions.roleId,
              templates.map((template) => template.id),
            ),
          );

  await db.transaction(async (tx) => {
    await tx.insert(organisations).values({
      id: organisationId,
      legalName: 'Pilot Council (E2E verification only)',
      organisationType: 'council',
      slug: 'pilot-council',
      status: 'active',
      publicApplicationsOpen: false,
    });
    await tx
      .insert(users)
      .values({ id: userId, name: 'Pilot Admin', email, emailVerified: true });
    await tx.insert(accounts).values({
      id: uuidv7(),
      userId,
      providerId: 'credential',
      accountId: userId,
      password: passwordHash,
    });
    await tx.insert(memberships).values({
      id: membershipId,
      organisationId,
      userId,
      status: 'active',
    });

    for (const template of templates) {
      const tenantRoleId = uuidv7();
      await tx.insert(roles).values({
        id: tenantRoleId,
        organisationId,
        slug: template.slug,
        name: template.name,
        description: template.description,
        isSystem: false,
      });
      for (const grant of grants) {
        if (grant.roleId !== template.id) continue;
        await tx
          .insert(rolePermissions)
          .values({
            id: uuidv7(),
            roleId: tenantRoleId,
            permissionKey: grant.permissionKey,
          })
          .onConflictDoNothing();
      }
      await tx
        .insert(membershipRoles)
        .values({ id: uuidv7(), membershipId, roleId: tenantRoleId })
        .onConflictDoNothing();
    }

    await recordAudit(
      {
        action: 'membership.invitation_accepted',
        resourceType: 'membership',
        resourceId: membershipId,
        result: 'success',
        reason: 'pilot bootstrap',
        organisationId,
        actorUserId: userId,
      },
      tx,
    );
  });

  return NextResponse.json({ email, password, organisationId }, { status: 201 });
}
