import { insertSealedCorrespondence } from '@/lib/encryption/tenant-fields';
import { addJob, QueueName } from '@/lib/queues';

/**
 * Tenant invitation email enqueue.
 *
 * Tenant-facing emails (form invitations, notification copies) are delivered
 * out-of-band by the worker's Email processor, so a slow or unavailable relay
 * never blocks a request. Verification mail stays on the request. Password
 * reset mail uses the platform `auth-email` queue (no organisation on the
 * request), not this helper.
 *
 * Every payload carries `organisationId` + `correlationId` so the job satisfies
 * the tenant invariant enforced by `addJob`. Invitation jobs carry the opaque
 * invitation id only — never a recipient address, subject, body or bearer
 * token. Other tenant mail is sealed under the tenant key and Redis receives
 * only `organisationId`, `correlationId` and `messageId`.
 */
export const INVITATION_EMAIL_JOB = {
  form: 'form-invitation',
  membership: 'membership-invitation',
} as const;

export type InvitationEmailKind = keyof typeof INVITATION_EMAIL_JOB;

export interface QueueInvitationEmailInput {
  organisationId: string;
  correlationId: string;
  invitationId: string;
  kind: InvitationEmailKind;
  /** Stable per send. Omit when the invitation id itself is the send. */
  generation?: string;
}

export function invitationEmailJobId(input: QueueInvitationEmailInput): string {
  const jobName = INVITATION_EMAIL_JOB[input.kind];
  return input.generation
    ? `${jobName}:${input.invitationId}:${input.generation}`
    : `${jobName}:${input.invitationId}`;
}

export async function queueInvitationEmail(
  input: QueueInvitationEmailInput,
): Promise<void> {
  if (!input.invitationId) {
    throw new Error('Invitation email job is missing invitationId');
  }
  await addJob(
    QueueName.Email,
    INVITATION_EMAIL_JOB[input.kind],
    {
      organisationId: input.organisationId,
      correlationId: input.correlationId,
      invitationId: input.invitationId,
    },
    { jobId: invitationEmailJobId(input) },
  );
}

export interface QueueTenantEmailInput {
  organisationId: string;
  correlationId: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Stable BullMQ id when the caller needs idempotent delivery. */
  jobId?: string;
}

export async function queueTenantEmail(input: QueueTenantEmailInput): Promise<void> {
  const messageId = await insertSealedCorrespondence({
    organisationId: input.organisationId,
    recipient: input.to,
    subject: input.subject,
    textBody: input.text,
    htmlBody: input.html ?? null,
  });
  await addJob(
    QueueName.Email,
    'send',
    {
      organisationId: input.organisationId,
      correlationId: input.correlationId,
      messageId,
    },
    input.jobId ? { jobId: input.jobId } : {},
  );
}
