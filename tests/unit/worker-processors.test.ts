import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as InvitationDelivery from '@/lib/email/invitation-delivery';
import type * as AuditVerify from '../../worker/audit-verify';
import { QueueName, type TenantJob } from '@/lib/queues';
import { script } from './helpers/scripted-db';

/**
 * Processors move work. They do not score, rank, or decide Aboriginality.
 * A malformed payload is dropped. A downstream failure is rethrown so BullMQ
 * retries, except audit divergence, which will not heal on retry.
 */
const deps = vi.hoisted(() => ({
  acceptTenantJob: vi.fn(async (): Promise<boolean> => true),
  processEvidenceScan: vi.fn(async () => undefined),
  processWebhookDelivery: vi.fn(async () => undefined),
  processExport: vi.fn(async () => undefined),
  processExportMaintenance: vi.fn(async () => ({
    expired: 0,
    requeued: 0,
    abandoned: 0,
  })),
  processRetentionSweep: vi.fn(async () => undefined),
  processReminderSweep: vi.fn(async () => undefined),
  processOrganisationKeyRewrap: vi.fn(async (): Promise<unknown> => null),
  sendEmail: vi.fn(async () => undefined),
  deliverInvitationEmail: vi.fn(async () => undefined),
  openCorrespondence: vi.fn(
    async (): Promise<{
      to: string;
      subject: string;
      text: string;
      html: string | null;
    } | null> => null,
  ),
  markEmailed: vi.fn(async () => undefined),
  renderNotificationEmail: vi.fn(() => ({
    subject: 'Notice',
    text: 'You have a notification',
  })),
  // Chain walking, anchoring and checkpointing are covered by the
  // audit-verify tests. Here only the routing into it is asserted.
  processAuditVerifyJob: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock('../../worker/tenant-job', () => ({ acceptTenantJob: deps.acceptTenantJob }));
vi.mock('@/domains/evidence', () => ({ processEvidenceScan: deps.processEvidenceScan }));
vi.mock('@/domains/webhooks', () => ({
  processWebhookDelivery: deps.processWebhookDelivery,
}));
vi.mock('@/domains/reporting', () => ({
  processExport: deps.processExport,
  processExportMaintenance: deps.processExportMaintenance,
}));
vi.mock('@/domains/retention', () => ({
  processRetentionSweep: deps.processRetentionSweep,
}));
vi.mock('@/domains/calendar/service', () => ({
  processReminderSweep: deps.processReminderSweep,
}));
vi.mock('@/domains/organisation-keys/rewrap-job', () => ({
  processOrganisationKeyRewrap: deps.processOrganisationKeyRewrap,
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: deps.sendEmail }));
vi.mock('@/lib/email/invitation-delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof InvitationDelivery>()),
  deliverInvitationEmail: deps.deliverInvitationEmail,
}));
vi.mock('@/lib/encryption/tenant-fields', () => ({
  openCorrespondence: deps.openCorrespondence,
}));
vi.mock('@/domains/notifications', () => ({
  markEmailed: deps.markEmailed,
  renderNotificationEmail: deps.renderNotificationEmail,
}));
// The platform-job predicate stays real: it decides which jobs skip the gate.
vi.mock('../../worker/audit-verify', async (importOriginal) => ({
  ...(await importOriginal<typeof AuditVerify>()),
  processAuditVerifyJob: deps.processAuditVerifyJob,
}));
vi.mock('@/db/tenant-db', async () => {
  const { scriptedTenantModule } = await import('./helpers/scripted-db');
  return scriptedTenantModule('org-1');
});

const { PROCESSORS, REGISTERED_QUEUES } = await import('../../worker/processors');

function job(
  data: Record<string, unknown>,
  name = 'job',
  queueName: string = 'test-queue',
): Job<TenantJob> {
  return {
    id: 'job-1',
    name,
    queueName,
    attemptsMade: 1,
    data: { organisationId: 'org-1', correlationId: 'corr-1', ...data },
  } as Job<TenantJob>;
}

function logger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function asLogger(log: ReturnType<typeof logger>): Logger {
  return log as unknown as Logger;
}

beforeEach(() => {
  script.reset();
  vi.clearAllMocks();
  deps.acceptTenantJob.mockResolvedValue(true);
  deps.openCorrespondence.mockResolvedValue(null);
  deps.renderNotificationEmail.mockReturnValue({
    subject: 'Notice',
    text: 'You have a notification',
  });
});

describe('worker processors', () => {
  it('registers every queue', () => {
    expect(REGISTERED_QUEUES.slice().sort()).toEqual(
      (Object.values(QueueName) as string[]).slice().sort(),
    );
    for (const name of Object.values(QueueName)) {
      expect(PROCESSORS[name]).toEqual(expect.any(Function));
    }
  });

  it('runs no processor for a job the tenant gate rejects', async () => {
    deps.acceptTenantJob.mockResolvedValue(false);
    for (const name of Object.values(QueueName)) {
      await PROCESSORS[name](
        job(
          { evidenceId: 'ev-1', deliveryId: 'del-1', notificationId: 'note-1' },
          'job',
          name,
        ),
        asLogger(logger()),
      );
    }
    expect(deps.acceptTenantJob).toHaveBeenCalledTimes(Object.values(QueueName).length);
    expect(deps.processEvidenceScan).not.toHaveBeenCalled();
    expect(deps.processWebhookDelivery).not.toHaveBeenCalled();
    expect(deps.processRetentionSweep).not.toHaveBeenCalled();
    expect(deps.processAuditVerifyJob).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(script.ops).toEqual([]);
  });

  it('scans evidence and retries when the scanner fails', async () => {
    const log = logger();
    await PROCESSORS[QueueName.MalwareScan](job({}), asLogger(log));
    expect(deps.processEvidenceScan).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();

    await PROCESSORS[QueueName.MalwareScan](job({ evidenceId: 'ev-1' }), asLogger(log));
    expect(deps.processEvidenceScan).toHaveBeenCalledWith({
      organisationId: 'org-1',
      correlationId: 'corr-1',
      evidenceId: 'ev-1',
    });

    deps.processEvidenceScan.mockRejectedValueOnce(new Error('scanner down'));
    await expect(
      PROCESSORS[QueueName.MalwareScan](job({ evidenceId: 'ev-1' }), asLogger(log)),
    ).rejects.toThrow(/scanner down/);
  });

  it('drops a mail body carried in Redis and never logs it', async () => {
    const log = logger();
    const secret = 'https://council.example/form/secret-token';
    await PROCESSORS[QueueName.Email](
      job({ to: 'ada@council.example', subject: 'Form', text: secret }),
      asLogger(log),
    );
    expect(deps.openCorrespondence).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
    const logged = JSON.stringify([...log.error.mock.calls, ...log.info.mock.calls]);
    expect(logged).not.toContain(secret);
  });

  it('sends sealed tenant mail by id without logging the body', async () => {
    const log = logger();
    const secret = 'https://council.example/form/secret-token';

    await PROCESSORS[QueueName.Email](job({ messageId: 'msg-missing' }), asLogger(log));
    expect(deps.openCorrespondence).toHaveBeenCalledWith('org-1', 'msg-missing');
    expect(deps.sendEmail).not.toHaveBeenCalled();

    deps.openCorrespondence.mockResolvedValueOnce({
      to: 'ada@council.example',
      subject: 'Form',
      text: secret,
      html: '<p>hi</p>',
    });
    await PROCESSORS[QueueName.Email](job({ messageId: 'msg-1' }), asLogger(log));
    expect(deps.sendEmail).toHaveBeenCalledWith({
      to: 'ada@council.example',
      subject: 'Form',
      text: secret,
      html: '<p>hi</p>',
    });

    deps.openCorrespondence.mockResolvedValueOnce({
      to: 'bea@council.example',
      subject: 'Plain',
      text: 'plain body',
      html: null,
    });
    await PROCESSORS[QueueName.Email](job({ messageId: 'msg-2' }), asLogger(log));
    expect(deps.sendEmail).toHaveBeenLastCalledWith({
      to: 'bea@council.example',
      subject: 'Plain',
      text: 'plain body',
    });

    const logged = JSON.stringify([
      ...log.error.mock.calls,
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
    ]);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('ada@council.example');
  });

  it('hands an invitation job to invitation delivery by id', async () => {
    const log = logger();
    await PROCESSORS[QueueName.Email](
      job({ invitationId: 'inv-1' }, 'form-invitation'),
      asLogger(log),
    );
    expect(deps.deliverInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'form',
        organisationId: 'org-1',
        invitationId: 'inv-1',
      }),
    );
    expect(deps.openCorrespondence).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('emails a notification once and skips missing or already-sent rows', async () => {
    const log = logger();
    await PROCESSORS[QueueName.Notification](job({}), asLogger(log));
    expect(script.ops).toEqual([]);

    script.results.push([]);
    await PROCESSORS[QueueName.Notification](
      job({ notificationId: 'note-1' }),
      asLogger(log),
    );
    expect(log.warn).toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();

    script.results.push([
      {
        id: 'note-1',
        userId: 'user-1',
        title: 'Update',
        body: 'Body',
        emailedAt: new Date(),
      },
    ]);
    await PROCESSORS[QueueName.Notification](
      job({ notificationId: 'note-1' }),
      asLogger(log),
    );
    expect(deps.sendEmail).not.toHaveBeenCalled();

    script.results.push(
      [
        {
          id: 'note-1',
          userId: 'user-1',
          title: 'Update',
          body: 'Body',
          emailedAt: null,
        },
      ],
      [{ emailNotifications: true }],
      [],
    );
    await PROCESSORS[QueueName.Notification](
      job({ notificationId: 'note-1' }),
      asLogger(log),
    );
    expect(deps.sendEmail).not.toHaveBeenCalled();

    // The member turned the email copy off after the job was queued.
    script.results.push(
      [
        {
          id: 'note-1',
          userId: 'user-1',
          title: 'Update',
          body: 'Body',
          emailedAt: null,
        },
      ],
      [{ emailNotifications: false }],
    );
    await PROCESSORS[QueueName.Notification](
      job({ notificationId: 'note-1' }),
      asLogger(log),
    );
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.markEmailed).not.toHaveBeenCalled();

    script.results.push(
      [
        {
          id: 'note-1',
          userId: 'user-1',
          title: 'Update',
          body: 'Body',
          emailedAt: null,
        },
      ],
      [{ emailNotifications: true }],
      [{ email: 'person@council.example', name: 'Person' }],
    );
    await PROCESSORS[QueueName.Notification](
      job({ notificationId: 'note-1' }),
      asLogger(log),
    );
    expect(deps.renderNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Person',
        title: 'Update',
        appUrl: 'http://localhost:3000',
      }),
    );
    expect(deps.sendEmail).toHaveBeenCalledWith({
      to: 'person@council.example',
      subject: 'Notice',
      text: 'You have a notification',
    });
    expect(deps.markEmailed).toHaveBeenCalledWith('org-1', 'note-1');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('person@council.example');
  });

  it('verifies a tenant audit chain only after the tenant gate', async () => {
    const log = logger();
    await PROCESSORS[QueueName.AuditVerify](
      job({}, 'job', QueueName.AuditVerify),
      asLogger(log),
    );
    expect(deps.acceptTenantJob).toHaveBeenCalledTimes(1);
    expect(deps.processAuditVerifyJob).toHaveBeenCalledWith(
      {
        organisationId: 'org-1',
        correlationId: 'corr-1',
        platformChain: false,
        jobId: 'job-1',
      },
      log,
    );

    // A store outage throws so BullMQ retries the anchor write.
    deps.processAuditVerifyJob.mockRejectedValueOnce(new Error('anchor store down'));
    await expect(
      PROCESSORS[QueueName.AuditVerify](
        job({}, 'job', QueueName.AuditVerify),
        asLogger(log),
      ),
    ).rejects.toThrow(/anchor store down/);
  });

  it('a tenant id with platformChain set is still a gated tenant job', async () => {
    deps.acceptTenantJob.mockResolvedValue(false);
    await PROCESSORS[QueueName.AuditVerify](
      job({ platformChain: true }, 'job', QueueName.AuditVerify),
      asLogger(logger()),
    );
    expect(deps.acceptTenantJob).toHaveBeenCalledTimes(1);
    expect(deps.processAuditVerifyJob).not.toHaveBeenCalled();
  });

  it('routes only the exact platform payload to the platform chain', async () => {
    await PROCESSORS[QueueName.AuditVerify](
      job(
        { organisationId: 'platform', platformChain: true },
        'job',
        QueueName.AuditVerify,
      ),
      asLogger(logger()),
    );
    // The platform chain has no tenant, so the active-tenant gate is skipped.
    expect(deps.acceptTenantJob).not.toHaveBeenCalled();
    expect(deps.processAuditVerifyJob).toHaveBeenCalledWith(
      expect.objectContaining({ platformChain: true }),
      expect.anything(),
    );
  });

  it('delivers webhooks and exports, dropping a payload with no id', async () => {
    const log = logger();
    await PROCESSORS[QueueName.Webhook](job({}), asLogger(log));
    await PROCESSORS[QueueName.Export](job({}), asLogger(log));
    expect(deps.processWebhookDelivery).not.toHaveBeenCalled();
    expect(deps.processExport).not.toHaveBeenCalled();

    await PROCESSORS[QueueName.Webhook](job({ deliveryId: 'del-1' }), asLogger(log));
    await PROCESSORS[QueueName.Export](job({ exportRequestId: 'exp-1' }), asLogger(log));
    expect(deps.processWebhookDelivery).toHaveBeenCalledWith({
      organisationId: 'org-1',
      correlationId: 'corr-1',
      deliveryId: 'del-1',
    });
    expect(deps.processExport).toHaveBeenCalledWith({
      organisationId: 'org-1',
      correlationId: 'corr-1',
      exportRequestId: 'exp-1',
    });

    await PROCESSORS[QueueName.Export](job({}, 'sweep'), asLogger(log));
    expect(deps.processExportMaintenance).toHaveBeenCalledWith({
      organisationId: 'org-1',
      correlationId: 'corr-1',
    });
    expect(deps.processExport).toHaveBeenCalledTimes(1);

    deps.processWebhookDelivery.mockRejectedValueOnce(new Error('endpoint down'));
    await expect(
      PROCESSORS[QueueName.Webhook](job({ deliveryId: 'del-1' }), asLogger(log)),
    ).rejects.toThrow(/endpoint down/);
  });

  it('drops a key re-wrap job with no id or no row', async () => {
    const log = logger();
    await PROCESSORS[QueueName.KeyRewrap](job({}), asLogger(log));
    expect(deps.processOrganisationKeyRewrap).not.toHaveBeenCalled();

    await PROCESSORS[QueueName.KeyRewrap](job({ rewrapId: 'rw-1' }), asLogger(log));
    expect(deps.processOrganisationKeyRewrap).toHaveBeenCalledWith({
      organisationId: 'org-1',
      rewrapId: 'rw-1',
    });
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('runs retention and reminder sweeps for the tenant on the job', async () => {
    await PROCESSORS[QueueName.Retention](job({}), asLogger(logger()));
    await PROCESSORS[QueueName.Reminder](job({}), asLogger(logger()));
    expect(deps.processRetentionSweep).toHaveBeenCalledWith({
      organisationId: 'org-1',
      correlationId: 'corr-1',
    });
    expect(deps.processReminderSweep).toHaveBeenCalledWith({
      organisationId: 'org-1',
      correlationId: 'corr-1',
    });

    deps.processRetentionSweep.mockRejectedValueOnce(new Error('sweep failed'));
    await expect(
      PROCESSORS[QueueName.Retention](job({}), asLogger(logger())),
    ).rejects.toThrow(/sweep failed/);
  });
});
