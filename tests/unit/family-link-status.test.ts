import { describe, expect, it } from 'vitest';
import {
  FAMILY_LINK_STATUSES,
  canDecide,
  canWithdraw,
  isDecided,
} from '@/domains/family-links/status';
import {
  decideFamilyLinkSchema,
  requestFamilyLinkSchema,
} from '@/domains/family-links/schemas';
import { assertDifferentActor } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';

describe('family-link status rules', () => {
  it('only a requested link can be decided or withdrawn', () => {
    expect(canDecide('requested')).toBe(true);
    expect(canWithdraw('requested')).toBe(true);
    for (const s of ['approved', 'disputed', 'withdrawn'] as const) {
      expect(canDecide(s)).toBe(false);
      expect(canWithdraw(s)).toBe(false);
    }
  });

  it('approved and disputed are decided; requested and withdrawn are not', () => {
    expect(isDecided('approved')).toBe(true);
    expect(isDecided('disputed')).toBe(true);
    expect(isDecided('requested')).toBe(false);
    expect(isDecided('withdrawn')).toBe(false);
  });

  it('lists every lifecycle state', () => {
    expect([...FAMILY_LINK_STATUSES]).toEqual([
      'requested',
      'approved',
      'disputed',
      'withdrawn',
    ]);
  });
});

describe('separation of duties on decision', () => {
  it('a different approver is allowed; the requester is not', () => {
    // This is the exact guard the service applies before approve/dispute.
    expect(() => assertDifferentActor('approver-1', 'requester-2')).not.toThrow();
    expect(() => assertDifferentActor('same-user', 'same-user')).toThrow(
      AuthorizationError,
    );
    // A null requester (e.g. deleted account) fails closed — cannot be decided.
    expect(() => assertDifferentActor('approver-1', null)).toThrow(AuthorizationError);
  });
});

describe('family-link schemas', () => {
  it('request requires relationship and relative name', () => {
    expect(
      requestFamilyLinkSchema.safeParse({ relationship: 'grandmother' }).success,
    ).toBe(false);
    expect(
      requestFamilyLinkSchema.safeParse({
        relationship: 'grandmother',
        relativeName: 'Aunty May',
        community: 'Example Nation',
      }).success,
    ).toBe(true);
  });

  it('accepts an optional deceased flag and rejects a non-boolean', () => {
    expect(
      requestFamilyLinkSchema.safeParse({
        relationship: 'grandmother',
        relativeName: 'Aunty May',
        relativeDeceased: true,
      }).success,
    ).toBe(true);
    expect(
      requestFamilyLinkSchema.safeParse({
        relationship: 'grandmother',
        relativeName: 'Aunty May',
        relativeDeceased: 'yes',
      }).success,
    ).toBe(false);
  });

  it('decide note is optional and bounded', () => {
    expect(decideFamilyLinkSchema.safeParse({}).success).toBe(true);
    expect(decideFamilyLinkSchema.safeParse({ note: 'x'.repeat(5001) }).success).toBe(
      false,
    );
  });
});
