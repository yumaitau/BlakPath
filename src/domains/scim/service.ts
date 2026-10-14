import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db, type Database } from '@/db/client';
import {
  membershipRoles,
  memberships,
  organisations,
  roles,
  scimCredentials,
  sessions,
  users,
} from '@/db/schema';
import { recordAudit } from '@/domains/audit/service';
import { parseBearer } from '@/domains/api-keys/keys';
import { AuthorizationError } from '@/lib/permissions/errors';
import { enforceScimRateLimit } from './rate-limit';
import { diffRoleIds, mapGroupsToRoles, scimControllableRoles } from './roles';
import { scimUserSchema, type ScimUserInput } from './schemas';
import { hashScimToken, looksLikeScimToken } from './tokens';

/**
 * SCIM 2.0 directory provisioning.
 *
 * The bearer token resolves to one organisation. The path organisation must
 * match that credential; it is never the source of tenancy. Group lists replace
 * the SCIM-managed role set. A revoked membership is terminal for SCIM.
 * Suspending or revoking access also deletes the user's sessions.
 */

type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ScimPrincipal {
  readonly organisationId: string;
  readonly credentialId: string;
  readonly allowOrganisationAdmin: boolean;
}

const ORGANISATION_ADMIN_SLUG = 'organisation-admin';

function displayName(input: ScimUserInput): string {
  const formatted = input.name?.formatted?.trim();
  if (formatted) return formatted;
  const parts = [input.name?.givenName, input.name?.familyName]
    .map((part) => part?.trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return input.userName;
}

async function touchLastUsed(credentialId: string): Promise<void> {
  try {
    await db
      .update(scimCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(scimCredentials.id, credentialId));
  } catch {
    // A failed stamp must not deny a credential that already matched.
  }
}

/**
 * Resolve the SCIM caller from the bearer token. The organisation comes from
 * the credential row. `pathOrganisationId` must equal it.
 */
export async function authenticateScim(
  request: Request,
  pathOrganisationId: string,
): Promise<ScimPrincipal> {
  const raw = parseBearer(request.headers.get('authorization'));
  if (!raw || !looksLikeScimToken(raw)) {
    enforceScimRateLimit('invalid');
    throw new AuthorizationError('POLICY_DENIED');
  }
  const tokenHash = hashScimToken(raw);
  enforceScimRateLimit(tokenHash);

  const [credential] = await db
    .select({
      id: scimCredentials.id,
      organisationId: scimCredentials.organisationId,
      allowOrganisationAdmin: scimCredentials.allowOrganisationAdmin,
      revokedAt: scimCredentials.revokedAt,
      expiresAt: scimCredentials.expiresAt,
    })
    .from(scimCredentials)
    .where(eq(scimCredentials.tokenHash, tokenHash))
    .limit(1);
  if (!credential || credential.revokedAt) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  if (credential.organisationId !== pathOrganisationId) {
    throw new AuthorizationError('POLICY_DENIED');
  }

  const [org] = await db
    .select({ id: organisations.id, status: organisations.status })
    .from(organisations)
    .where(eq(organisations.id, credential.organisationId))
    .limit(1);
  if (!org || org.status !== 'active') {
    throw new AuthorizationError('POLICY_DENIED');
  }

  await touchLastUsed(credential.id);
  return {
    organisationId: credential.organisationId,
    credentialId: credential.id,
    allowOrganisationAdmin: credential.allowOrganisationAdmin,
  };
}

function assertSameOrg(auth: ScimPrincipal, pathOrganisationId: string): void {
  if (auth.organisationId !== pathOrganisationId) {
    throw new AuthorizationError('POLICY_DENIED');
  }
}

async function soleActiveAdministrator(
  tx: DbTx,
  organisationId: string,
  membershipId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ membershipId: memberships.id })
    .from(memberships)
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .where(
      and(
        eq(memberships.organisationId, organisationId),
        eq(memberships.status, 'active'),
        eq(roles.slug, ORGANISATION_ADMIN_SLUG),
      ),
    );
  const ids = new Set(rows.map((row) => row.membershipId));
  return ids.size <= 1 && ids.has(membershipId);
}

/** Sessions are not tenant-scoped, so ending access also ends the user's cookies. */
async function deleteUserSessions(tx: DbTx, userId: string): Promise<string[]> {
  const removed = await tx
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return removed.map((row) => row.id);
}

interface RoleSync {
  added: string[];
  removed: string[];
}

/**
 * Replace the SCIM-managed roles with the IdP set. Roles outside that set are
 * left alone. The last active organisation-admin role is kept so directory
 * sync cannot lock the tenant out of administration.
 */
async function replaceScimRoles(
  tx: DbTx,
  organisationId: string,
  membershipId: string,
  membershipStatus: 'active' | 'suspended' | 'invited',
  desiredSlugs: readonly string[],
  allowOrganisationAdmin: boolean,
): Promise<RoleSync> {
  const controllable = scimControllableRoles(allowOrganisationAdmin);
  const tenantRoles = await tx
    .select({ id: roles.id, slug: roles.slug })
    .from(roles)
    .where(eq(roles.organisationId, organisationId));
  const bySlug = new Map(tenantRoles.map((role) => [role.slug, role.id]));
  const slugById = new Map(tenantRoles.map((role) => [role.id, role.slug]));
  const controllableIds = controllable
    .map((slug) => bySlug.get(slug))
    .filter((id): id is string => Boolean(id));
  if (controllableIds.length === 0) return { added: [], removed: [] };

  const current = await tx
    .select({ roleId: membershipRoles.roleId })
    .from(membershipRoles)
    .where(
      and(
        eq(membershipRoles.membershipId, membershipId),
        inArray(membershipRoles.roleId, controllableIds),
      ),
    );
  const desiredIds = desiredSlugs
    .map((slug) => bySlug.get(slug))
    .filter((id): id is string => Boolean(id));
  const adminRoleId = bySlug.get(ORGANISATION_ADMIN_SLUG);
  const currentIds = current.map((row) => row.roleId);
  const nextDesired = new Set(desiredIds);
  if (
    adminRoleId &&
    currentIds.includes(adminRoleId) &&
    !nextDesired.has(adminRoleId) &&
    membershipStatus === 'active' &&
    (await soleActiveAdministrator(tx, organisationId, membershipId))
  ) {
    nextDesired.add(adminRoleId);
  }

  const diff = diffRoleIds(currentIds, [...nextDesired]);
  if (diff.remove.length > 0) {
    await tx
      .delete(membershipRoles)
      .where(
        and(
          eq(membershipRoles.membershipId, membershipId),
          inArray(membershipRoles.roleId, diff.remove),
        ),
      );
  }
  for (const roleId of diff.add) {
    await tx
      .insert(membershipRoles)
      .values({ id: uuidv7(), membershipId, roleId })
      .onConflictDoNothing({
        target: [membershipRoles.membershipId, membershipRoles.roleId],
      });
  }
  return {
    added: diff.add.map((id) => slugById.get(id) ?? id),
    removed: diff.remove.map((id) => slugById.get(id) ?? id),
  };
}

async function auditRoleChanges(
  organisationId: string,
  membershipId: string,
  credentialId: string,
  changes: RoleSync,
): Promise<void> {
  for (const slug of changes.removed) {
    await recordAudit({
      action: 'membership.role_removed',
      resourceType: 'membership',
      resourceId: membershipId,
      result: 'success',
      reason: 'scim',
      organisationId,
      actorUserId: null,
      actingRole: 'scim',
      after: { data: { role: slug, credentialId }, allow: ['role', 'credentialId'] },
    });
  }
  for (const slug of changes.added) {
    await recordAudit({
      action: 'membership.role_assigned',
      resourceType: 'membership',
      resourceId: membershipId,
      result: 'success',
      reason: 'scim',
      organisationId,
      actorUserId: null,
      actingRole: 'scim',
      after: { data: { role: slug, credentialId }, allow: ['role', 'credentialId'] },
    });
  }
}

async function auditSessionRevokes(
  organisationId: string,
  sessionIds: readonly string[],
): Promise<void> {
  for (const sessionId of sessionIds) {
    await recordAudit({
      action: 'session.revoked',
      resourceType: 'session',
      resourceId: sessionId,
      result: 'success',
      reason: 'scim',
      organisationId,
      actorUserId: null,
      actingRole: 'scim',
    });
  }
}

async function findUserId(email: string): Promise<string | undefined> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return user?.id;
}

/** Provision or update a user. Revoked memberships are not reactivated. */
export async function provisionScimUser(
  auth: ScimPrincipal,
  pathOrganisationId: string,
  raw: unknown,
): Promise<{ id: string; userName: string; active: boolean }> {
  assertSameOrg(auth, pathOrganisationId);
  const input = scimUserSchema.parse(raw);
  const email = input.userName.trim().toLowerCase();
  const organisationId = auth.organisationId;
  const nextStatus = input.active === false ? 'suspended' : 'active';
  const desired = mapGroupsToRoles(input, auth.allowOrganisationAdmin);

  let userId = await findUserId(email);
  if (!userId) {
    userId = uuidv7();
    await db.insert(users).values({
      id: userId,
      name: displayName(input),
      email,
      emailVerified: true,
    });
  }

  const [existing] = await db
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .where(
      and(eq(memberships.organisationId, organisationId), eq(memberships.userId, userId)),
    )
    .limit(1);

  if (existing?.status === 'revoked') {
    await recordAudit({
      action: 'membership.reinstated',
      resourceType: 'membership',
      resourceId: existing.id,
      result: 'denied',
      reason: 'scim',
      organisationId,
      actorUserId: null,
      actingRole: 'scim',
    });
    throw new AuthorizationError('POLICY_DENIED');
  }

  const outcome = await db.transaction(async (tx) => {
    if (
      existing &&
      existing.status === 'active' &&
      nextStatus !== 'active' &&
      (await soleActiveAdministrator(tx, organisationId, existing.id))
    ) {
      throw new AuthorizationError('POLICY_DENIED');
    }

    let membershipId = existing?.id;
    if (existing) {
      await tx
        .update(memberships)
        .set({ status: nextStatus })
        .where(eq(memberships.id, existing.id));
    } else {
      membershipId = uuidv7();
      await tx.insert(memberships).values({
        id: membershipId,
        organisationId,
        userId,
        status: nextStatus,
      });
    }
    if (!membershipId) throw new AuthorizationError('POLICY_DENIED');

    const changes = await replaceScimRoles(
      tx,
      organisationId,
      membershipId,
      nextStatus === 'suspended' ? 'suspended' : 'active',
      desired,
      auth.allowOrganisationAdmin,
    );
    const revokedSessionIds =
      nextStatus === 'suspended' ? await deleteUserSessions(tx, userId) : [];
    return { membershipId, changes, revokedSessionIds, created: !existing };
  });

  await auditRoleChanges(
    organisationId,
    outcome.membershipId,
    auth.credentialId,
    outcome.changes,
  );
  await auditSessionRevokes(organisationId, outcome.revokedSessionIds);
  if (existing && existing.status !== nextStatus) {
    await recordAudit({
      action: nextStatus === 'active' ? 'membership.reinstated' : 'membership.suspended',
      resourceType: 'membership',
      resourceId: outcome.membershipId,
      result: 'success',
      reason: 'scim',
      organisationId,
      actorUserId: null,
      actingRole: 'scim',
    });
  }
  if (outcome.created) {
    await recordAudit({
      action: 'membership.invitation_accepted',
      resourceType: 'membership',
      resourceId: outcome.membershipId,
      result: 'success',
      reason: 'scim provision',
      organisationId,
      actorUserId: null,
      actingRole: 'scim',
      after: {
        data: { credentialId: auth.credentialId, status: nextStatus },
        allow: ['credentialId', 'status'],
      },
    });
  }

  return {
    id: outcome.membershipId,
    userName: email,
    active: nextStatus === 'active',
  };
}

/** Set active (reactivate or suspend). Revoked memberships stay revoked. */
export async function setScimUserActive(
  auth: ScimPrincipal,
  pathOrganisationId: string,
  email: string,
  active: boolean,
): Promise<void> {
  assertSameOrg(auth, pathOrganisationId);
  const normalised = email.trim().toLowerCase();
  const userId = await findUserId(normalised);
  if (!userId) throw new AuthorizationError('POLICY_DENIED');

  const [membership] = await db
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .where(
      and(
        eq(memberships.organisationId, auth.organisationId),
        eq(memberships.userId, userId),
      ),
    )
    .limit(1);
  if (!membership) throw new AuthorizationError('POLICY_DENIED');

  if (membership.status === 'revoked') {
    if (active) {
      await recordAudit({
        action: 'membership.reinstated',
        resourceType: 'membership',
        resourceId: membership.id,
        result: 'denied',
        reason: 'scim',
        organisationId: auth.organisationId,
        actorUserId: null,
        actingRole: 'scim',
      });
      throw new AuthorizationError('POLICY_DENIED');
    }
    const revokedSessionIds = await db.transaction(async (tx) =>
      deleteUserSessions(tx, userId),
    );
    await auditSessionRevokes(auth.organisationId, revokedSessionIds);
    return;
  }

  if (!active && membership.status === 'active') {
    const blocked = await db.transaction(async (tx) =>
      soleActiveAdministrator(tx, auth.organisationId, membership.id),
    );
    if (blocked) throw new AuthorizationError('POLICY_DENIED');
  }

  const nextStatus = active ? 'active' : 'suspended';
  if (membership.status === nextStatus && active) return;

  const revokedSessionIds = await db.transaction(async (tx) => {
    await tx
      .update(memberships)
      .set({ status: nextStatus })
      .where(eq(memberships.id, membership.id));
    return active ? [] : deleteUserSessions(tx, userId);
  });
  await auditSessionRevokes(auth.organisationId, revokedSessionIds);
  if (membership.status !== nextStatus) {
    await recordAudit({
      action: active ? 'membership.reinstated' : 'membership.suspended',
      resourceType: 'membership',
      resourceId: membership.id,
      result: 'success',
      reason: 'scim',
      organisationId: auth.organisationId,
      actorUserId: null,
      actingRole: 'scim',
    });
  }
}

/**
 * Directory delete. The membership row is kept and marked revoked so a later
 * provision cannot restore it. Sessions for that user are deleted.
 */
export async function revokeScimUser(
  auth: ScimPrincipal,
  pathOrganisationId: string,
  email: string,
): Promise<void> {
  assertSameOrg(auth, pathOrganisationId);
  const normalised = email.trim().toLowerCase();
  const userId = await findUserId(normalised);
  if (!userId) throw new AuthorizationError('POLICY_DENIED');

  const [membership] = await db
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .where(
      and(
        eq(memberships.organisationId, auth.organisationId),
        eq(memberships.userId, userId),
      ),
    )
    .limit(1);
  if (!membership) throw new AuthorizationError('POLICY_DENIED');

  if (membership.status === 'active') {
    const blocked = await db.transaction(async (tx) =>
      soleActiveAdministrator(tx, auth.organisationId, membership.id),
    );
    if (blocked) throw new AuthorizationError('POLICY_DENIED');
  }

  const revokedSessionIds = await db.transaction(async (tx) => {
    if (membership.status !== 'revoked') {
      await tx
        .update(memberships)
        .set({ status: 'revoked' })
        .where(eq(memberships.id, membership.id));
    }
    return deleteUserSessions(tx, userId);
  });
  await auditSessionRevokes(auth.organisationId, revokedSessionIds);
  if (membership.status !== 'revoked') {
    await recordAudit({
      action: 'membership.revoked',
      resourceType: 'membership',
      resourceId: membership.id,
      result: 'success',
      reason: 'scim',
      organisationId: auth.organisationId,
      actorUserId: null,
      actingRole: 'scim',
    });
  }
}
