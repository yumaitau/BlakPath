import { describe, expect, it } from 'vitest';
import type { ProcessScanInput } from '@/domains/evidence';
import {
  assertCanCompleteEvidenceUpload,
  decideEvidenceUpload,
} from '@/domains/evidence/upload-auth';
import { AuthorizationError } from '@/lib/permissions/errors';
import type { Subject } from '@/lib/permissions/check';

function subjectWith(...keys: string[]): Subject {
  return { userId: 'user-1', permissions: new Set(keys) };
}

const receipt = { receiptChannel: 'email', receivedOn: '2020-06-01' };

describe('decideEvidenceUpload', () => {
  it('lets an applicant upload their own file without a receipt', () => {
    expect(decideEvidenceUpload(subjectWith('evidence:upload-own'), true, {})).toEqual({
      mode: 'own',
    });
  });

  it('lets staff who can read the case record a received file', () => {
    const decision = decideEvidenceUpload(
      subjectWith('evidence:upload-on-behalf', 'application:read-any'),
      false,
      receipt,
    );
    expect(decision).toEqual({ mode: 'on-behalf', ...receipt });
  });

  it('asks staff for a channel and date instead of denying the permission', () => {
    expect(
      decideEvidenceUpload(subjectWith('evidence:upload-on-behalf'), false, {}),
    ).toEqual({ mode: 'receipt-required' });
  });

  it('refuses an applicant who invents a receipt channel', () => {
    expect(() =>
      decideEvidenceUpload(subjectWith('evidence:upload-own'), true, receipt),
    ).toThrow(AuthorizationError);
  });

  it('refuses upload-own when the actor is not the applicant', () => {
    expect(() =>
      decideEvidenceUpload(subjectWith('evidence:upload-own'), false, {}),
    ).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('refuses an organisation admin who holds no evidence permission', () => {
    expect(() =>
      decideEvidenceUpload(
        subjectWith('membership:manage', 'tenant:configure', 'audit:view'),
        false,
        receipt,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  });

  it('keeps an applicant upload on the own path when the actor also holds on-behalf', () => {
    expect(
      decideEvidenceUpload(
        subjectWith('evidence:upload-own', 'evidence:upload-on-behalf'),
        true,
        {},
      ),
    ).toEqual({ mode: 'own' });
  });
});

describe('assertCanCompleteEvidenceUpload', () => {
  const onBehalfRow = { uploadedByUserId: 'user-1', receiptChannel: 'post' };
  const ownRow = { uploadedByUserId: 'user-1', receiptChannel: null };

  it('lets the receiving officer complete their own on-behalf upload', () => {
    expect(() =>
      assertCanCompleteEvidenceUpload(
        subjectWith('evidence:upload-on-behalf'),
        'user-1',
        onBehalfRow,
      ),
    ).not.toThrow();
  });

  it('lets the applicant complete their own upload', () => {
    expect(() =>
      assertCanCompleteEvidenceUpload(
        subjectWith('evidence:upload-own'),
        'user-1',
        ownRow,
      ),
    ).not.toThrow();
  });

  it('refuses completing someone else’s upload', () => {
    expect(() =>
      assertCanCompleteEvidenceUpload(
        subjectWith('evidence:upload-on-behalf'),
        'user-2',
        onBehalfRow,
      ),
    ).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('does not let an applicant permission finish a staff receipt', () => {
    expect(() =>
      assertCanCompleteEvidenceUpload(
        subjectWith('evidence:upload-own'),
        'user-1',
        onBehalfRow,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  });

  it('does not let on-behalf permission finish an applicant upload', () => {
    expect(() =>
      assertCanCompleteEvidenceUpload(
        subjectWith('evidence:upload-on-behalf'),
        'user-1',
        ownRow,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  });
});

describe('scan input', () => {
  it('does not take receipt fields — quarantine scanning is the same for every upload', () => {
    const input: ProcessScanInput = {
      organisationId: 'org',
      evidenceId: 'evidence',
      correlationId: 'correlation',
    };
    expect(Object.keys(input).sort()).toEqual([
      'correlationId',
      'evidenceId',
      'organisationId',
    ]);
  });
});
