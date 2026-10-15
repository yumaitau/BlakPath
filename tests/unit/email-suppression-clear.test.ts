import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as { id: string }[][],
  audits: [] as {
    action?: string;
    actorUserId?: string;
    resourceId?: string | null;
    reason?: string | null;
  }[],
  sets: [] as { clearedAt?: unknown; clearedReason?: unknown }[],
}));

vi.mock('@/db/client', () => {
  const db = {
    update: () => ({
      set: (values: { clearedAt?: unknown; clearedReason?: unknown }) => {
        state.sets.push(values);
        return {
          where: () => ({
            returning: async () => state.rows.shift() ?? [],
          }),
        };
      },
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
  };
  return { db };
});

vi.mock('@/domains/audit/service', () => ({
  recordAudit: vi.fn(),
  recordPlatformAudit: vi.fn(async (input: (typeof state.audits)[number]) => {
    state.audits.push(input);
    return {
      id: 'audit-1',
      organisationId: null,
      hash: 'h',
      prevHash: null,
      timestamp: new Date(),
    };
  }),
}));

import { clearSuppression } from '@/domains/email/service';

const ACTOR = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  state.rows = [];
  state.audits = [];
  state.sets = [];
});

describe('clearSuppression', () => {
  it('clears an active row and audits the operator', async () => {
    state.rows.push([{ id: 'sup-1' }]);
    const result = await clearSuppression({
      address: 'Person@Example.org',
      actorUserId: ACTOR,
      reason: 'mailbox restored',
    });
    expect(result).toEqual({ cleared: true });
    expect(state.sets[0]?.clearedAt).toBeInstanceOf(Date);
    expect(state.sets[0]?.clearedReason).toBe('mailbox restored');
    expect(state.audits).toEqual([
      expect.objectContaining({
        action: 'email.suppression_cleared',
        actorUserId: ACTOR,
        resourceId: 'sup-1',
        reason: 'email.suppression_note',
      }),
    ]);
  });

  it('does not audit when nothing is active', async () => {
    state.rows.push([]);
    const result = await clearSuppression({
      address: 'person@example.org',
      actorUserId: ACTOR,
    });
    expect(result).toEqual({ cleared: false });
    expect(state.audits).toEqual([]);
  });

  it('rejects an address or actor that is not usable', async () => {
    await expect(
      clearSuppression({ address: 'not-an-email', actorUserId: ACTOR }),
    ).rejects.toThrow();
    await expect(
      clearSuppression({ address: 'person@example.org', actorUserId: 'operator' }),
    ).rejects.toThrow();
    expect(state.sets).toEqual([]);
  });
});
