import { beforeEach, describe, expect, it, vi } from 'vitest';

const addJob = vi.hoisted(() =>
  vi.fn(
    async (
      _queue: string,
      _jobName: string,
      _data: Record<string, string>,
      _options: { jobId: string },
    ) => 'job-1',
  ),
);

vi.mock('@/lib/queues', () => ({
  QueueName: { Email: 'email' },
  addJob,
}));

const { queueInvitationEmail } = await import('@/lib/email/queue');

beforeEach(() => {
  addJob.mockClear();
});

describe('invitation email jobs', () => {
  it('queues an invitation id and no recipient address or token', async () => {
    const recipient = 'forced.recipient@example.com';
    const token = 'one-time-join-token-value';

    await queueInvitationEmail({
      organisationId: 'org-1',
      correlationId: 'corr-1',
      invitationId: 'inv-1',
      kind: 'membership',
      generation: '1710000000000',
    });

    expect(addJob).toHaveBeenCalledOnce();
    const call = addJob.mock.calls[0];
    expect(call?.[0]).toBe('email');
    expect(call?.[1]).toBe('membership-invitation');
    expect(call?.[2]).toEqual({
      organisationId: 'org-1',
      correlationId: 'corr-1',
      invitationId: 'inv-1',
    });
    expect(call?.[3]).toEqual({ jobId: 'membership-invitation:inv-1:1710000000000' });
    const serialised = JSON.stringify(call);
    expect(serialised).not.toContain(recipient);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain('@');
  });

  it('reuses one job id for the same logical send', async () => {
    const input = {
      organisationId: 'org-1',
      correlationId: 'corr-1',
      invitationId: 'inv-9',
      kind: 'form' as const,
    };

    await queueInvitationEmail(input);
    await queueInvitationEmail({ ...input, correlationId: 'corr-2' });

    const first = addJob.mock.calls[0]?.[3];
    const second = addJob.mock.calls[1]?.[3];
    expect(first).toEqual({ jobId: 'form-invitation:inv-9' });
    expect(second).toEqual(first);
  });
});
