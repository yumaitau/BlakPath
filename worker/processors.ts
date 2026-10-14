import { and, eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { QueueName, type TenantJob } from '@/lib/queues';
import { processEvidenceScan } from '@/domains/evidence';
import { processWebhookDelivery, sweepStaleWebhookDeliveries } from '@/domains/webhooks';
import { processExport } from '@/domains/reporting';
import { processRetentionSweep } from '@/domains/retention';
import { env } from '@/lib/env';
import { scopeFor } from '@/db/tenant-db';
import { notifications, users } from '@/db/schema';
import {
  deliverInvitationEmail,
  invitationKindFromJobName,
} from '@/lib/email/invitation-delivery';
import { sendEmail } from '@/lib/email/mailer';
import { openCorrespondence } from '@/lib/encryption/tenant-fields';
import {
  enqueueEncryptionBackfillCursor,
  runBackfillBatch,
} from '@/lib/encryption/backfill';
import { markEmailed, renderNotificationEmail } from '@/domains/notifications';
import { createCheckpoint, verifyChain } from '@/domains/audit';
import { settleAuditChain } from '@/domains/audit/anchor';
import { createS3AuditAnchorStore } from '@/domains/audit/anchor-s3';
import { loadAnchorSigner } from '@/domains/audit/anchor-sign';
import { processOrganisationKeyRewrap } from '@/domains/organisation-keys/rewrap-job';
import { acceptTenantJob } from './tenant-job';

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
 * Every job carries `organisationId` (see `TenantJob`). The worker parses that
 * payload and checks the organisation is active before a processor opens a
 * tenant scope. A job that fails either check is dropped and audited.
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
 * Email processor. Loads the invitation by id and sends the message composed
 * from that row. The job payload is only the id — a bearer link is never
 * read from Redis, and `sendEmail` logs only a redacted recipient.
 */
const emailProcessor: ProcessorFn = async (job, logger) => {
  const kind = invitationKindFromJobName(job.name);
  const invitationId = (job.data as { invitationId?: unknown }).invitationId;
  if (kind && typeof invitationId === 'string' && invitationId.length > 0) {
    await deliverInvitationEmail({
      kind,
      organisationId: job.data.organisationId,
      invitationId,
      jobId: job.id,
      logger,
    });
    return;
  }
  const { organisationId } = job.data;
  const messageId = (job.data as { messageId?: unknown }).messageId;
  if (typeof messageId !== 'string' || messageId.length === 0) {
    // Invitation jobs carry an id. Other tenant mail carries a sealed message id.
    // A body in Redis is dropped rather than logged.
    logger.error({ jobId: job.id }, 'email job payload invalid — dropping');
    return;
  }
  const message = await openCorrespondence(organisationId, messageId);
  if (!message) {
    logger.error({ jobId: job.id, organisationId }, 'email message not found — dropping');
    return;
  }
  await sendEmail({
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
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
 * Audit-verify processor. Re-walks one chain and compares it to the signed
 * heads stored outside the database. A clean chain is a NORMAL result and must
 * not throw (throwing would trigger pointless retries and alarm noise). A
 * store outage still throws so the anchor write can be retried.
 */
const auditVerifyProcessor: ProcessorFn = async (job, logger) => {
  const data = job.data as TenantJob & { platformChain?: boolean };
  const platformChain = data.platformChain === true;
  const organisationId = platformChain ? null : data.organisationId;
  const { correlationId } = data;
  const result = await verifyChain(organisationId);
  const outcome = await settleAuditChain({
    organisationId,
    chain: result,
    store: createS3AuditAnchorStore(),
    signer: loadAnchorSigner(),
  });
  if (outcome.status === 'divergence' || outcome.status === 'anchor_mismatch') {
    // Integrity failure is a serious, actionable signal — log it loudly, but do
    // not throw: the chain will not "heal" on retry.
    logger.error(
      {
        signal: 'audit_integrity_failure',
        alert: true,
        jobId: job.id,
        organisationId,
        correlationId,
        eventId: result.divergence?.eventId ?? null,
        index: result.divergence?.index ?? null,
        reason: result.divergence?.reason ?? outcome.reason,
        eventCount: result.eventCount,
        anchorDay: outcome.day,
      },
      'audit chain verification FAILED',
    );
    return;
  }
  if (outcome.status === 'anchored') {
    await createCheckpoint({ organisationId });
  }
  logger.info(
    {
      jobId: job.id,
      organisationId,
      eventCount: result.eventCount,
      anchor: outcome.status,
    },
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
 * Webhook sweep processor. Re-queues the tenant's `pending` deliveries that have
 * no live job (e.g. the enqueue after insert failed). Tenant-bound; enqueued by
 * a scheduler.
 */
const webhookSweepProcessor: ProcessorFn = async (job) => {
  const { organisationId, correlationId } = job.data;
  await sweepStaleWebhookDeliveries({ organisationId, correlationId });
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
 * Encryption backfill processor. Seals one batch of plaintext tenant fields
 * under the tenant key, then enqueues the next cursor until the run is done.
 */
const encryptionBackfillProcessor: ProcessorFn = async (job, logger) => {
  const { organisationId, correlationId } = job.data;
  const cursor = (job.data as { cursor?: unknown }).cursor;
  const result = await runBackfillBatch({
    organisationId,
    correlationId,
    ...(typeof cursor === 'string' && cursor.length > 0 ? { cursor } : {}),
  });
  logger.info(
    {
      jobId: job.id,
      organisationId,
      table: result.table,
      rowsEncrypted: result.rowsEncrypted,
      done: result.done,
    },
    'encryption backfill batch',
  );
  if (!result.done && result.cursor) {
    await enqueueEncryptionBackfillCursor({
      organisationId,
      correlationId,
      cursor: result.cursor,
    });
  }
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
 * Key health. Describes the tenant CMK and decrypts the stored canary.
 * A state change notifies tenant admins and on-call. This does not read
 * records and does not decide anything about a person.
 */
const keyHealthProcessor: ProcessorFn = async (job) => {
  const { organisationId, correlationId } = job.data;
  const { checkTenantKeyHealth } = await import('@/domains/organisation-keys/health');
  await checkTenantKeyHealth({ organisationId, correlationId });
};

/**
 * Key-replacement processor. Checkpoints live on the re-wrap row, so a kill
 * retries from the cursor instead of starting over. A missing row is dropped.
 */
const keyRewrapProcessor: ProcessorFn = async (job, logger) => {
  const { organisationId } = job.data;
  const rewrapId = (job.data as { rewrapId?: unknown }).rewrapId;
  if (typeof rewrapId !== 'string' || rewrapId.length === 0) {
    logger.error({ jobId: job.id }, 'key-rewrap job missing rewrapId — dropping');
    return;
  }
  const state = await processOrganisationKeyRewrap({ organisationId, rewrapId });
  if (!state) {
    logger.error({ jobId: job.id, organisationId }, 'key-rewrap row missing — dropping');
    return;
  }
  logger.info(
    {
      jobId: job.id,
      organisationId,
      phase: state.phase,
      fieldsDone: state.fieldsDone,
      objectsDone: state.objectsDone,
    },
    'key re-wrap finished',
  );
};

/**
 * Parse the payload and require an active organisation before the processor
 * opens a tenant scope. A rejected job returns normally so BullMQ does not
 * retry it.
 */
function withActiveTenant(processor: ProcessorFn): ProcessorFn {
  return async (job, logger) => {
    const accepted = await acceptTenantJob(job, logger);
    if (!accepted) return;
    await processor(job, logger);
  };
}

/**
 * Map of queue name -> processor. The bootstrap creates one BullMQ Worker per
 * entry, so this registry is the single source of truth for what the worker
 * runs. Register processors through `withActiveTenant` — a raw processor would
 * scope from the queue payload alone.
 */
export const PROCESSORS: Readonly<Record<QueueName, ProcessorFn>> = {
  [QueueName.MalwareScan]: withActiveTenant(malwareScanProcessor),
  [QueueName.Email]: withActiveTenant(emailProcessor),
  [QueueName.Notification]: withActiveTenant(notificationProcessor),
  [QueueName.AuditVerify]: withActiveTenant(auditVerifyProcessor),
  [QueueName.Retention]: withActiveTenant(retentionProcessor),
  [QueueName.Export]: withActiveTenant(exportProcessor),
  [QueueName.Webhook]: withActiveTenant(webhookProcessor),
  [QueueName.WebhookSweep]: withActiveTenant(webhookSweepProcessor),
  [QueueName.Reminder]: withActiveTenant(reminderProcessor),
  [QueueName.EncryptionBackfill]: withActiveTenant(encryptionBackfillProcessor),
  [QueueName.KeyHealth]: withActiveTenant(keyHealthProcessor),
  [QueueName.KeyRewrap]: withActiveTenant(keyRewrapProcessor),
};

/** All registered queue names, for iteration during worker bootstrap. */
export const REGISTERED_QUEUES = Object.keys(PROCESSORS) as QueueName[];
