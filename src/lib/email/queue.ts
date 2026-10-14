import { addJob, QueueName } from '@/lib/queues';

/**
 * Tenant email enqueue helper.
 *
 * Tenant-facing emails (form invitations, notification copies) are delivered
 * out-of-band by the worker's Email processor, so a slow or unavailable relay
 * never blocks a request. Verification mail stays on the request. Password
 * reset mail uses the platform `auth-email` queue (no organisation on the
 * request), not this helper.
 *
 * Every payload carries `organisationId` + `correlationId` so the job satisfies
 * the tenant invariant enforced by `addJob`.
 */
export interface QueueTenantEmailInput {
  organisationId: string;
  correlationId: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function queueTenantEmail(input: QueueTenantEmailInput): Promise<void> {
  await addJob(QueueName.Email, 'send', {
    organisationId: input.organisationId,
    correlationId: input.correlationId,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html !== undefined ? { html: input.html } : {}),
  });
}
