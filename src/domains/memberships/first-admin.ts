import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { db } from '@/db/client';
import { membershipInvitations, organisations, roles } from '@/db/schema';
import { recordAudit } from '@/domains/audit/service';
import { firstAdminInvitationMessage } from '@/domains/memberships/first-admin-message';
import { sendEmail } from '@/lib/email/mailer';
import { env } from '@/lib/env';
import { logger } from '@/lib/observability/logger';

const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const ORGANISATION_ADMIN_SLUG = 'organisation-admin';
/** Serialises the empty-database check with the insert. */
const FIRST_ADMIN_LOCK = 814201n;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class FirstAdminInviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirstAdminInviteError';
  }
}

export interface FirstAdminInviteInput {
  email: string;
  legalName: string;
  slug: string;
}

export interface FirstAdminInviteResult {
  organisationId: string;
  invitationId: string;
  email: string;
  slug: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseInput(input: FirstAdminInviteInput): FirstAdminInviteInput {
  const email = z.email().safeParse(input.email.trim().toLowerCase());
  if (!email.success) {
    throw new FirstAdminInviteError('Email address is not valid.');
  }
  const legalName = input.legalName.trim();
  if (legalName.length < 2 || legalName.length > 200) {
    throw new FirstAdminInviteError('Legal name must be between 2 and 200 characters.');
  }
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG.test(slug)) {
    throw new FirstAdminInviteError(
      'Slug must be lowercase letters, numbers, and single hyphens.',
    );
  }
  return { email: email.data, legalName, slug };
}

/**
 * Create the first organisation and email one organisation-administrator
 * invitation. Refuses when any organisation already exists. Does not create a
 * password and does not return the invitation token.
 */
export async function inviteFirstAdministrator(
  raw: FirstAdminInviteInput,
): Promise<FirstAdminInviteResult> {
  const input = parseInput(raw);
  const token = nanoid(36);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);
  const organisationId = uuidv7();
  const invitationId = uuidv7();

  // The invitation and its audit commit together, before the email goes out.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_ADMIN_LOCK})`);
    const existing = await tx
      .select({ id: organisations.id })
      .from(organisations)
      .limit(1);
    if (existing.length > 0) {
      throw new FirstAdminInviteError(
        'An organisation already exists. Invite further administrators from the people screen.',
      );
    }

    const [role] = await tx
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(
        and(
          isNull(roles.organisationId),
          eq(roles.isSystem, true),
          eq(roles.slug, ORGANISATION_ADMIN_SLUG),
        ),
      )
      .limit(1);
    if (!role) {
      throw new FirstAdminInviteError(
        'System roles are missing. Run the seed job first.',
      );
    }

    await tx.insert(organisations).values({
      id: organisationId,
      legalName: input.legalName,
      organisationType: 'council',
      slug: input.slug,
      status: 'onboarding',
      region: env.APP_REGION,
      publicApplicationsOpen: false,
    });
    await tx.insert(membershipInvitations).values({
      id: invitationId,
      organisationId,
      email: input.email,
      roleId: role.id,
      tokenHash: hashToken(token),
      status: 'pending',
      expiresAt,
      lastSentAt: now,
    });
    await recordAudit(
      {
        action: 'membership.invited',
        resourceType: 'membership',
        resourceId: invitationId,
        result: 'success',
        reason: 'membership.first_admin_invitation',
        organisationId,
        actorUserId: null,
        actingRole: 'operator',
        after: { data: { role: role.name }, allow: ['role'] },
      },
      tx,
    );
  });

  const message = firstAdminInvitationMessage({
    organisationName: input.legalName,
    joinUrl: `${env.APP_URL}/join/${token}`,
  });
  try {
    await sendEmail({ to: input.email, subject: message.subject, text: message.text });
  } catch (error) {
    logger.error({ err: error, organisationId }, 'first-admin invitation email failed');
    try {
      await db.delete(organisations).where(eq(organisations.id, organisationId));
    } catch (rollbackError) {
      logger.error(
        { err: rollbackError, organisationId },
        'first-admin invitation rollback failed',
      );
      throw new FirstAdminInviteError(
        'The invitation email could not be sent. Check whether the organisation row remains before retrying.',
      );
    }
    throw new FirstAdminInviteError(
      'The invitation email could not be sent. No organisation was saved.',
    );
  }

  return {
    organisationId,
    invitationId,
    email: input.email,
    slug: input.slug,
  };
}
