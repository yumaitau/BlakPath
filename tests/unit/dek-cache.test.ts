import { describe, expect, it } from 'vitest';
import { DEK_CACHE_MAX_TTL_MS, DekCache } from '@/lib/encryption/dek-cache';

describe('DEK cache', () => {
  it('refuses a TTL longer than 5 minutes', () => {
    expect(() => new DekCache({ ttlMs: DEK_CACHE_MAX_TTL_MS + 1, maxUses: 2 })).toThrow(
      /5 minutes/,
    );
  });

  it('zeroes the data key when the use limit evicts it', () => {
    const seen: Buffer[] = [];
    const cache = new DekCache({
      ttlMs: 60_000,
      maxUses: 1,
      onEvict: (zeroed) => {
        seen.push(Buffer.from(zeroed));
      },
    });
    const dek = Buffer.alloc(32, 7);
    cache.set('wrapped', dek, 'org-a');
    dek.fill(1);

    const first = cache.get('wrapped');
    expect(first?.every((byte) => byte === 7)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.every((byte) => byte === 0)).toBe(true);
    expect(cache.get('wrapped')).toBeNull();
  });

  it('drops every entry for an organisation and zeroes them', () => {
    const seen: number[] = [];
    const cache = new DekCache({
      ttlMs: 60_000,
      maxUses: 5,
      onEvict: (zeroed) => {
        seen.push(zeroed.length);
        expect(zeroed.every((byte) => byte === 0)).toBe(true);
      },
    });
    cache.set('a', Buffer.alloc(32, 3), 'org-a');
    cache.set('b', Buffer.alloc(32, 4), 'org-a');
    cache.set('c', Buffer.alloc(32, 5), 'org-b');
    cache.evictOrganisation('org-a');
    expect(seen).toEqual([32, 32]);
    expect(cache.get('c')?.every((byte) => byte === 5)).toBe(true);
  });

  it('expires an entry when the TTL passes', () => {
    let now = 1_000;
    const cache = new DekCache({ ttlMs: 500, maxUses: 5, now: () => now });
    cache.set('k', Buffer.alloc(32, 9), 'org');
    expect(cache.get('k')).not.toBeNull();
    now = 1_500;
    expect(cache.get('k')).toBeNull();
  });
});
