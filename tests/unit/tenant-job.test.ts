import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { uuidv7 } from 'uuidv7';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  orgs: [] as Array<{ id: string; status: string }>,
  recordAudit: vi.fn(async (_input: Record<string, unknown>) => ({})),
  recordPlatformAudit: vi.fn(async (_input: Record<string, unknown>) => ({})),
}));

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.orgs),
        }),
      }),
    }),
  },
}));

vi.mock('@/domains/audit/service', () => ({
  recordAudit: state.recordAudit,
  recordPlatformAudit: state.recordPlatformAudit,
}));

const { tenantJobSchema } = await import('@/lib/queues/tenant-job');
const { assertTenantJob } = await import('@/lib/queues');
const { acceptTenantJob } = await import('../../worker/tenant-job');

function logger(): Logger {
  return { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

beforeEach(() => {
  state.orgs = [];
  state.recordAudit.mockClear();
  state.recordPlatformAudit.mockClear();
});

describe('tenant job payload', () => {
  it('accepts a uuid organisation id and keeps extra opaque fields', () => {
    const payload = {
      organisationId: uuidv7(),
      correlationId: 'bp:scheduled:audit-verify:job',
      evidenceId: randomUUID(),
    };
    expect(tenantJobSchema.safeParse(payload).success).toBe(true);
    expect(assertTenantJob(payload)).toBe(payload);
  });

  it('refuses a payload without a valid organisation id', () => {
    expect(() =>
      assertTenantJob({ organisationId: 'not-a-uuid', correlationId: 'c-1' }),
    ).toThrow(/organisationId/);
  });
});

describe('acceptTenantJob', () => {
  it('drops an invalid payload and audits it on the platform chain', async () => {
    const accepted = await acceptTenantJob(
      { id: 'job-bad', queueName: 'email', data: { organisationId: 'nope' } },
      logger(),
    );
    expect(accepted).toBe(false);
    expect(state.recordAudit).not.toHaveBeenCalled();
    expect(state.recordPlatformAudit).toHaveBeenCalledOnce();
    expect(state.recordPlatformAudit.mock.calls[0]?.[0]).toMatchObject({
      action: 'job.rejected',
      result: 'denied',
      reason: 'payload_invalid',
    });
  });

  it('drops a job for a suspended organisation and audits that tenant', async () => {
    const organisationId = randomUUID();
    state.orgs = [{ id: organisationId, status: 'suspended' }];
    const accepted = await acceptTenantJob(
      {
        id: 'job-suspended',
        queueName: 'notification',
        data: { organisationId, correlationId: 'corr-suspended' },
      },
      logger(),
    );
    expect(accepted).toBe(false);
    expect(state.recordPlatformAudit).not.toHaveBeenCalled();
    expect(state.recordAudit).toHaveBeenCalledOnce();
    expect(state.recordAudit.mock.calls[0]?.[0]).toMatchObject({
      action: 'job.rejected',
      result: 'denied',
      reason: 'organisation_not_active',
      organisationId,
      after: { data: { status: 'suspended', queue: 'notification' } },
    });
  });

  it('drops a job for a missing organisation and audits the platform chain', async () => {
    const organisationId = randomUUID();
    const accepted = await acceptTenantJob(
      {
        id: 'job-missing',
        queueName: 'retention',
        data: { organisationId, correlationId: 'corr-missing' },
      },
      logger(),
    );
    expect(accepted).toBe(false);
    expect(state.recordAudit).not.toHaveBeenCalled();
    expect(state.recordPlatformAudit).toHaveBeenCalledOnce();
    expect(state.recordPlatformAudit.mock.calls[0]?.[0]).toMatchObject({
      action: 'job.rejected',
      result: 'denied',
      reason: 'organisation_not_found',
      correlationId: 'corr-missing',
      after: { data: { organisationId, queue: 'retention' } },
    });
  });

  it('accepts a job for an active organisation without an audit event', async () => {
    const organisationId = randomUUID();
    state.orgs = [{ id: organisationId, status: 'active' }];
    const accepted = await acceptTenantJob(
      {
        id: 'job-ok',
        queueName: 'reminder',
        data: { organisationId, correlationId: 'corr-ok' },
      },
      logger(),
    );
    expect(accepted).toBe(true);
    expect(state.recordAudit).not.toHaveBeenCalled();
    expect(state.recordPlatformAudit).not.toHaveBeenCalled();
  });
});
