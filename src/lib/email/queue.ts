import { insertSealedCorrespondence } from '@/lib/encryption/tenant-fields';
import { addJob, QueueName } from '@/lib/queues';

/**
 * Tenant email enqueue helper.
 *
 * Tenant-facing emails (form invitations, notification copies) are delivered
 * out-of-band by the worker's Email processor, so a slow or unavailable relay
 * never blocks a request. Auth emails do NOT come through here — they send
 * synchronously via `authMailer` (see `src/lib/email/mailer.ts`).
 *
 * The message body is sealed under the tenant key. Redis receives only
 * `organisationId`, `correlationId` and `messageId`.
 */
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
