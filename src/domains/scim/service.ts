import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { db } from '@/db/client';
import { membershipRoles, memberships, organisations, roles, users } from '@/db/schema';
import { recordAudit } from '@/domains/audit/service';
import { env } from '@/lib/env';
import { AuthorizationError } from '@/lib/permissions/errors';
import { isSystemRoleSlug, type SystemRoleSlug } from '@/lib/permissions/roles';

/**
 * SCIM 2.0 directory provisioning — tenant-scoped, bearer-authenticated.
 *
 * Maps IdP user lifecycle onto membership status transitions (no parallel
 * identity store): provision → active membership, deactivate → suspended,
 * delete → revoked. Roles come from an explicit allowlist mapping of IdP
 * group display names to system role slugs; unmapped groups are ignored, so
 * an IdP can never escalate beyond the allowlist.
 */

const ALLOWED_SCIM_ROLES: readonly SystemRoleSlug[] = [
  'intake-officer',
  'case-officer',
  'genealogy-officer',
  'committee-member',
  'records-officer',
  'organisation-admin',
];

const scimUserSchema = z.object({
  userName: z.email().max(320),
  active: z.boolean().optional(),
  name: z
    .object({
      givenName: z.string().max(200).optional(),
      familyName: z.string().max(200).optional(),
      formatted: z.string().max(400).optional(),
    })
    .optional(),
  emails: z
    .array(z.object({ value: z.email().max(320), primary: z.boolean().optional() }))
    .optional(),
  groups: z.array(z.object({ display: z.string().max(200) })).optional(),
  entitlements: z.array(z.object({ value: z.string().max(200) })).optional(),
});

export type ScimUserInput = z.input<typeof scimUserSchema>;

/** Verify the SCIM bearer credential. Missing env = SCIM off (deny all). */
export function verifyScimBearer(request: Request): void {
  const expected = env.SCIM_BEARER_TOKEN;
  const auth = request.headers.get('authorization');
  if (!expected || !auth || !auth.startsWith('Bearer ')) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  const provided = createHash('sha256').update(auth.slice('Bearer '.length)).digest();
  const wanted = createHash('sha256').update(expected).digest();
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    throw new AuthorizationError('POLICY_DENIED');
  }
}

function mapGroupsToRoles(input: ScimUserInput): SystemRoleSlug[] {
  const names = [
    ...(input.groups ?? []).map((g) => g.display),
    ...(input.entitlements ?? []).map((e) => e.value),
  ].map((n) =>
    n
      .trim()
      .toLowerCase()
      .replace(/[^a-z-]/g, ''),
  );
  const slugs = names.filter((n): n is SystemRoleSlug => isSystemRoleSlug(n));
  return slugs.filter((s) => ALLOWED_SCIM_ROLES.includes(s));
}

function displayName(input: ScimUserInput): string {
  const formatted = input.name?.formatted?.trim();
  if (formatted) return formatted;
  const parts = [input.name?.givenName, input.name?.familyName]
    .map((p) => p?.trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return input.userName;
}

/** Provision (create or reactivate) a user + active membership for the org. */
export async function provisionScimUser(
  organisationId: string,
  raw: unknown,
): Promise<{ id: string; userName: string }> {
  const input = scimUserSchema.parse(raw);
  const email = input.userName.trim().toLowerCase();

  const [org] = await db
    .select({ id: organisations.id, status: organisations.status })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (!org || org.status !== 'active') throw new AuthorizationError('POLICY_DENIED');

  let userId: string;
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existingUser) {
    userId = existingUser.id;
  } else {
    userId = uuidv7();
    await db.insert(users).values({
      id: userId,
      name: displayName(input),
      email,
      emailVerified: true,
    });
  }

  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.organisationId, organisationId), eq(memberships.userId, userId)),
    )
    .limit(1);
  let membershipId = existing?.id;
  if (existing) {
    await db
      .update(memberships)
      .set({ status: input.active === false ? 'suspended' : 'active' })
      .where(eq(memberships.id, existing.id));
    membershipId = existing.id;
  } else {
    membershipId = uuidv7();
    await db.insert(memberships).values({
      id: membershipId,
      organisationId,
      userId,
      status: input.active === false ? 'suspended' : 'active',
    });
  }

  const slugs = mapGroupsToRoles(input);
  if (slugs.length > 0 && membershipId) {
    const tenantRoles = await db
      .select({ id: roles.id, slug: roles.slug })
      .from(roles)
      .where(eq(roles.organisationId, organisationId));
    const bySlug = new Map(tenantRoles.map((r) => [r.slug, r.id]));
    for (const slug of slugs) {
      const roleId = bySlug.get(slug);
      if (!roleId) continue;
      await db
        .insert(membershipRoles)
        .values({ id: uuidv7(), membershipId, roleId })
        .onConflictDoNothing({
          target: [membershipRoles.membershipId, membershipRoles.roleId],
        });
    }
  }

  await recordAudit({
    action: 'membership.invitation_accepted',
    resourceType: 'membership',
    resourceId: membershipId ?? null,
    result: 'success',
    reason: 'scim provision',
    organisationId,
  });
  return { id: membershipId ?? userId, userName: email };
}

/** Deactivate (suspend) or revoke a provisioned membership by email. */
export async function setScimUserActive(
  organisationId: string,
  email: string,
  active: boolean,
): Promise<void> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user) throw new AuthorizationError('POLICY_DENIED');
  const updated = await db
    .update(memberships)
    .set({ status: active ? 'active' : 'suspended' })
    .where(
      and(
        eq(memberships.organisationId, organisationId),
        eq(memberships.userId, user.id),
      ),
    )
    .returning({ id: memberships.id });
  if (!updated[0]) throw new AuthorizationError('POLICY_DENIED');
  await recordAudit({
    action: active ? 'membership.reinstated' : 'membership.suspended',
    resourceType: 'membership',
    resourceId: updated[0].id,
    result: 'success',
    reason: 'scim',
    organisationId,
  });
}
