import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  sets: [] as unknown[],
  sent: [] as Array<{ to: string; subject: string; text: string }>,
  token: 'sealed-join-token-value',
}));

vi.mock('@/db/tenant-db', () => {
  function chain() {
    const builder: Record<string, unknown> = {};
    const passthrough = () => builder;
    for (const method of ['from', 'innerJoin', 'where', 'limit']) {
      builder[method] = passthrough;
    }
    builder.set = (values: unknown) => {
      state.sets.push(values);
      return builder;
    };
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(state.results.shift() ?? []).then(resolve, reject);
    return builder;
  }

  const db = {
    select: () => chain(),
    update: () => chain(),
  };
  return {
    scopeFor: () => ({
      organisationId: 'org-1',
      db,
      where: () => ({}),
    }),
  };
});

vi.mock('@/lib/encryption/envelope', () => ({
  decryptField: vi.fn(() => state.token),
}));

vi.mock('@/lib/email/mailer', () => ({
  sendEmail: vi.fn(async (input: { to: string; subject: string; text: string }) => {
    state.sent.push(input);
  }),
}));

const { deliverInvitationEmail } = await import('@/lib/email/invitation-delivery');

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  state.results.length = 0;
  state.sets.length = 0;
  state.sent.length = 0;
});

describe('deliverInvitationEmail', () => {
  it('composes the membership message from the row, not the job', async () => {
    const recipient = 'member@example.com';
    state.results.push([
      {
        email: recipient,
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
        tokenHash: 'hash-1',
        tokenSeal: { v: 1, iv: 'a', tag: 'b', wrappedDek: 'c', ciphertext: 'd' },
        roleName: 'Member',
        organisationName: 'Example Council',
      },
    ]);

    const job = {
      kind: 'membership' as const,
      organisationId: 'org-1',
      invitationId: 'inv-1',
      jobId: 'membership-invitation:inv-1:1',
      logger,
    };
    expect(JSON.stringify(job)).not.toContain(recipient);
    expect(JSON.stringify(job)).not.toContain(state.token);

    await deliverInvitationEmail(job);

    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]?.to).toBe(recipient);
    expect(state.sent[0]?.text).toContain(`/join/${state.token}`);
    expect(state.sent[0]?.text).toContain('Example Council');
    expect(state.sets).toEqual([{ tokenSeal: null }]);
  });
});
