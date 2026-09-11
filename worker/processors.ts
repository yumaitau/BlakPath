import { and, eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { QueueName, type TenantJob } from '@/lib/queues';
import { processEvidenceScan } from '@/domains/evidence';
import { processWebhookDelivery } from '@/domains/webhooks';
import { processExport } from '@/domains/reporting';
import { processRetentionSweep } from '@/domains/retention';
import { env } from '@/lib/env';
import { scopeFor } from '@/db/tenant-db';
import { notifications, users } from '@/db/schema';
import { sendEmail } from '@/lib/email/mailer';
import { markEmailed, renderNotificationEmail } from '@/domains/notifications';
import { verifyChain } from '@/domains/audit';

/**
 * Processor registry for the BlakPath background worker.
 *
 * Security intent: processors run privileged, out-of-band work. Two rules are
 * non-negotiable and encoded here:
 *   1. The software NEVER determines Aboriginality. No processor may score,
 *      rank, predict, infer, auto-approve or auto-reject. Authority stays with
 *      authorised humans in the organisation.
 *   2. Fail secure. In particular, evidence must NOT be released from
 *      quarantine unless a malware scan has positively passed. If the scanner
 *      (ClamAV) is unavailable, the job MUST fail (and be retried) — it must
 *      never default to "clean".
 *
 * Every job carries `organisationId` (see `TenantJob`); real processors must
 * establish a verified TenantContext before touching any data.
 *
 * Phase-1: these are thin, REAL stubs. They log structured operational context
 * and acknowledge the job so queues drain and the system is observable end to
 * end. Full implementations (ClamAV scan, certificate/export rendering, SMTP
 * delivery, audit verification, retention sweeps, webhooks) land in later
 * phases and will import domain services from `@/lib/*`.
 */

/** A single job processor. Receives the BullMQ job and a scoped logger. */
export type ProcessorFn = (job: Job<TenantJob>, logger: Logger) => Promise<void>;

/**
 * Real malware-scan processor. Validates the tenant-bound job payload, then runs
 * the fail-secure evidence scan lifecycle (quarantine → clean|infected|rejected).
 * A scanner outage causes the underlying service to THROW, so BullMQ retries and
 * the object is never promoted unscanned.
 */
const malwareScanProcessor: ProcessorFn = async (job, logger) => {
  const { organisationId, correlationId } = job.data;
  const evidenceId = (job.data as { evidenceId?: unknown }).evidenceId;
  if (typeof evidenceId !== 'string' || evidenceId.length === 0) {
    // A malformed payload is a bug, not a transient fault — do not retry forever.
    logger.error({ jobId: job.id }, 'malware-scan job missing evidenceId — dropping');
    return;
  }
  logger.info(
    { jobId: job.id, organisationId, evidenceId, attemptsMade: job.attemptsMade },
    'scanning evidence',
  );
  await processEvidenceScan({ organisationId, correlationId, evidenceId });
};

/**
 * Email processor. Delivers a tenant email (invitation, notification copy) via
 * SMTP. The body may contain a bearer link (e.g. a form completion URL), so it
 * is NEVER logged — `sendEmail` logs only a redacted recipient and the subject.
 */
const emailProcessor: ProcessorFn = async (job, logger) => {
  const data = job.data as {
    to?: unknown;
    subject?: unknown;
    text?: unknown;
    html?: unknown;
  };
  if (
    typeof data.to !== 'string' ||
    typeof data.subject !== 'string' ||
    typeof data.text !== 'string'
  ) {
    // Malformed payload is a bug, not a transient fault — do not retry forever.
    logger.error({ jobId: job.id }, 'email job payload invalid — dropping');
    return;
  }
  await sendEmail({
    to: data.to,
    subject: data.subject,
    text: data.text,
    ...(typeof data.html === 'string' ? { html: data.html } : {}),
  });
};

/**
 * Notification processor. Loads the tenant-scoped notification, looks up the
 * recipient's email, and sends a short "you have a new notification" message
 * that links back into the app (never a bearer URL). Marks the row emailed.
 */
const notificationProcessor: ProcessorFn = async (job, logger) => {
  const { organisationId, correlationId } = job.data;
  const notificationId = (job.data as { notificationId?: unknown }).notificationId;
  if (typeof notificationId !== 'string' || notificationId.length === 0) {
    logger.error({ jobId: job.id }, 'notification job missing notificationId — dropping');
    return;
  }

  const scope = scopeFor(organisationId);
  const rows = await scope.db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.organisationId, organisationId),
        eq(notifications.id, notificationId),
      ),
    )
    .limit(1);
  const notification = rows[0];
  if (!notification) {
    logger.warn(
      { jobId: job.id, organisationId },
      'notification not found — skipping delivery',
    );
    return;
  }
  if (notification.emailedAt) {
    // Already delivered; stay idempotent on a retry.
    return;
  }

  const userRows = await scope.db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, notification.userId))
    .limit(1);
  const recipient = userRows[0];
  if (!recipient) {
    logger.warn(
      { jobId: job.id, organisationId },
      'notification recipient not found — skipping delivery',
    );
    return;
  }

  const { subject, text } = renderNotificationEmail({
    name: recipient.name,
    title: notification.title,
    body: notification.body,
    appUrl: env.APP_URL,
  });
  await sendEmail({ to: recipient.email, subject, text });
  await markEmailed(organisationId, notificationId);

  logger.info({ jobId: job.id, organisationId, correlationId }, 'notification emailed');
};

/**
 * Audit-verify processor. Re-walks the tenant's audit chain and reports any
 * divergence as a structured error. A clean chain is a NORMAL result and must
 * not throw (throwing would trigger pointless retries and alarm noise).
 */
const auditVerifyProcessor: ProcessorFn = async (job, logger) => {
  const { organisationId, correlationId } = job.data;
  const result = await verifyChain(organisationId);
  if (!result.ok && result.divergence) {
    // Integrity failure is a serious, actionable signal — log it loudly, but do
    // not throw: the chain will not "heal" on retry.
    logger.error(
      {
        signal: 'audit_integrity_failure',
        alert: true,
        jobId: job.id,
        organisationId,
        correlationId,
        eventId: result.divergence.eventId,
        index: result.divergence.index,
        reason: result.divergence.reason,
        eventCount: result.eventCount,
      },
      'audit chain verification FAILED — divergence detected',
    );
    return;
  }
  logger.info(
    { jobId: job.id, organisationId, eventCount: result.eventCount },
    'audit chain verified clean',
  );
};

/**
 * Webhook delivery processor. Signs and POSTs the payload; a failed delivery
 * throws so BullMQ retries with backoff, until the delivery is marked failed.
 */
const webhookProcessor: ProcessorFn = async (job, logger) => {
  const { organisationId, correlationId } = job.data;
  const deliveryId = (job.data as { deliveryId?: unknown }).deliveryId;
  if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
    logger.error({ jobId: job.id }, 'webhook job missing deliveryId — dropping');
    return;
  }
  await processWebhookDelivery({ organisationId, correlationId, deliveryId });
};

/**
 * Export processor. Assembles the requested report as CSV, stores it, and marks
 * the request ready (or failed). A malformed payload is dropped, not retried.
 */
const exportProcessor: ProcessorFn = async (job, logger) => {
  const { organisationId, correlationId } = job.data;
  const exportRequestId = (job.data as { exportRequestId?: unknown }).exportRequestId;
  if (typeof exportRequestId !== 'string' || exportRequestId.length === 0) {
    logger.error({ jobId: job.id }, 'export job missing exportRequestId — dropping');
    return;
  }
  await processExport({ organisationId, correlationId, exportRequestId });
};

/**
 * Retention processor. Runs the tenant's retention sweep (purge/anonymise past
 * retention, respecting legal holds). Tenant-bound; enqueued by a scheduler.
 */
const retentionProcessor: ProcessorFn = async (job) => {
  const { organisationId, correlationId } = job.data;
  await processRetentionSweep({ organisationId, correlationId });
};

/**
 * Reminder processor. Dispatches due calendar reminders for the tenant as
 * notifications (email copies queued by the notification system). Idempotent
 * per reminder row: dispatched rows are marked sent.
 */
const reminderProcessor: ProcessorFn = async (job) => {
  const { organisationId, correlationId } = job.data;
  const { processReminderSweep } = await import('@/domains/calendar/service');
  await processReminderSweep({ organisationId, correlationId });
};

/**
 * Map of queue name -> processor. The bootstrap creates one BullMQ Worker per
 * entry, so this registry is the single source of truth for what the worker
 * runs. Adding a real processor later is a one-line swap here.
 */
export const PROCESSORS: Readonly<Record<QueueName, ProcessorFn>> = {
  [QueueName.MalwareScan]: malwareScanProcessor,
  [QueueName.Email]: emailProcessor,
  [QueueName.Notification]: notificationProcessor,
  [QueueName.AuditVerify]: auditVerifyProcessor,
  [QueueName.Retention]: retentionProcessor,
  [QueueName.Export]: exportProcessor,
  [QueueName.Webhook]: webhookProcessor,
  [QueueName.Reminder]: reminderProcessor,
};

/** All registered queue names, for iteration during worker bootstrap. */
export const REGISTERED_QUEUES = Object.keys(PROCESSORS) as QueueName[];
