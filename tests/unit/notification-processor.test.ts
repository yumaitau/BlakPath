import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

/**
 * Notification email delivery: the recipient must still be an ACTIVE member
 * of the tenant, and the email must never carry the notification's free-text
 * title or body (which may hold case details).
 */

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  sendEmail: vi.fn(async (_input: { to: string; subject: string; text: string }) => {}),
  markEmailed: vi.fn(async () => {}),
}));

vi.mock('@/db/tenant-db', () => {
  function chain() {
    const builder: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'innerJoin']) builder[method] = () => builder;
    builder.limit = () => Promise.resolve(state.results.shift() ?? []);
    return builder;
  }
  return { scopeFor: () => ({ db: { select: () => chain() } }) };
});
vi.mock('@/lib/email/mailer', () => ({ sendEmail: state.sendEmail }));
// The tenant gate is covered elsewhere; these jobs belong to an active tenant.
vi.mock('../../worker/tenant-job', () => ({ acceptTenantJob: async () => true }));
vi.mock('@/domains/notifications', async () => ({
  markEmailed: state.markEmailed,
  renderNotificationEmail: (await import('@/domains/notifications/templates'))
    .renderNotificationEmail,
}));
vi.mock('@/domains/evidence', () => ({ processEvidenceScan: vi.fn() }));
vi.mock('@/domains/webhooks', () => ({ processWebhookDelivery: vi.fn() }));
vi.mock('@/domains/reporting', () => ({ processExport: vi.fn() }));
vi.mock('@/domains/retention', () => ({ processRetentionSweep: vi.fn() }));
vi.mock('@/domains/audit', () => ({ verifyChain: vi.fn() }));
vi.mock('@/lib/queues', () => ({
  QueueName: {
    MalwareScan: 'malware-scan',
    Email: 'email',
    Notification: 'notification',
    AuditVerify: 'audit-verify',
    Retention: 'retention',
    Export: 'export',
    Webhook: 'webhook',
    Reminder: 'reminder',
  },
}));

const { PROCESSORS } = await import('@worker/processors');
const processNotification = PROCESSORS['notification' as keyof typeof PROCESSORS];

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function job(): Job<{ organisationId: string; correlationId: string }> {
  return {
    id: 'job-1',
    data: { organisationId: 'org-a', correlationId: 'corr-1', notificationId: 'n-1' },
  } as unknown as Job<{ organisationId: string; correlationId: string }>;
}

const caseDetail = 'Smith family — application 2026-041';

beforeEach(() => {
  state.results.length = 0;
  state.sendEmail.mockClear();
  state.markEmailed.mockClear();
});

describe('notification processor', () => {
  it('sends a generic email with no title/body content to an active member', async () => {
    state.results.push(
      [
        {
          id: 'n-1',
          userId: 'user-1',
          type: 'application.assigned',
          title: caseDetail,
          body: `Notes about ${caseDetail}`,
          resourceType: 'application',
          resourceId: 'app-1',
          emailedAt: null,
        },
      ],
      [{ emailNotifications: true }],
      [{ email: 'sam@example.org', name: 'Sam' }],
    );
    await processNotification(job(), logger);

    expect(state.sendEmail).toHaveBeenCalledOnce();
    const sent = state.sendEmail.mock.calls[0]![0];
    expect(sent.to).toBe('sam@example.org');
    expect(sent.subject).not.toContain('Smith');
    expect(sent.text).not.toContain('Smith');
    expect(sent.text).not.toContain('2026-041');
    expect(state.markEmailed).toHaveBeenCalledWith('org-a', 'n-1');
  });

  it('includes the local start time (not the event title) for reminders', async () => {
    state.results.push(
      [
        {
          id: 'n-1',
          userId: 'user-1',
          type: 'calendar-reminder',
          title: `Reminder: ${caseDetail}`,
          body: 'Starts soon at the Smith residence.',
          resourceType: 'calendar_event',
          resourceId: 'event-1',
          emailedAt: null,
        },
      ],
      [{ emailNotifications: true }],
      [{ email: 'sam@example.org', name: 'Sam' }],
      [{ startAt: new Date('2026-10-14T22:30:00Z'), timezone: 'Australia/Sydney' }],
    );
    await processNotification(job(), logger);

    const sent = state.sendEmail.mock.calls[0]![0];
    expect(sent.text).toContain('Thursday 15 October 2026 at 9:30 am AEDT');
    expect(sent.text).not.toContain('Smith');
    expect(sent.text).not.toContain('T22:30');
  });

  it('skips (without retry) a recipient who is no longer an active member', async () => {
    state.results.push(
      [
        {
          id: 'n-1',
          userId: 'user-1',
          type: 'application.assigned',
          title: 'x',
          body: null,
          resourceType: null,
          resourceId: null,
          emailedAt: null,
        },
      ],
      [], // no active membership (suspended/revoked): no preference row
    );
    await expect(processNotification(job(), logger)).resolves.toBeUndefined();
    expect(state.sendEmail).not.toHaveBeenCalled();
    expect(state.markEmailed).not.toHaveBeenCalled();
  });

  it('stays idempotent when the notification was already emailed', async () => {
    state.results.push([
      {
        id: 'n-1',
        userId: 'user-1',
        type: 'x',
        title: 'x',
        emailedAt: new Date(),
      },
    ]);
    await processNotification(job(), logger);
    expect(state.sendEmail).not.toHaveBeenCalled();
  });
});
