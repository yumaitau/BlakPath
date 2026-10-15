import { describe, expect, it } from 'vitest';
import {
  decodeApplicationCursor,
  encodeApplicationCursor,
} from '@/domains/applications/cursor';

describe('application cursor', () => {
  it('round-trips a keyset position', () => {
    const encoded = encodeApplicationCursor({
      createdAt: '2026-04-01T00:00:00.123456Z',
      id: '018f5b3a-0000-7000-8000-0000000000ab',
    });
    expect(decodeApplicationCursor(encoded)).toEqual({
      createdAt: '2026-04-01T00:00:00.123456Z',
      id: '018f5b3a-0000-7000-8000-0000000000ab',
    });
  });

  it('rejects a tampered or empty cursor', () => {
    expect(decodeApplicationCursor('not-a-cursor')).toBeNull();
    expect(decodeApplicationCursor('')).toBeNull();
    const encoded = encodeApplicationCursor({
      createdAt: '2026-04-01T00:00:00.123456Z',
      id: '018f5b3a-0000-7000-8000-0000000000ab',
    });
    expect(decodeApplicationCursor(`${encoded}x`)).toBeNull();
  });

  it('rejects a millisecond-only or invalid timestamp', () => {
    const id = '018f5b3a-0000-7000-8000-0000000000ab';
    expect(
      decodeApplicationCursor(
        encodeApplicationCursor({ createdAt: '2026-04-01T00:00:00.000Z', id }),
      ),
    ).toBeNull();
    expect(
      decodeApplicationCursor(
        encodeApplicationCursor({ createdAt: '2026-13-45T00:00:00.000000Z', id }),
      ),
    ).toBeNull();
    expect(
      decodeApplicationCursor(
        encodeApplicationCursor({ createdAt: '2026-04-01T00:00:00.000000Z', id: 'x' }),
      ),
    ).toBeNull();
  });
});
