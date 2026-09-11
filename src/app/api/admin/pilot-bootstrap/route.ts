import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
  const organisationId = uuidv7();
  await db.insert(organisations).values({
    id: organisationId,
    legalName: 'Pilot Council (E2E verification only)',
    organisationType: 'council',
    slug: 'pilot-council',
    status: 'active',
    publicApplicationsOpen: false,
  });

  const userId = uuidv7();
  await db
    .insert(users)
    .values({ id: userId, name: 'Pilot Admin', email, emailVerified: true });
  await db.insert(accounts).values({
    id: uuidv7(),
    userId,
    providerId: 'credential',
    accountId: userId,
    password: await argon2Hash(password, ARGON2_OPTIONS),
  });

  const membershipId = uuidv7();
  await db.insert(memberships).values({
    id: membershipId,
    organisationId,
    userId,
    status: 'active',
  });

  const allRoles = await db.select().from(roles);
  for (const slug of PILOT_ROLES) {
    const template = allRoles.find((r) => r.organisationId === null && r.slug === slug);
    if (!template) continue;
    const tenantRoleId = uuidv7();
    await db.insert(roles).values({
      id: tenantRoleId,
      organisationId,
      slug: template.slug,
      name: template.name,
      description: template.description,
      isSystem: false,
    });
    const templateGrants = await db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, template.id));
    for (const g of templateGrants) {
      await db
        .insert(rolePermissions)
        .values({ id: uuidv7(), roleId: tenantRoleId, permissionKey: g.permissionKey })
        .onConflictDoNothing();
    }
    await db
      .insert(membershipRoles)
      .values({ id: uuidv7(), membershipId, roleId: tenantRoleId })
      .onConflictDoNothing();
  }

  await recordAudit({
    action: 'membership.invitation_accepted',
    resourceType: 'membership',
    resourceId: membershipId,
    result: 'success',
    reason: 'pilot bootstrap',
    organisationId,
    actorUserId: userId,
  });

  return NextResponse.json({ email, password, organisationId }, { status: 201 });
}
