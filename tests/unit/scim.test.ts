import { describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/permissions/errors';
import { enforceScimRateLimit } from '@/domains/scim/rate-limit';
import {
  diffRoleIds,
  mapGroupsToRoles,
  scimControllableRoles,
} from '@/domains/scim/roles';
import { createScimCredentialSchema } from '@/domains/scim/schemas';
import {
  generateScimToken,
  hashScimToken,
  looksLikeScimToken,
  scimDisplayPrefix,
  SCIM_TOKEN_PREFIX,
} from '@/domains/scim/tokens';

describe('scim token primitives', () => {
  it('hashes deterministically and never echoes the token', () => {
    const token = generateScimToken();
    const hash = hashScimToken(token);
    expect(hash).toBe(hashScimToken(token));
    expect(hash).not.toBe(hashScimToken(`${token}x`));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(looksLikeScimToken(token)).toBe(true);
    expect(looksLikeScimToken('bp_not_a_scim_token_value')).toBe(false);
    expect(scimDisplayPrefix(token)).toBe(token.slice(0, SCIM_TOKEN_PREFIX.length + 6));
    expect(scimDisplayPrefix(token).startsWith(SCIM_TOKEN_PREFIX)).toBe(true);
  });
});

describe('scim role mapping', () => {
  it('keeps allow-listed slugs and drops organisation-admin unless opted in', () => {
    const input = {
      userName: 'person@example.test',
      groups: [
        { display: 'case-officer' },
        { display: 'organisation-admin' },
        { display: 'platform-operator' },
        { display: 'Case Officer' },
      ],
      entitlements: [{ value: 'case-officer' }, { value: 'intake-officer' }],
    };
    expect(mapGroupsToRoles(input, false)).toEqual(['case-officer', 'intake-officer']);
    expect(mapGroupsToRoles(input, true)).toEqual([
      'case-officer',
      'organisation-admin',
      'intake-officer',
    ]);
    expect(scimControllableRoles(false)).not.toContain('organisation-admin');
    expect(scimControllableRoles(true)).toContain('organisation-admin');
  });

  it('diffs role ids so a removed group is a removal', () => {
    expect(diffRoleIds(['case', 'intake'], ['intake'])).toEqual({
      add: [],
      remove: ['case'],
    });
    expect(diffRoleIds(['intake'], ['intake', 'records'])).toEqual({
      add: ['records'],
      remove: [],
    });
  });
});

describe('createScimCredentialSchema', () => {
  it('defaults the organisation-admin opt-in to off', () => {
    const parsed = createScimCredentialSchema.parse({ name: 'Council IdP' });
    expect(parsed.allowOrganisationAdmin).toBe(false);
    expect(parsed.expiresInDays).toBe(365);
    expect(
      createScimCredentialSchema.parse({
        name: 'Council IdP',
        allowOrganisationAdmin: true,
      }).allowOrganisationAdmin,
    ).toBe(true);
  });
});

describe('scim rate limit', () => {
  it('rejects once the bucket is over the max and resets after the window', () => {
    const key = `unit-${generateScimToken()}`;
    expect(() => enforceScimRateLimit(key, 1_000, 1)).not.toThrow();
    expect(() => enforceScimRateLimit(key, 1_500, 1)).toThrow(AuthorizationError);
    expect(() => enforceScimRateLimit(key, 1_000 + 60_000, 1)).not.toThrow();
  });
});
