import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueName, type TenantJob } from '@/lib/queues';
import { script } from './helpers/scripted-db';

/**
 * Processors move work. They do not score, rank, or decide Aboriginality.
 * A malformed payload is dropped. A downstream failure is rethrown so BullMQ
 * retries, except audit divergence, which will not heal on retry.
 */
const deps = vi.hoisted(() => ({
  processEvidenceScan: vi.fn(async () => undefined),
  processWebhookDelivery: vi.fn(async () => undefined),
  processExport: vi.fn(async () => undefined),
  processRetentionSweep: vi.fn(async () => undefined),
  processReminderSweep: vi.fn(async () => undefined),
  sendEmail: vi.fn(async () => undefined),
  markEmailed: vi.fn(async () => undefined),
  renderNotificationEmail: vi.fn(() => ({
    subject: 'Notice',
    text: 'You have a notification',
  })),
  verifyChain: vi.fn(
    async (): Promise<{
      ok: boolean;
      eventCount: number;
      divergence: { eventId: string; index: number; reason: string } | null;
    }> => ({ ok: true, eventCount: 1, divergence: null }),
  ),
}));

vi.mock('@/domains/evidence', () => ({ processEvidenceScan: deps.processEvidenceScan }));
vi.mock('@/domains/webhooks', () => ({
  processWebhookDelivery: deps.processWebhookDelivery,
}));
vi.mock('@/domains/reporting', () => ({ processExport: deps.processExport }));
vi.mock('@/domains/retention', () => ({
  processRetentionSweep: deps.processRetentionSweep,
}));
vi.mock('@/domains/calendar/service', () => ({
  processReminderSweep: deps.processReminderSweep,
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: deps.sendEmail }));
vi.mock('@/domains/notifications', () => ({
  markEmailed: deps.markEmailed,
  renderNotificationEmail: deps.renderNotificationEmail,
}));
vi.mock('@/domains/audit', () => ({ verifyChain: deps.verifyChain }));
vi.mock('@/db/tenant-db', async () => {
  const { scriptedTenantModule } = await import('./helpers/scripted-db');
  return scriptedTenantModule('org-1');
});

const { PROCESSORS, REGISTERED_QUEUES } = await import('../../worker/processors');

function job(data: Record<string, unknown>): Job<TenantJob> {
  return {
    id: 'job-1',
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
  deps.verifyChain.mockResolvedValue({ ok: true, eventCount: 1, divergence: null });
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

  it('sends email without logging the body', async () => {
    const log = logger();
    const secret = 'https://council.example/form/secret-token';
    await PROCESSORS[QueueName.Email](job({ to: 'ada@council.example' }), asLogger(log));
    expect(deps.sendEmail).not.toHaveBeenCalled();

    await PROCESSORS[QueueName.Email](
      job({
        to: 'ada@council.example',
        subject: 'Form',
        text: secret,
        html: '<p>hi</p>',
      }),
      asLogger(log),
    );
    expect(deps.sendEmail).toHaveBeenCalledWith({
      to: 'ada@council.example',
      subject: 'Form',
      text: secret,
      html: '<p>hi</p>',
    });
    const logged = JSON.stringify([...log.error.mock.calls, ...log.info.mock.calls]);
    expect(logged).not.toContain(secret);
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
      [],
    );
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

  it('logs audit divergence without retrying, and stays quiet when the chain is clean', async () => {
    const log = logger();
    await PROCESSORS[QueueName.AuditVerify](job({}), asLogger(log));
    expect(deps.verifyChain).toHaveBeenCalledWith('org-1');
    expect(log.info).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();

    deps.verifyChain.mockResolvedValue({
      ok: false,
      eventCount: 4,
      divergence: { eventId: 'evt-1', index: 2, reason: 'hash' },
    });
    await expect(
      PROCESSORS[QueueName.AuditVerify](job({}), asLogger(log)),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: 'audit_integrity_failure',
        alert: true,
        eventId: 'evt-1',
      }),
      expect.any(String),
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

    deps.processWebhookDelivery.mockRejectedValueOnce(new Error('endpoint down'));
    await expect(
      PROCESSORS[QueueName.Webhook](job({ deliveryId: 'del-1' }), asLogger(log)),
    ).rejects.toThrow(/endpoint down/);
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
