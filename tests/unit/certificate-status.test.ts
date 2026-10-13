import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_STATUSES,
  canReissue,
  canRevoke,
  canSign,
  eligibleDecision,
  isValid,
  isWellFormedVerificationCode,
  makeCertificateReference,
} from '@/domains/certificates/status';
import {
  generateCertificateSchema,
  revokeCertificateSchema,
} from '@/domains/certificates/schemas';

describe('certificate eligibility (human decision only)', () => {
  it('is eligible only from a finalised, confirmed decision', () => {
    expect(eligibleDecision({ status: 'finalised', finalOutcome: 'confirmed' })).toBe(
      true,
    );
    expect(eligibleDecision({ status: 'finalised', finalOutcome: 'not_confirmed' })).toBe(
      false,
    );
    expect(eligibleDecision({ status: 'finalised', finalOutcome: 'deferred' })).toBe(
      false,
    );
    expect(eligibleDecision({ status: 'proposed', finalOutcome: 'confirmed' })).toBe(
      false,
    );
    expect(eligibleDecision({ status: 'finalised', finalOutcome: null })).toBe(false);
  });
});

describe('certificate status rules', () => {
  it('draft signs, signed revokes, only signed is valid', () => {
    expect(canSign('draft')).toBe(true);
    expect(canSign('signed')).toBe(false);
    expect(canRevoke('signed')).toBe(true);
    expect(canRevoke('draft')).toBe(false);
    expect(canReissue('signed')).toBe(true);
    expect(canReissue('revoked')).toBe(false);
    expect(isValid('signed')).toBe(true);
    expect(isValid('draft')).toBe(false);
    expect(isValid('revoked')).toBe(false);
  });

  it('lists the three lifecycle states', () => {
    expect([...CERTIFICATE_STATUSES]).toEqual(['draft', 'signed', 'revoked']);
  });
});

describe('reference + verification code helpers', () => {
  it('builds a stable, prefixed reference', () => {
    const ref = makeCertificateReference('018f5b3a-0000-7000-8000-0000000abcde', 2026);
    expect(ref).toMatch(/^CERT-2026-[0-9A-F]{8}$/);
  });

  it('validates verification code shape', () => {
    expect(isWellFormedVerificationCode('a'.repeat(32))).toBe(true);
    expect(isWellFormedVerificationCode('short')).toBe(false);
    expect(isWellFormedVerificationCode('has space '.repeat(3))).toBe(false);
  });
});

describe('certificate schemas', () => {
  it('generate requires a uuid decision id', () => {
    expect(generateCertificateSchema.safeParse({ decisionId: 'nope' }).success).toBe(
      false,
    );
    expect(
      generateCertificateSchema.safeParse({
        decisionId: '018f5b3a-0000-7000-8000-000000000000',
      }).success,
    ).toBe(true);
  });

  it('revoke requires a non-empty reason', () => {
    expect(revokeCertificateSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(
      revokeCertificateSchema.safeParse({ reason: 'Issued in error.' }).success,
    ).toBe(true);
  });
});
