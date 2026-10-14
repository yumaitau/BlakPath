import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/reset-queue', async () => {
  const actual = await vi.importActual('@/lib/auth/reset-queue');
  return {
    ...(actual as Record<string, unknown>),
    enqueuePasswordResetEmail: vi.fn(),
  };
});

import { enqueuePasswordResetEmail } from '@/lib/auth/reset-queue';
import { RESET_RESPONSE_BUDGET_MS, withConstantTime } from '@/lib/auth/reset-timing';
import { AUTH_EMAIL_JOB_OPTIONS } from '@/lib/auth/reset-queue';
import { authMailer } from '@/lib/email/mailer';
import { processAuthEmailJob } from '../../worker/auth-email';

const enqueue = vi.mocked(enqueuePasswordResetEmail);

beforeEach(() => {
  enqueue.mockReset();
  enqueue.mockResolvedValue(undefined);
});

describe('password reset timing', () => {
  it('pads two fast paths to the same budget and does not pad past it', async () => {
    async function elapsed(workMs: number): Promise<number> {
      let nowMs = 0;
      await withConstantTime(
        RESET_RESPONSE_BUDGET_MS,
        async () => {
          nowMs += workMs;
          return 'ok';
        },
        async (ms) => {
          nowMs += ms;
        },
        () => nowMs,
      );
      return nowMs;
    }

    expect(await elapsed(20)).toBe(RESET_RESPONSE_BUDGET_MS);
    expect(await elapsed(200)).toBe(RESET_RESPONSE_BUDGET_MS);
    expect(await elapsed(RESET_RESPONSE_BUDGET_MS + 40)).toBe(
      RESET_RESPONSE_BUDGET_MS + 40,
    );
  });

  it('still pads when the handler throws', async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    await expect(
      withConstantTime(
        RESET_RESPONSE_BUDGET_MS,
        async () => {
          nowMs += 25;
          throw new Error('boom');
        },
        async (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
        () => nowMs,
      ),
    ).rejects.toThrow('boom');
    expect(sleeps).toEqual([RESET_RESPONSE_BUDGET_MS - 25]);
  });
});

describe('password reset mail', () => {
  it('enqueues the reset and resolves when the queue is down', async () => {
    const message = {
      to: 'ada@example.com',
      name: 'Ada',
      url: 'https://blakpath.example/reset?token=secret',
      token: 'secret',
    };
    await authMailer.sendPasswordResetEmail(message);
    expect(enqueue).toHaveBeenCalledWith({
      to: message.to,
      name: message.name,
      url: message.url,
    });

    enqueue.mockRejectedValueOnce(new Error('redis down'));
    await expect(authMailer.sendPasswordResetEmail(message)).resolves.toBeUndefined();
    expect(AUTH_EMAIL_JOB_OPTIONS.attempts).toBe(5);
    expect(AUTH_EMAIL_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 2_000 });
  });

  it('delivers a queued reset without re-queueing, and drops a bad payload', async () => {
    const deliver = vi.fn(async () => undefined);
    await processAuthEmailJob(
      {
        kind: 'password-reset',
        to: 'ada@example.com',
        name: 'Ada',
        url: 'https://blakpath.example/reset?token=secret',
      },
      deliver,
    );
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({
      to: 'ada@example.com',
      name: 'Ada',
      url: 'https://blakpath.example/reset?token=secret',
    });

    deliver.mockClear();
    await processAuthEmailJob({ kind: 'password-reset', to: 'ada@example.com' }, deliver);
    expect(deliver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
