import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { scopeFor } from '@/db/tenant-db';
import {
  formInvitations,
  forms,
  membershipInvitations,
  organisations,
  roles,
} from '@/db/schema';
import { decryptField, type EncryptedField } from '@/lib/encryption/envelope';
import { env } from '@/lib/env';
import { sendEmail } from '@/lib/email/mailer';
import {
  renderFormInvitationEmail,
  renderMembershipInvitationEmail,
} from '@/lib/email/invitation-templates';
import { INVITATION_EMAIL_JOB, type InvitationEmailKind } from '@/lib/email/queue';

/**
 * Deliver one queued invitation email.
 *
 * The job identifies the row. Address, copy and the bearer link are read
 * here, sent, then the sealed token is cleared so a retry has nothing left
 * to send. A missing row or a finished invitation is dropped, not retried.
 */

const TERMINAL_FORM_STATUS = new Set(['revoked', 'completed', 'expired']);
const TERMINAL_MEMBERSHIP_STATUS = new Set(['accepted', 'revoked', 'expired']);

function isSeal(value: unknown): value is EncryptedField {
  if (!value || typeof value !== 'object') return false;
  const seal = value as Record<string, unknown>;
  return (
    typeof seal.v === 'number' &&
    typeof seal.iv === 'string' &&
    typeof seal.tag === 'string' &&
    typeof seal.wrappedDek === 'string' &&
    typeof seal.ciphertext === 'string'
  );
}

function openSeal(seal: EncryptedField): string {
  try {
    return decryptField(seal);
  } catch {
    throw new Error('Invitation seal could not be opened');
  }
}

async function clearFormSeal(
  organisationId: string,
  invitationId: string,
  tokenHash: string,
): Promise<void> {
  const scope = scopeFor(organisationId);
  await scope.db
    .update(formInvitations)
    .set({ tokenSeal: null })
    .where(
      scope.where(
        formInvitations.organisationId,
        eq(formInvitations.id, invitationId),
        eq(formInvitations.tokenHash, tokenHash),
      ),
    );
}

async function clearMembershipSeal(
  organisationId: string,
  invitationId: string,
  tokenHash: string,
): Promise<void> {
  const scope = scopeFor(organisationId);
  await scope.db
    .update(membershipInvitations)
    .set({ tokenSeal: null })
    .where(
      scope.where(
        membershipInvitations.organisationId,
        eq(membershipInvitations.id, invitationId),
        eq(membershipInvitations.tokenHash, tokenHash),
      ),
    );
}

function expired(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() < Date.now();
}

async function deliverFormInvitation(
  organisationId: string,
  invitationId: string,
  logger: Logger,
  jobId: string | undefined,
): Promise<void> {
  const scope = scopeFor(organisationId);
  const rows = await scope.db
    .select({
      recipientEmail: formInvitations.recipientEmail,
      recipientName: formInvitations.recipientName,
      status: formInvitations.status,
      expiresAt: formInvitations.expiresAt,
      tokenHash: formInvitations.tokenHash,
      tokenSeal: formInvitations.tokenSeal,
      formTitle: forms.title,
    })
    .from(formInvitations)
    .innerJoin(forms, eq(formInvitations.formId, forms.id))
    .where(
      scope.where(
        formInvitations.organisationId,
        eq(formInvitations.id, invitationId),
        eq(forms.organisationId, organisationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    logger.warn({ jobId, organisationId, invitationId }, 'form invitation not found');
    return;
  }
  const seal = isSeal(row.tokenSeal) ? row.tokenSeal : null;
  if (
    !seal ||
    !row.recipientEmail ||
    TERMINAL_FORM_STATUS.has(row.status) ||
    expired(row.expiresAt)
  ) {
    if (seal) await clearFormSeal(organisationId, invitationId, row.tokenHash);
    logger.info({ jobId, organisationId, invitationId }, 'form invitation email skipped');
    return;
  }

  const token = openSeal(seal);
  const message = renderFormInvitationEmail({
    recipientName: row.recipientName,
    formTitle: row.formTitle,
    completionUrl: `${env.APP_URL}/form/${token}`,
  });
  await sendEmail({
    to: row.recipientEmail,
    subject: message.subject,
    text: message.text,
  });
  await clearFormSeal(organisationId, invitationId, row.tokenHash);
  logger.info({ jobId, organisationId, invitationId }, 'form invitation emailed');
}

async function deliverMembershipInvitation(
  organisationId: string,
  invitationId: string,
  logger: Logger,
  jobId: string | undefined,
): Promise<void> {
  const scope = scopeFor(organisationId);
  const rows = await scope.db
    .select({
      email: membershipInvitations.email,
      status: membershipInvitations.status,
      expiresAt: membershipInvitations.expiresAt,
      tokenHash: membershipInvitations.tokenHash,
      tokenSeal: membershipInvitations.tokenSeal,
      roleName: roles.name,
      organisationName: organisations.legalName,
    })
    .from(membershipInvitations)
    .innerJoin(roles, eq(membershipInvitations.roleId, roles.id))
    .innerJoin(organisations, eq(membershipInvitations.organisationId, organisations.id))
    .where(
      scope.where(
        membershipInvitations.organisationId,
        eq(membershipInvitations.id, invitationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    logger.warn(
      { jobId, organisationId, invitationId },
      'membership invitation not found',
    );
    return;
  }
  const seal = isSeal(row.tokenSeal) ? row.tokenSeal : null;
  if (!seal || TERMINAL_MEMBERSHIP_STATUS.has(row.status) || expired(row.expiresAt)) {
    if (seal) await clearMembershipSeal(organisationId, invitationId, row.tokenHash);
    logger.info(
      { jobId, organisationId, invitationId },
      'membership invitation email skipped',
    );
    return;
  }

  const token = openSeal(seal);
  const message = renderMembershipInvitationEmail({
    organisationName: row.organisationName,
    roleName: row.roleName,
    joinUrl: `${env.APP_URL}/join/${token}`,
  });
  await sendEmail({ to: row.email, subject: message.subject, text: message.text });
  await clearMembershipSeal(organisationId, invitationId, row.tokenHash);
  logger.info({ jobId, organisationId, invitationId }, 'membership invitation emailed');
}

export async function deliverInvitationEmail(input: {
  kind: InvitationEmailKind;
  organisationId: string;
  invitationId: string;
  jobId: string | undefined;
  logger: Logger;
}): Promise<void> {
  if (input.kind === 'form') {
    await deliverFormInvitation(
      input.organisationId,
      input.invitationId,
      input.logger,
      input.jobId,
    );
    return;
  }
  await deliverMembershipInvitation(
    input.organisationId,
    input.invitationId,
    input.logger,
    input.jobId,
  );
}

export function invitationKindFromJobName(jobName: string): InvitationEmailKind | null {
  if (jobName === INVITATION_EMAIL_JOB.form) return 'form';
  if (jobName === INVITATION_EMAIL_JOB.membership) return 'membership';
  return null;
}
