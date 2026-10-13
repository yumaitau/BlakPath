import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_DECEASED_NAME_WARNING,
  deceasedNameWarningFromTerminology,
} from '@/domains/family-links/cultural-safety';
import { openFamilyField, sealFamilyField } from '@/domains/family-links/fields';
import { __resetEnvCache } from '@/lib/env';

beforeAll(() => {
  process.env.ENCRYPTION_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.ENCRYPTION_KEY_VERSION = '1';
  __resetEnvCache();
});

const ctx = {
  organisationId: 'org-1',
  rowId: 'row-1',
  column: 'relative_name' as const,
};

describe('family-link field sealing', () => {
  it('stores ciphertext and opens it only for the same row, column, and organisation', () => {
    const sealed = sealFamilyField('Aunty May', ctx);
    expect(sealed.includes('Aunty May')).toBe(false);
    expect(openFamilyField(sealed, ctx)).toBe('Aunty May');
    expect(() => openFamilyField(sealed, { ...ctx, rowId: 'row-2' })).toThrow();
    expect(() => openFamilyField(sealed, { ...ctx, organisationId: 'org-2' })).toThrow();
    expect(() => openFamilyField(sealed, { ...ctx, column: 'notes' })).toThrow();
  });

  it('rejects plaintext and malformed blobs', () => {
    expect(() => openFamilyField('Aunty May', ctx)).toThrow();
    expect(() => openFamilyField('{', ctx)).toThrow();
  });
});

describe('deceased-name warning', () => {
  it('uses organisation wording when it is present and valid', () => {
    expect(
      deceasedNameWarningFromTerminology({
        deceasedNameWarning: '  Please pause before this name.  ',
        other: true,
      }),
    ).toBe('Please pause before this name.');
  });

  it('falls back when the organisation has no usable warning', () => {
    expect(deceasedNameWarningFromTerminology(null)).toBe(DEFAULT_DECEASED_NAME_WARNING);
    expect(deceasedNameWarningFromTerminology('nope')).toBe(
      DEFAULT_DECEASED_NAME_WARNING,
    );
    expect(deceasedNameWarningFromTerminology({ deceasedNameWarning: '' })).toBe(
      DEFAULT_DECEASED_NAME_WARNING,
    );
    expect(
      deceasedNameWarningFromTerminology({ deceasedNameWarning: 'x'.repeat(501) }),
    ).toBe(DEFAULT_DECEASED_NAME_WARNING);
  });
});
