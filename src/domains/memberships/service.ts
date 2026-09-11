import { createHash } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import { hash as argon2Hash } from '@node-rs/argon2';
import { nanoid } from 'nanoid';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { db } from '@/db/client';
import {
  accounts,
  membershipInvitations,
  memberships,
  membershipRoles,
  organisations,
  roles,
  sessions,
  teamMemberships,
  teams,
  users,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { queueTenantEmail } from '@/lib/email/queue';
import { env } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError, isAuthorizationError } from '@/lib/permissions/errors';
import { requireTenantContext } from '@/lib/tenancy/context';

const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const ORGANISATION_ADMIN_SLUG = 'organisation-admin';

const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Invite-bound account creation — the ONLY self-service account path.
 *
 * Open registration is disabled (`disableSignUp`), so a person without an
 * account creates one from inside a pending organisation invitation. The
 * invitation token proves control of the invited email address, which is why
 * the account is marked verified at creation. The password never touches the
 * database in plaintext (Argon2id, OWASP-aligned parameters).
 */
const createInvitedAccountSchema = z.object({
  token: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(12).max(256),
});

export async function createInvitedAccount(raw: unknown): Promise<{ userId: string }> {
  const input = createInvitedAccountSchema.parse(raw);
  const invitation = await resolvePendingInvitation(input.token);

  const email = invitation.email.toLowerCase();
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    await recordAudit({
      action: 'auth.signed_up',
      resourceType: 'user',
      resourceId: existing.id,
      result: 'denied',
      reason: 'account already exists — sign in instead',
      organisationId: invitation.organisationId,
    });
    throw new AuthorizationError('POLICY_DENIED');
  }

  const userId = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      name: input.name,
      email,
      emailVerified: true,
    });
    await tx.insert(accounts).values({
      id: uuidv7(),
      userId,
      providerId: 'credential',
      accountId: userId,
      password: await argon2Hash(input.password, ARGON2_OPTIONS),
    });
  });
  await recordAudit({
    action: 'auth.signed_up',
    resourceType: 'user',
    resourceId: userId,
    result: 'success',
    reason: 'invite-bound signup',
    organisationId: invitation.organisationId,
  });
  return { userId };
}

export interface ManagedMember {
  id: string;
  name: string;
  email: string;
  status: string;
  roleIds: string[];
  roles: string[];
}

export interface AssignableRole {
  id: string;
  name: string;
  description: string | null;
}

export interface ManagedMembershipInvitation {
  id: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  roleId: string;
  roleName: string;
  expiresAt: Date;
  lastSentAt: Date;
}

export interface MembershipInvitationPreview {
  organisationName: string;
  roleName: string;
  emailHint: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function assertManage(): ReturnType<typeof requireTenantContext> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'membership:manage');
  return ctx;
}

async function recordDenied(
  action:
    | 'membership.invited'
    | 'membership.invitation_revoked'
    | 'membership.role_assigned'
    | 'membership.suspended'
    | 'membership.reinstated'
    | 'membership.revoked',
  resourceId: string | null,
  error: unknown,
): Promise<void> {
  if (!isAuthorizationError(error)) return;
  await recordAudit({
    action,
    resourceType: 'membership',
    resourceId,
    result: 'denied',
    reason: error.code,
  });
}

function invitationStatus(
  status: ManagedMembershipInvitation['status'],
  expiresAt: Date,
): ManagedMembershipInvitation['status'] {
  return status === 'pending' && expiresAt.getTime() < Date.now() ? 'expired' : status;
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'•'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

async function activeAdministratorCount(organisationId: string): Promise<number> {
  const rows = await db
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
  return new Set(rows.map((row) => row.membershipId)).size;
}

async function loadAssignableRole(
  roleId: string,
): Promise<AssignableRole & { slug: string }> {
  const [role] = await db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      slug: roles.slug,
    })
    .from(roles)
    .where(
      and(
        eq(roles.id, roleId),
        eq(roles.isSystem, true),
        ne(roles.slug, 'platform-operator'),
      ),
    )
    .limit(1);
  if (!role) throw new AuthorizationError('POLICY_DENIED');
  return role;
}

async function queueMembershipInvitationEmail(input: {
  invitationId: string;
  organisationId: string;
  organisationName: string;
  correlationId: string;
  email: string;
  roleName: string;
  token: string;
}): Promise<void> {
  const joinUrl = `${env.APP_URL}/join/${input.token}`;
  try {
    await queueTenantEmail({
      organisationId: input.organisationId,
      correlationId: input.correlationId,
      to: input.email,
      subject: `Invitation to join ${input.organisationName} in BlakPath`,
      text: [
        `You have been invited to join ${input.organisationName} as ${input.roleName}.`,
        '',
        'Sign in with this email address and review the invitation:',
        joinUrl,
        '',
        'The link expires in 14 days. If you were not expecting this invitation, you can ignore it.',
        '',
        'BlakPath',
      ].join('\n'),
    });
  } catch (error) {
    logger.error(
      {
        organisationId: input.organisationId,
        invitationId: input.invitationId,
        error,
      },
      'failed to enqueue membership invitation email',
    );
  }
}

export async function listManagedMembers(): Promise<ManagedMember[]> {
  assertManage();
  const scope = currentScope();
  const rows = await db
    .select({
      id: memberships.id,
      name: users.name,
      email: users.email,
      status: memberships.status,
      roleId: roles.id,
      roleName: roles.name,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .leftJoin(roles, eq(membershipRoles.roleId, roles.id))
    .where(eq(memberships.organisationId, scope.organisationId));
  const result = new Map<string, ManagedMember>();
  for (const row of rows) {
    const member = result.get(row.id) ?? {
      id: row.id,
      name: row.name,
      email: row.email,
      status: row.status,
      roleIds: [],
      roles: [],
    };
    if (row.roleId && row.roleName) {
      member.roleIds.push(row.roleId);
      member.roles.push(row.roleName);
    }
    result.set(row.id, member);
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAssignableRoles(): Promise<AssignableRole[]> {
  assertManage();
  return db
    .select({ id: roles.id, name: roles.name, description: roles.description })
    .from(roles)
    .where(and(eq(roles.isSystem, true), ne(roles.slug, 'platform-operator')))
    .orderBy(roles.name);
}

export async function listMembershipInvitations(): Promise<
  ManagedMembershipInvitation[]
> {
  assertManage();
  const scope = currentScope();
  const rows = await db
    .select({
      id: membershipInvitations.id,
      email: membershipInvitations.email,
      status: membershipInvitations.status,
      roleId: membershipInvitations.roleId,
      roleName: roles.name,
      expiresAt: membershipInvitations.expiresAt,
      lastSentAt: membershipInvitations.lastSentAt,
    })
    .from(membershipInvitations)
    .innerJoin(roles, eq(membershipInvitations.roleId, roles.id))
    .where(eq(membershipInvitations.organisationId, scope.organisationId))
    .orderBy(desc(membershipInvitations.createdAt));
  return rows.map((row) => ({
    ...row,
    status: invitationStatus(row.status, row.expiresAt),
  }));
}

/** Add an existing signed-up person directly to this organisation. */
export async function addMember(input: {
  email: string;
  roleId: string;
}): Promise<ManagedMember> {
  const ctx = requireTenantContext();
  try {
    requirePermission(subjectFromContext(ctx), 'membership:manage');
    const scope = currentScope();
    const email = input.email.trim().toLowerCase();
    const [person] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!person) throw new AuthorizationError('POLICY_DENIED');
    const role = await loadAssignableRole(input.roleId);

    const existingRows = await db
      .select({
        id: memberships.id,
        status: memberships.status,
        roleSlug: roles.slug,
      })
      .from(memberships)
      .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .leftJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(
        and(
          eq(memberships.organisationId, scope.organisationId),
          eq(memberships.userId, person.id),
        ),
      );
    const existing = existingRows[0];
    if (existing?.id && person.id === ctx.userId) {
      throw new AuthorizationError('POLICY_DENIED');
    }
    const replacesActiveAdministrator =
      existing?.status === 'active' &&
      existingRows.some((row) => row.roleSlug === ORGANISATION_ADMIN_SLUG) &&
      role.slug !== ORGANISATION_ADMIN_SLUG;
    if (
      replacesActiveAdministrator &&
      (await activeAdministratorCount(scope.organisationId)) <= 1
    ) {
      throw new AuthorizationError('POLICY_DENIED');
    }
    const membershipId = existing?.id ?? uuidv7();
    await db.transaction(async (tx) => {
      if (!existing) {
        await tx.insert(memberships).values({
          id: membershipId,
          organisationId: scope.organisationId,
          userId: person.id,
          invitedByUserId: ctx.userId,
          status: 'active',
        });
      } else {
        await tx
          .update(memberships)
          .set({ status: 'active' })
          .where(eq(memberships.id, membershipId));
        await tx
          .delete(membershipRoles)
          .where(eq(membershipRoles.membershipId, membershipId));
      }
      await tx
        .insert(membershipRoles)
        .values({ id: uuidv7(), membershipId, roleId: role.id });
    });
    await recordAudit({
      action: existing ? 'membership.role_assigned' : 'membership.invited',
      resourceType: 'membership',
      resourceId: membershipId,
      result: 'success',
      after: { data: { role: role.name }, allow: ['role'] },
    });
    return {
      id: membershipId,
      name: person.name,
      email: person.email,
      status: 'active',
      roleIds: [role.id],
      roles: [role.name],
    };
  } catch (error) {
    await recordDenied('membership.role_assigned', null, error);
    throw error;
  }
}

export async function createMembershipInvitation(input: {
  email: string;
  roleId: string;
  teamId?: string;
}): Promise<{
  invitation: ManagedMembershipInvitation;
  token: string;
  path: string;
}> {
  const ctx = requireTenantContext();
  try {
    requirePermission(subjectFromContext(ctx), 'membership:manage');
    const scope = currentScope();
    const email = input.email.trim().toLowerCase();
    const role = await loadAssignableRole(input.roleId);

    const [existingMember] = await db
      .select({ status: memberships.status })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(
        and(eq(memberships.organisationId, scope.organisationId), eq(users.email, email)),
      )
      .limit(1);
    if (existingMember && existingMember.status !== 'revoked') {
      throw new AuthorizationError('POLICY_DENIED');
    }

    const token = nanoid(36);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);
    const invitationId = uuidv7();
    const invitedByUserId = ctx.userId;
    const [organisation] = await db
      .select({ name: organisations.legalName })
      .from(organisations)
      .where(eq(organisations.id, scope.organisationId))
      .limit(1);
    if (!organisation) throw new AuthorizationError('POLICY_DENIED');

    // Optional team assignment: the team must belong to this organisation,
    // otherwise the invitation carries no team.
    let teamId: string | null = null;
    if (input.teamId) {
      const [team] = await db
        .select({ id: teams.id })
        .from(teams)
        .where(
          and(eq(teams.id, input.teamId), eq(teams.organisationId, scope.organisationId)),
        )
        .limit(1);
      if (!team) throw new AuthorizationError('POLICY_DENIED');
      teamId = team.id;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(membershipInvitations)
        .set({ status: 'revoked', revokedAt: now })
        .where(
          and(
            eq(membershipInvitations.organisationId, scope.organisationId),
            eq(membershipInvitations.email, email),
            eq(membershipInvitations.status, 'pending'),
          ),
        );
      await tx.insert(membershipInvitations).values({
        id: invitationId,
        organisationId: scope.organisationId,
        email,
        roleId: role.id,
        teamId,
        tokenHash: hashToken(token),
        invitedByUserId,
        status: 'pending',
        expiresAt,
        lastSentAt: now,
      });
    });

    await recordAudit({
      action: 'membership.invited',
      resourceType: 'membership',
      resourceId: invitationId,
      result: 'success',
      after: { data: { role: role.name }, allow: ['role'] },
    });
    await queueMembershipInvitationEmail({
      invitationId,
      organisationId: scope.organisationId,
      organisationName: organisation.name,
      correlationId: ctx.correlationId,
      email,
      roleName: role.name,
      token,
    });
    return {
      invitation: {
        id: invitationId,
        email,
        status: 'pending',
        roleId: role.id,
        roleName: role.name,
        expiresAt,
        lastSentAt: now,
      },
      token,
      path: `/join/${token}`,
    };
  } catch (error) {
    await recordDenied('membership.invited', null, error);
    throw error;
  }
}

export async function resendMembershipInvitation(id: string): Promise<{
  invitation: ManagedMembershipInvitation;
  token: string;
  path: string;
}> {
  const ctx = requireTenantContext();
  try {
    requirePermission(subjectFromContext(ctx), 'membership:manage');
    const scope = currentScope();
    const [current] = await db
      .select({
        id: membershipInvitations.id,
        email: membershipInvitations.email,
        status: membershipInvitations.status,
        roleId: membershipInvitations.roleId,
        roleName: roles.name,
        organisationName: organisations.legalName,
      })
      .from(membershipInvitations)
      .innerJoin(roles, eq(membershipInvitations.roleId, roles.id))
      .innerJoin(
        organisations,
        eq(membershipInvitations.organisationId, organisations.id),
      )
      .where(
        and(
          eq(membershipInvitations.id, id),
          eq(membershipInvitations.organisationId, scope.organisationId),
        ),
      )
      .limit(1);
    if (!current || current.status !== 'pending') {
      throw new AuthorizationError('POLICY_DENIED');
    }

    const token = nanoid(36);
    const lastSentAt = new Date();
    const expiresAt = new Date(lastSentAt.getTime() + INVITATION_LIFETIME_MS);
    await db
      .update(membershipInvitations)
      .set({ tokenHash: hashToken(token), expiresAt, lastSentAt })
      .where(
        and(
          eq(membershipInvitations.id, id),
          eq(membershipInvitations.organisationId, scope.organisationId),
          eq(membershipInvitations.status, 'pending'),
        ),
      );
    await recordAudit({
      action: 'membership.invited',
      resourceType: 'membership',
      resourceId: id,
      result: 'success',
      after: { data: { resent: true }, allow: ['resent'] },
    });
    await queueMembershipInvitationEmail({
      invitationId: id,
      organisationId: scope.organisationId,
      organisationName: current.organisationName,
      correlationId: ctx.correlationId,
      email: current.email,
      roleName: current.roleName,
      token,
    });
    return {
      invitation: {
        id,
        email: current.email,
        status: 'pending',
        roleId: current.roleId,
        roleName: current.roleName,
        expiresAt,
        lastSentAt,
      },
      token,
      path: `/join/${token}`,
    };
  } catch (error) {
    await recordDenied('membership.invited', id, error);
    throw error;
  }
}

export async function revokeMembershipInvitation(id: string): Promise<void> {
  const ctx = requireTenantContext();
  try {
    requirePermission(subjectFromContext(ctx), 'membership:manage');
    const scope = currentScope();
    const updated = await db
      .update(membershipInvitations)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(
        and(
          eq(membershipInvitations.id, id),
          eq(membershipInvitations.organisationId, scope.organisationId),
          eq(membershipInvitations.status, 'pending'),
        ),
      )
      .returning({ id: membershipInvitations.id });
    if (!updated[0]) throw new AuthorizationError('POLICY_DENIED');
    await recordAudit({
      action: 'membership.invitation_revoked',
      resourceType: 'membership',
      resourceId: id,
      result: 'success',
    });
  } catch (error) {
    await recordDenied('membership.invitation_revoked', id, error);
    throw error;
  }
}

async function resolvePendingInvitation(token: string) {
  const [invitation] = await db
    .select({
      id: membershipInvitations.id,
      organisationId: membershipInvitations.organisationId,
      organisationName: organisations.legalName,
      email: membershipInvitations.email,
      roleId: membershipInvitations.roleId,
      roleName: roles.name,
      teamId: membershipInvitations.teamId,
      status: membershipInvitations.status,
      expiresAt: membershipInvitations.expiresAt,
    })
    .from(membershipInvitations)
    .innerJoin(organisations, eq(membershipInvitations.organisationId, organisations.id))
    .innerJoin(roles, eq(membershipInvitations.roleId, roles.id))
    .where(eq(membershipInvitations.tokenHash, hashToken(token)))
    .limit(1);
  if (!invitation || invitation.status !== 'pending') {
    throw new AuthorizationError('POLICY_DENIED');
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    await db
      .update(membershipInvitations)
      .set({ status: 'expired' })
      .where(eq(membershipInvitations.id, invitation.id));
    throw new AuthorizationError('POLICY_DENIED');
  }
  return invitation;
}

export async function getMembershipInvitationPreview(
  token: string,
): Promise<MembershipInvitationPreview> {
  const invitation = await resolvePendingInvitation(token);
  return {
    organisationName: invitation.organisationName,
    roleName: invitation.roleName,
    emailHint: maskEmail(invitation.email),
  };
}

export async function acceptMembershipInvitation(input: {
  token: string;
  userId: string;
  userEmail: string;
  emailVerified: boolean;
  sessionId: string;
}): Promise<{ organisationId: string; organisationName: string }> {
  const invitation = await resolvePendingInvitation(input.token);
  if (
    !input.emailVerified ||
    input.userEmail.trim().toLowerCase() !== invitation.email.toLowerCase()
  ) {
    await recordAudit({
      action: 'membership.invitation_accepted',
      resourceType: 'membership',
      resourceId: invitation.id,
      result: 'denied',
      reason: 'EMAIL_MISMATCH',
      organisationId: invitation.organisationId,
      actorUserId: input.userId,
      sessionId: input.sessionId,
    });
    throw new AuthorizationError('POLICY_DENIED');
  }

  let membershipId = '';
  try {
    await db.transaction(async (tx) => {
      const accepted = await tx
        .update(membershipInvitations)
        .set({
          status: 'accepted',
          acceptedByUserId: input.userId,
          acceptedAt: new Date(),
        })
        .where(
          and(
            eq(membershipInvitations.id, invitation.id),
            eq(membershipInvitations.status, 'pending'),
          ),
        )
        .returning({ id: membershipInvitations.id });
      if (!accepted[0]) throw new AuthorizationError('POLICY_DENIED');

      const [existing] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.organisationId, invitation.organisationId),
            eq(memberships.userId, input.userId),
          ),
        )
        .limit(1);
      membershipId = existing?.id ?? uuidv7();
      if (existing) {
        await tx
          .update(memberships)
          .set({ status: 'active' })
          .where(eq(memberships.id, existing.id));
        await tx
          .delete(membershipRoles)
          .where(eq(membershipRoles.membershipId, existing.id));
      } else {
        await tx.insert(memberships).values({
          id: membershipId,
          organisationId: invitation.organisationId,
          userId: input.userId,
          status: 'active',
        });
      }
      await tx.insert(membershipRoles).values({
        id: uuidv7(),
        membershipId,
        roleId: invitation.roleId,
      });
      if (invitation.teamId) {
        // Team join on acceptance. teamMemberships has no cross-team unique
        // violation risk beyond (team,user); ignore duplicates from re-accepts.
        await tx
          .insert(teamMemberships)
          .values({
            organisationId: invitation.organisationId,
            teamId: invitation.teamId,
            userId: input.userId,
            role: 'member',
          })
          .onConflictDoNothing({
            target: [teamMemberships.teamId, teamMemberships.userId],
          });
      }
      await tx
        .update(sessions)
        .set({ activeOrganisationId: invitation.organisationId })
        .where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, input.userId)));
    });
  } catch (error) {
    if (isAuthorizationError(error)) {
      await recordAudit({
        action: 'membership.invitation_accepted',
        resourceType: 'membership',
        resourceId: invitation.id,
        result: 'denied',
        reason: error.code,
        organisationId: invitation.organisationId,
        actorUserId: input.userId,
        sessionId: input.sessionId,
      });
    }
    throw error;
  }

  await recordAudit({
    action: 'membership.invitation_accepted',
    resourceType: 'membership',
    resourceId: membershipId,
    result: 'success',
    organisationId: invitation.organisationId,
    actorUserId: input.userId,
    sessionId: input.sessionId,
    after: { data: { role: invitation.roleName }, allow: ['role'] },
  });
  if (invitation.teamId) {
    await recordAudit({
      action: 'team.member_added',
      resourceType: 'team',
      resourceId: invitation.teamId,
      result: 'success',
      organisationId: invitation.organisationId,
      actorUserId: input.userId,
      sessionId: input.sessionId,
    });
  }
  return {
    organisationId: invitation.organisationId,
    organisationName: invitation.organisationName,
  };
}

export async function changeMemberRole(id: string, roleId: string): Promise<void> {
  const ctx = requireTenantContext();
  try {
    requirePermission(subjectFromContext(ctx), 'membership:manage');
    const scope = currentScope();
    const role = await loadAssignableRole(roleId);
    const rows = await db
      .select({
        userId: memberships.userId,
        status: memberships.status,
        roleId: roles.id,
        roleName: roles.name,
        roleSlug: roles.slug,
      })
      .from(memberships)
      .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .leftJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(
        and(eq(memberships.id, id), eq(memberships.organisationId, scope.organisationId)),
      );
    const member = rows[0];
    if (!member || member.userId === ctx.userId || member.status === 'revoked') {
      throw new AuthorizationError('POLICY_DENIED');
    }
    const wasAdministrator = rows.some((row) => row.roleSlug === ORGANISATION_ADMIN_SLUG);
    if (
      member.status === 'active' &&
      wasAdministrator &&
      role.slug !== ORGANISATION_ADMIN_SLUG &&
      (await activeAdministratorCount(scope.organisationId)) <= 1
    ) {
      throw new AuthorizationError('POLICY_DENIED');
    }
    const beforeRoles = rows
      .map((row) => row.roleName)
      .filter((name): name is string => Boolean(name));
    await db.transaction(async (tx) => {
      await tx.delete(membershipRoles).where(eq(membershipRoles.membershipId, id));
      await tx
        .insert(membershipRoles)
        .values({ id: uuidv7(), membershipId: id, roleId: role.id });
    });
    await recordAudit({
      action: 'membership.role_assigned',
      resourceType: 'membership',
      resourceId: id,
      result: 'success',
      before: { data: { roles: beforeRoles }, allow: ['roles'] },
      after: { data: { role: role.name }, allow: ['role'] },
    });
  } catch (error) {
    await recordDenied('membership.role_assigned', id, error);
    throw error;
  }
}

export async function changeMemberStatus(
  id: string,
  status: 'suspended' | 'revoked' | 'active',
): Promise<void> {
  const ctx = requireTenantContext();
  const action =
    status === 'active'
      ? ('membership.reinstated' as const)
      : status === 'suspended'
        ? ('membership.suspended' as const)
        : ('membership.revoked' as const);
  try {
    requirePermission(subjectFromContext(ctx), 'membership:manage');
    const scope = currentScope();
    const rows = await db
      .select({
        userId: memberships.userId,
        status: memberships.status,
        slug: roles.slug,
      })
      .from(memberships)
      .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .leftJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(
        and(eq(memberships.id, id), eq(memberships.organisationId, scope.organisationId)),
      );
    const member = rows[0];
    if (!member || member.userId === ctx.userId) {
      throw new AuthorizationError('POLICY_DENIED');
    }
    const removesActiveAdministrator =
      member.status === 'active' &&
      status !== 'active' &&
      rows.some((row) => row.slug === ORGANISATION_ADMIN_SLUG);
    if (
      removesActiveAdministrator &&
      (await activeAdministratorCount(scope.organisationId)) <= 1
    ) {
      throw new AuthorizationError('POLICY_DENIED');
    }
    await db
      .update(memberships)
      .set({ status })
      .where(
        and(eq(memberships.id, id), eq(memberships.organisationId, scope.organisationId)),
      );
    await recordAudit({
      action,
      resourceType: 'membership',
      resourceId: id,
      result: 'success',
      after: { data: { status }, allow: ['status'] },
    });
  } catch (error) {
    await recordDenied(action, id, error);
    throw error;
  }
}
