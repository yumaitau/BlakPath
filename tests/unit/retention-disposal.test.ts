import { describe, expect, it } from 'vitest';
import { toCsv } from '@/domains/reporting/csv';
import {
  activationBlockReason,
  disposalAuthorityVerified,
  sweepBlockReason,
  type AuthoritySignoffGate,
  type SweepPolicyGate,
} from '@/domains/retention/approval';
import {
  DISPOSAL_CLASS_BY_RESOURCE,
  DISPOSAL_CLASS_INFO,
  disposalCatalogue,
} from '@/domains/retention/disposal';
import {
  DESTRUCTION_REGISTER_COLUMNS,
  destructionRegisterRows,
} from '@/domains/retention/register';
import { RETENTION_RESOURCE_TYPES } from '@/domains/retention/rules';
import { signDisposalAuthoritySchema } from '@/domains/retention/schemas';

const approvedPurge: SweepPolicyGate = {
  active: true,
  action: 'purge',
  retentionDays: 3650,
  createdByUserId: 'user-a',
  approvedByUserId: 'user-b',
  disposalAuthorityRef: 'GA39 16.1.1',
  disposalClass: 'application_matter',
  jurisdiction: 'nsw',
};

const matchingSignoff: AuthoritySignoffGate = {
  authorityReference: 'GA39 16.1.1',
  permanent: false,
  disposalClass: 'application_matter',
  jurisdiction: 'nsw',
  minimumRetentionDays: 365,
};

describe('disposal catalogue', () => {
  it('maps every resource type to exactly one disposal class', () => {
    const catalogue = disposalCatalogue();
    const seen = new Map<string, string>();
    for (const disposalClass of catalogue.classes) {
      for (const resourceType of disposalClass.resourceTypes) {
        expect(seen.has(resourceType)).toBe(false);
        seen.set(resourceType, disposalClass.key);
      }
    }
    expect([...seen.keys()].sort()).toEqual(
      Object.keys(DISPOSAL_CLASS_BY_RESOURCE).sort(),
    );
    expect(seen.get('audit_chain')).toBe('immutable_audit');
    expect(seen.get('decision')).toBe('official_outcome');
    expect(seen.get('certificate')).toBe('official_outcome');
    expect(seen.get('evidence')).toBe('supporting_evidence');
    expect(seen.get('application')).toBe('application_matter');
    expect(seen.get('destruction_register')).toBe('retention_control');
    expect(DISPOSAL_CLASS_INFO.immutable_audit.destructionForbidden).toBe(true);
    expect(DISPOSAL_CLASS_INFO.retention_control.destructionForbidden).toBe(true);
  });

  it('does not offer the audit trail or the destruction register as policy targets', () => {
    expect(RETENTION_RESOURCE_TYPES).not.toContain('audit_chain');
    expect(RETENTION_RESOURCE_TYPES).not.toContain('destruction_register');
    expect(RETENTION_RESOURCE_TYPES).toContain('application');
    expect(RETENTION_RESOURCE_TYPES).toContain('evidence');
    expect(RETENTION_RESOURCE_TYPES).toContain('form_response');
    expect(RETENTION_RESOURCE_TYPES).toContain('decision');
    expect(RETENTION_RESOURCE_TYPES).toContain('certificate');
  });
});

describe('policy activation', () => {
  it('rejects activation by the drafter alone', () => {
    expect(
      activationBlockReason({
        creatorUserId: 'user-a',
        approverUserId: 'user-a',
        alreadyActive: false,
      }),
    ).toBe('same_actor');
    expect(
      activationBlockReason({
        creatorUserId: null,
        approverUserId: 'user-b',
        alreadyActive: false,
      }),
    ).toBe('same_actor');
  });

  it('allows a different person to activate a draft', () => {
    expect(
      activationBlockReason({
        creatorUserId: 'user-a',
        approverUserId: 'user-b',
        alreadyActive: false,
      }),
    ).toBe(null);
  });
});

describe('purge gate', () => {
  it('refuses a purge with no authority reference', () => {
    expect(
      sweepBlockReason(
        { ...approvedPurge, disposalAuthorityRef: null },
        matchingSignoff,
        false,
      ),
    ).toBe('missing_authority');
    expect(
      sweepBlockReason(
        { ...approvedPurge, disposalAuthorityRef: '   ' },
        matchingSignoff,
        false,
      ),
    ).toBe('missing_authority');
  });

  it('refuses a purge the drafter approved themselves', () => {
    expect(
      sweepBlockReason(
        { ...approvedPurge, approvedByUserId: 'user-a' },
        matchingSignoff,
        false,
      ),
    ).toBe('same_actor');
  });

  it('refuses a purge that is not matched to a current sign-off', () => {
    expect(sweepBlockReason(approvedPurge, null, false)).toBe('no_signoff');
    expect(
      sweepBlockReason(
        approvedPurge,
        { ...matchingSignoff, authorityReference: 'other instrument' },
        false,
      ),
    ).toBe('authority_mismatch');
  });

  it('refuses to destroy a class the sign-off keeps permanently', () => {
    expect(
      sweepBlockReason(approvedPurge, { ...matchingSignoff, permanent: true }, false),
    ).toBe('class_permanent');
  });

  it('never destroys a forbidden class', () => {
    expect(sweepBlockReason(approvedPurge, matchingSignoff, true)).toBe(
      'class_forbidden',
    );
  });

  it('allows a purge when a different approver and a matching sign-off agree', () => {
    expect(sweepBlockReason(approvedPurge, matchingSignoff, false)).toBe(null);
  });

  it('never actions permanent retention', () => {
    expect(
      sweepBlockReason(
        {
          ...approvedPurge,
          action: 'retain',
          retentionDays: null,
          disposalAuthorityRef: null,
        },
        null,
        false,
      ),
    ).toBe('permanent');
  });
});

describe('official-record authority', () => {
  it('needs two-person approval and a matching sign-off, not a bare reference', () => {
    expect(disposalAuthorityVerified(approvedPurge, matchingSignoff, false)).toBe(true);
    // Any non-empty reference used to unlock official records. It must not.
    expect(disposalAuthorityVerified(approvedPurge, null, false)).toBe(false);
    expect(
      disposalAuthorityVerified(
        approvedPurge,
        { ...matchingSignoff, authorityReference: 'other instrument' },
        false,
      ),
    ).toBe(false);
    expect(
      disposalAuthorityVerified(
        { ...approvedPurge, approvedByUserId: 'user-a' },
        matchingSignoff,
        false,
      ),
    ).toBe(false);
    expect(
      disposalAuthorityVerified(
        { ...approvedPurge, approvedByUserId: null },
        matchingSignoff,
        false,
      ),
    ).toBe(false);
    expect(
      disposalAuthorityVerified(
        approvedPurge,
        { ...matchingSignoff, permanent: true },
        false,
      ),
    ).toBe(false);
    // An anonymise policy only unlocks official records with the same proof.
    expect(
      disposalAuthorityVerified(
        { ...approvedPurge, action: 'anonymise' },
        matchingSignoff,
        false,
      ),
    ).toBe(true);
    expect(
      disposalAuthorityVerified(
        { ...approvedPurge, action: 'anonymise', disposalAuthorityRef: null },
        matchingSignoff,
        false,
      ),
    ).toBe(false);
  });
});

describe('authority sign-off input', () => {
  it('rejects a destroyable sign-off for a class that cannot be destroyed', () => {
    expect(
      signDisposalAuthoritySchema.safeParse({
        jurisdiction: 'nsw',
        disposalClass: 'immutable_audit',
        authorityReference: 'keep the trail',
        permanent: false,
      }).success,
    ).toBe(false);
    expect(
      signDisposalAuthoritySchema.safeParse({
        jurisdiction: 'organisation',
        disposalClass: 'official_outcome',
        authorityReference: 'Board resolution 2026-04',
        permanent: true,
      }).success,
    ).toBe(true);
  });
});

describe('destruction register export', () => {
  it('serialises a register row with the authority reference', () => {
    const csv = toCsv(
      DESTRUCTION_REGISTER_COLUMNS,
      destructionRegisterRows([
        {
          destroyedAt: new Date(Date.UTC(2026, 9, 13, 1, 2, 3)),
          resourceType: 'application',
          resourceId: '018f5b3a-0000-7000-8000-000000000001',
          disposalClass: 'application_matter',
          jurisdiction: 'nsw',
          authorityReference: 'GA39 16.1.1',
          policyId: '018f5b3a-0000-7000-8000-000000000002',
          correlationId: 'corr-1',
        },
      ]),
    );
    expect(csv.split('\r\n')[0]).toBe(DESTRUCTION_REGISTER_COLUMNS.join(','));
    expect(csv).toContain('GA39 16.1.1');
    expect(csv).toContain('application_matter');
    expect(csv).toContain('2026-10-13T01:02:03.000Z');
  });
});
