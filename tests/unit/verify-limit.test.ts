import { beforeEach, describe, expect, it, vi } from 'vitest';

const counts = vi.hoisted(() => new Map<string, number>());
const incr = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  }),
);

vi.mock('@/lib/redis', () => ({
  platformKey: (...parts: Array<string | number>) => `bp:sys:${parts.join(':')}`,
  redis: {
    incr,
    expire: vi.fn(async () => 1),
  },
}));

import {
  allowCertificateLookup,
  allowHolderCheck,
} from '@/domains/certificates/verify-limit';

describe('certificate verification rate limit', () => {
  beforeEach(() => {
    counts.clear();
    incr.mockClear();
    incr.mockImplementation(async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    });
  });

  it('allows lookups inside the window and then refuses', async () => {
    const decisions: boolean[] = [];
    for (let i = 0; i < 61; i += 1) {
      decisions.push(await allowCertificateLookup('203.0.113.4'));
    }
    expect(decisions.slice(0, 60).every(Boolean)).toBe(true);
    expect(decisions[60]).toBe(false);
  });

  it('limits holder checks per address without storing the raw code', async () => {
    const code = 'abcdefghijABCDEFGHIJ0123456789ab';
    for (let i = 0; i < 15; i += 1) {
      expect(await allowHolderCheck('203.0.113.8', code)).toBe(true);
    }
    expect(await allowHolderCheck('203.0.113.8', code)).toBe(false);
    const keys = [...counts.keys()];
    expect(keys.some((key) => key.includes(code))).toBe(false);
    expect(keys.some((key) => key.includes('203.0.113.8'))).toBe(false);
  });

  it('still limits when the shared store is unavailable', async () => {
    incr.mockRejectedValue(new Error('redis down'));
    const decisions: boolean[] = [];
    for (let i = 0; i < 61; i += 1) {
      decisions.push(await allowCertificateLookup('198.51.100.2'));
    }
    expect(decisions[0]).toBe(true);
    expect(decisions[60]).toBe(false);
  });
});
