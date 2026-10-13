import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeApplicationCursor,
  encodeApplicationCursor,
} from '@/domains/applications/cursor';
import {
  blindSearchToken,
  indexedPrefixes,
  isUnderMinimumSearch,
  queryTokens,
  searchBlindKey,
} from '@/lib/search/blind-index';

const ORG = '018f5b3a-0000-7000-8000-000000000001';

describe('search prefixes', () => {
  it('indexes each word of a reference and a name from two characters', () => {
    const prefixes = indexedPrefixes('APP-2026-0007');
    expect(prefixes).toEqual(expect.arrayContaining(['app', '2026', '0007', '20', '00']));
    expect(prefixes).not.toContain('a');
    expect(indexedPrefixes('Jane Mary Smith')).toEqual(
      expect.arrayContaining(['jane', 'mary', 'smith', 'sm']),
    );
  });

  it('turns a typed query into words and ignores a single letter', () => {
    expect(queryTokens('  Jane   Sm ')).toEqual(['jane', 'sm']);
    expect(queryTokens('APP-2026')).toEqual(['app', '2026']);
    expect(isUnderMinimumSearch('a')).toBe(true);
    expect(isUnderMinimumSearch('')).toBe(false);
    expect(isUnderMinimumSearch('jo')).toBe(false);
  });
});

describe('blind search token', () => {
  const key = searchBlindKey(randomBytes(32));

  it('is stable and separates tenant, field, and prefix', () => {
    const token = blindSearchToken(key, ORG, 'name', 'smith');
    expect(blindSearchToken(key, ORG, 'name', 'smith')).toBe(token);
    expect(blindSearchToken(key, ORG, 'reference', 'smith')).not.toBe(token);
    expect(
      blindSearchToken(key, '018f5b3a-0000-7000-8000-000000000002', 'name', 'smith'),
    ).not.toBe(token);
    expect(blindSearchToken(key, ORG, 'name', 'smi')).not.toBe(token);
    expect(token).not.toContain('smith');
  });

  it('changes when the master key changes', () => {
    const other = searchBlindKey(randomBytes(32));
    expect(blindSearchToken(key, ORG, 'name', 'smith')).not.toBe(
      blindSearchToken(other, ORG, 'name', 'smith'),
    );
  });
});

describe('application cursor', () => {
  it('round-trips a keyset position', () => {
    const encoded = encodeApplicationCursor({
      createdAt: '2026-04-01T00:00:00.000Z',
      id: '018f5b3a-0000-7000-8000-0000000000ab',
    });
    expect(decodeApplicationCursor(encoded)).toEqual({
      createdAt: '2026-04-01T00:00:00.000Z',
      id: '018f5b3a-0000-7000-8000-0000000000ab',
    });
  });

  it('rejects a tampered or empty cursor', () => {
    expect(decodeApplicationCursor('not-a-cursor')).toBeNull();
    expect(decodeApplicationCursor('')).toBeNull();
    const encoded = encodeApplicationCursor({
      createdAt: '2026-04-01T00:00:00.000Z',
      id: '018f5b3a-0000-7000-8000-0000000000ab',
    });
    expect(decodeApplicationCursor(`${encoded}x`)).toBeNull();
  });
});
