import { describe, expect, it } from 'vitest';
import { expectRow } from '@/db/expect-row';

describe('expectRow', () => {
  it('returns the row when the write returned one', () => {
    const row = { id: '01' };
    expect(expectRow(row, 'widget')).toBe(row);
  });

  it('throws when the database returned no row', () => {
    expect(() => expectRow(undefined, 'widget')).toThrow(
      'Expected widget to be returned from the database.',
    );
  });
});
