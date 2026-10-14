import { describe, expect, it } from 'vitest';
import {
  canonicalCoaPayload,
  canonicalCoaPayloadV2,
  canonicalPayloadForVersion,
} from '@/domains/certificates';
import {
  createHolderBinding,
  dateOfBirthFromIntake,
  holderDetailsMatch,
  normalizeHolderDob,
  normalizeHolderName,
} from '@/domains/certificates/holder-binding';

const V1 = {
  v: 1 as const,
  certificateId: 'cert-1',
  organisationId: 'org-1',
  reference: 'CERT-2026-000001',
  applicationId: 'app-1',
  decisionId: 'dec-1',
  outcome: 'confirmed',
  verificationCode: 'ABCD1234',
  signedAt: '2026-09-11T00:00:00.000Z',
};

describe('holder binding', () => {
  it('keeps version 1 canonical bytes stable', () => {
    expect(canonicalCoaPayload(V1)).toBe(
      '{"v":1,"certificateId":"cert-1","organisationId":"org-1","reference":"CERT-2026-000001","applicationId":"app-1","decisionId":"dec-1","outcome":"confirmed","verificationCode":"ABCD1234","signedAt":"2026-09-11T00:00:00.000Z"}',
    );
    expect(
      canonicalPayloadForVersion({
        ...V1,
        payloadVersion: '1',
        holderNameHash: 'x',
        holderDobHash: null,
        pdfSha256: 'y',
      }),
    ).toBe(canonicalCoaPayload(V1));
  });

  it('seals the holder hash and PDF hash in version 2', () => {
    const canonical = canonicalCoaPayloadV2({
      ...V1,
      v: 2,
      holderNameHash: 'abc',
      holderDobHash: null,
      pdfSha256: 'def',
    });
    expect(canonical).toBe(
      '{"v":2,"certificateId":"cert-1","organisationId":"org-1","reference":"CERT-2026-000001","applicationId":"app-1","decisionId":"dec-1","outcome":"confirmed","verificationCode":"ABCD1234","signedAt":"2026-09-11T00:00:00.000Z","holderNameHash":"abc","holderDobHash":null,"pdfSha256":"def"}',
    );
    expect(
      canonicalPayloadForVersion({
        ...V1,
        payloadVersion: '2',
        holderNameHash: null,
        holderDobHash: null,
        pdfSha256: 'def',
      }),
    ).toBeNull();
  });

  it('matches the printed name and rejects a different one', () => {
    const binding = createHolderBinding({
      name: '  Jane   SMITH ',
      dateOfBirth: '2/3/1990',
    });
    expect(normalizeHolderName('Jane Smith')).toBe('jane smith');
    expect(normalizeHolderDob('02/03/1990')).toBe('1990-03-02');
    expect(
      holderDetailsMatch({
        ...binding,
        name: 'jane smith',
        dateOfBirth: null,
      }),
    ).toBe(true);
    expect(
      holderDetailsMatch({
        ...binding,
        name: 'Jane Smith',
        dateOfBirth: '1990-03-02',
      }),
    ).toBe(true);
    expect(
      holderDetailsMatch({
        ...binding,
        name: 'Someone Else',
        dateOfBirth: '1990-03-02',
      }),
    ).toBe(false);
    expect(
      holderDetailsMatch({
        ...binding,
        name: 'Jane Smith',
        dateOfBirth: '1991-03-02',
      }),
    ).toBe(false);
  });

  it('ignores a typed date of birth when none was sealed', () => {
    const binding = createHolderBinding({ name: 'Alex Ray', dateOfBirth: null });
    expect(binding.dobHash).toBeNull();
    expect(
      holderDetailsMatch({
        ...binding,
        name: 'Alex Ray',
        dateOfBirth: '1990-01-01',
      }),
    ).toBe(true);
    expect(dateOfBirthFromIntake({ dateOfBirth: '1990-01-01', notes: 'no' })).toBe(
      '1990-01-01',
    );
    expect(dateOfBirthFromIntake({ date_of_birth: '31/02/1990' })).toBeNull();
    expect(dateOfBirthFromIntake(null)).toBeNull();
  });
});
