import { describe, expect, it } from 'vitest';
import {
  CONSENT_PURPOSES,
  channelForMethod,
  consentState,
  nextWordingVersion,
  withdrawalEffects,
} from '@/domains/consent/rules';
import {
  consentSubjectSchema,
  publishWordingSchema,
  recordConsentSchema,
  withdrawConsentSchema,
} from '@/domains/consent/schemas';

const CLIENT = '0190f0a0-0000-7000-8000-000000000001';
const USER = '0190f0a0-0000-7000-8000-000000000002';
const WORDING = '0190f0a0-0000-7000-8000-000000000003';

describe('consent state is derived from the append-only ledger', () => {
  const now = new Date('2026-10-14T00:00:00Z');

  it('a withdrawal always wins', () => {
    expect(consentState({ expiresAt: null }, true, now)).toBe('withdrawn');
    expect(consentState({ expiresAt: new Date('2020-01-01') }, true, now)).toBe(
      'withdrawn',
    );
  });

  it('an unwithdrawn grant is live until it expires', () => {
    expect(consentState({ expiresAt: null }, false, now)).toBe('live');
    expect(consentState({ expiresAt: new Date('2027-01-01') }, false, now)).toBe('live');
    expect(consentState({ expiresAt: now }, false, now)).toBe('expired');
  });
});

describe('consent channels and effects', () => {
  it('only online acknowledgement is self-service', () => {
    expect(channelForMethod('online-acknowledgement')).toBe('self-service');
    expect(channelForMethod('signed-form')).toBe('staff');
    expect(channelForMethod('verbal-witnessed')).toBe('staff');
    expect(channelForMethod('written-request')).toBe('staff');
  });

  it('withdrawing representative access revokes representative authorisations', () => {
    expect(withdrawalEffects('representative-access')).toEqual([
      'revoke-representative-access',
    ]);
    expect(withdrawalEffects('evidence-handling')).toEqual([]);
  });

  it('includes inter-organisation sharing as a granular purpose', () => {
    expect(CONSENT_PURPOSES).toContain('inter-organisation-sharing');
  });

  it('numbers wording versions from 1', () => {
    expect(nextWordingVersion(null)).toBe(1);
    expect(nextWordingVersion(undefined)).toBe(1);
    expect(nextWordingVersion(3)).toBe(4);
  });
});

describe('recordConsentSchema', () => {
  const base = {
    subjectClientId: CLIENT,
    purpose: 'evidence-handling',
    wordingVersionId: WORDING,
    method: 'signed-form',
    evidenceReference: 'Intake form 2026-117, page 2',
  } as const;

  it('accepts a person identified only by a client record (no account)', () => {
    const parsed = recordConsentSchema.parse(base);
    expect(parsed.subjectUserId).toBeUndefined();
    expect(parsed.givenBy).toBe('subject');
  });

  it('requires an account or a client record', () => {
    const { subjectClientId: _omit, ...rest } = base;
    expect(recordConsentSchema.safeParse(rest).success).toBe(false);
    expect(recordConsentSchema.safeParse({ ...rest, subjectUserId: USER }).success).toBe(
      true,
    );
  });

  it('requires a wording version on every grant', () => {
    const { wordingVersionId: _omit, ...rest } = base;
    expect(recordConsentSchema.safeParse(rest).success).toBe(false);
  });

  it('requires evidence for signed forms and a witness for verbal consent', () => {
    expect(
      recordConsentSchema.safeParse({ ...base, evidenceReference: undefined }).success,
    ).toBe(false);
    expect(
      recordConsentSchema.safeParse({
        ...base,
        method: 'verbal-witnessed',
        evidenceReference: undefined,
      }).success,
    ).toBe(false);
    expect(
      recordConsentSchema.safeParse({
        ...base,
        method: 'verbal-witnessed',
        evidenceReference: undefined,
        witnessName: 'Aunty May (intake officer present)',
      }).success,
    ).toBe(true);
  });

  it('requires the name and relationship of a representative or guardian', () => {
    expect(recordConsentSchema.safeParse({ ...base, givenBy: 'guardian' }).success).toBe(
      false,
    );
    expect(
      recordConsentSchema.safeParse({
        ...base,
        givenBy: 'guardian',
        representativeName: 'Jane Citizen',
        representativeRelationship: 'mother',
      }).success,
    ).toBe(true);
  });

  it('requires a recipient for inter-organisation sharing', () => {
    const sharing = { ...base, purpose: 'inter-organisation-sharing' } as const;
    expect(recordConsentSchema.safeParse(sharing).success).toBe(false);
    expect(
      recordConsentSchema.safeParse({
        ...sharing,
        sharingRecipient: 'Example Land Council',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown purposes and past expiry', () => {
    expect(recordConsentSchema.safeParse({ ...base, purpose: 'anything' }).success).toBe(
      false,
    );
    expect(
      recordConsentSchema.safeParse({ ...base, expiresAt: '2000-01-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });
});

describe('withdrawConsentSchema', () => {
  it('online withdrawal needs no evidence; staff-recorded withdrawal does', () => {
    expect(
      withdrawConsentSchema.safeParse({ method: 'online-acknowledgement' }).success,
    ).toBe(true);
    expect(withdrawConsentSchema.safeParse({ method: 'written-request' }).success).toBe(
      false,
    );
    expect(
      withdrawConsentSchema.safeParse({
        method: 'written-request',
        evidenceReference: 'Email received 2026-10-14',
      }).success,
    ).toBe(true);
  });
});

describe('wording and subject schemas', () => {
  it('defaults the wording locale and requires a body', () => {
    expect(
      publishWordingSchema.parse({
        purpose: 'communications',
        title: 'Contacting you',
        body: 'We will contact you about your application.',
      }).locale,
    ).toBe('en-AU');
    expect(
      publishWordingSchema.safeParse({ purpose: 'communications', title: 'x', body: '' })
        .success,
    ).toBe(false);
  });

  it('a subject lookup needs an account or client id', () => {
    expect(consentSubjectSchema.safeParse({}).success).toBe(false);
    expect(consentSubjectSchema.safeParse({ subjectClientId: CLIENT }).success).toBe(
      true,
    );
  });
});
