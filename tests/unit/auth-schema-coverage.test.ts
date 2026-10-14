import { describe, expect, it } from 'vitest';
import { findAuthSchemaGaps, missingAuthFields } from '@/lib/auth/schema-coverage';

describe('auth schema coverage', () => {
  it('covers every field the enabled Better Auth plugins expect', () => {
    expect(findAuthSchemaGaps()).toEqual([]);
  });

  it('reports a plugin field the Drizzle schema does not declare', () => {
    expect(
      missingAuthFields(
        { user: { fields: { twoFactorEnabled: { type: 'boolean' } } } },
        { user: new Set(['name', 'email']) },
      ),
    ).toEqual(['user.twoFactorEnabled']);
  });

  it('reports a plugin model with no Drizzle table', () => {
    expect(
      missingAuthFields({ twoFactor: { fields: { secret: { type: 'string' } } } }, {}),
    ).toEqual(['twoFactor: no Drizzle table']);
  });
});
