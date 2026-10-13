import { describe, expect, it } from 'vitest';
import {
  RETENTION_RESOURCE_TYPES,
  dueForRetention,
  isExpired,
  isRetentionResourceType,
  retentionCutoff,
} from '@/domains/retention/rules';
import { createPolicySchema, placeHoldSchema } from '@/domains/retention/schemas';

const now = new Date(Date.UTC(2026, 6, 1, 0, 0, 0));
const day = 24 * 60 * 60 * 1000;

describe('retention expiry', () => {
  it('computes the cutoff and expiry correctly', () => {
    expect(retentionCutoff(30, now).getTime()).toBe(now.getTime() - 30 * day);
    // 31 days old > 30-day retention → expired.
    expect(isExpired(new Date(now.getTime() - 31 * day), 30, now)).toBe(true);
    // 29 days old < 30-day retention → not yet.
    expect(isExpired(new Date(now.getTime() - 29 * day), 30, now)).toBe(false);
  });
});

describe('dueForRetention (fail-safe on holds)', () => {
  const old = new Date(now.getTime() - 100 * day);
  it('acts on an expired, unheld record', () => {
    expect(
      dueForRetention({ recordDate: old, retentionDays: 30, isHeld: false, now }),
    ).toBe(true);
  });
  it('NEVER acts on a held record, even if long expired', () => {
    expect(
      dueForRetention({ recordDate: old, retentionDays: 30, isHeld: true, now }),
    ).toBe(false);
  });
  it('does not act on a record within retention', () => {
    const fresh = new Date(now.getTime() - 5 * day);
    expect(
      dueForRetention({ recordDate: fresh, retentionDays: 30, isHeld: false, now }),
    ).toBe(false);
  });
  it('never treats permanent retention as due', () => {
    expect(
      dueForRetention({ recordDate: old, retentionDays: null, isHeld: false, now }),
    ).toBe(false);
  });
});

describe('retention resource types + schemas', () => {
  it('recognises only known resource types (audit is never one)', () => {
    for (const t of RETENTION_RESOURCE_TYPES)
      expect(isRetentionResourceType(t)).toBe(true);
    expect(isRetentionResourceType('audit_event')).toBe(false);
    expect(isRetentionResourceType('audit_chain')).toBe(false);
  });

  it('validates policy and hold input', () => {
    expect(
      createPolicySchema.safeParse({
        resourceType: 'application',
        retentionDays: 365,
        action: 'purge',
        jurisdiction: 'nsw',
        authorityReference: 'GA39 example',
      }).success,
    ).toBe(true);
    // Longer than the old 10-year cap is a lawful keep, not a validation error.
    expect(
      createPolicySchema.safeParse({
        resourceType: 'application',
        retentionDays: 4000,
        action: 'anonymise',
        jurisdiction: 'vic',
      }).success,
    ).toBe(true);
    expect(
      createPolicySchema.safeParse({
        resourceType: 'certificate',
        action: 'retain',
        jurisdiction: 'qld',
        retentionDays: null,
      }).success,
    ).toBe(true);
    expect(
      createPolicySchema.safeParse({
        resourceType: 'application',
        retentionDays: 365,
        action: 'purge',
        jurisdiction: 'nsw',
      }).success,
    ).toBe(false);
    expect(
      createPolicySchema.safeParse({
        resourceType: 'audit_chain',
        retentionDays: 365,
        action: 'purge',
        jurisdiction: 'nsw',
        authorityReference: 'GA39 example',
      }).success,
    ).toBe(false);
    expect(
      createPolicySchema.safeParse({
        resourceType: 'application',
        retentionDays: 0,
        action: 'purge',
        jurisdiction: 'nsw',
        authorityReference: 'GA39 example',
      }).success,
    ).toBe(false);
    expect(
      placeHoldSchema.safeParse({
        resourceType: 'evidence',
        resourceId: '018f5b3a-0000-7000-8000-000000000000',
        reason: 'litigation',
      }).success,
    ).toBe(true);
  });
});
