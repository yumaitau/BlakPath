import { describe, expect, it } from 'vitest';
import {
  cloudTrailLinks,
  escrowView,
  toHistoryEntries,
} from '@/domains/organisation-keys/presentation';
import type { OrganisationKeyRow } from '@/domains/organisation-keys/service';

const orgId = '018f0000-0000-7000-8000-00000000000a';
const clientArn =
  'arn:aws:kms:ap-southeast-2:222222222222:key/abcdefab-1234-4678-9abc-def012345678';

const row: OrganisationKeyRow = {
  id: '018f0000-0000-7000-8000-000000000001',
  organisationId: orgId,
  custodyMode: 'client_owned',
  kmsKeyArn: clientArn,
  keyVersion: 1,
  status: 'active',
  escrow: false,
  rotatedAt: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
};

describe('escrowView', () => {
  it('reports no escrow and no custodians for a plain client-owned key', () => {
    expect(escrowView(row)).toEqual({ enrolled: false, custodianNames: null });
  });

  it('treats the escrow custody mode as enrolled even before custodians exist', () => {
    expect(escrowView({ ...row, custodyMode: 'client_owned_escrow' })).toEqual({
      enrolled: true,
      custodianNames: null,
    });
  });

  it('shows custodian names only, dropping every other custodian field', () => {
    const withCustodians = {
      ...row,
      escrow: true,
      escrowCustodians: [
        { name: 'Aunty May', email: 'may@example.test', share: 'secret-share' },
        'Uncle Bob',
        { email: 'no-name@example.test' },
        '  ',
      ],
    };
    expect(escrowView(withCustodians)).toEqual({
      enrolled: true,
      custodianNames: ['Aunty May', 'Uncle Bob'],
    });
  });
});

describe('cloudTrailLinks', () => {
  it('points a client-held key at the key owner account and region', () => {
    const links = cloudTrailLinks(clientArn, orgId, 'client_owned');
    expect(links).toMatchObject({
      region: 'ap-southeast-2',
      accountId: '222222222222',
      clientCanQuery: true,
    });
    expect(links.consoleUrl).toBe(
      'https://ap-southeast-2.console.aws.amazon.com/cloudtrailv2/home?region=ap-southeast-2' +
        `#/events?ResourceName=${encodeURIComponent(clientArn)}`,
    );
    expect(links.cliCommand).toContain(
      'aws cloudtrail lookup-events --region ap-southeast-2',
    );
    expect(links.cliCommand).toContain(
      `AttributeKey=ResourceName,AttributeValue=${clientArn}`,
    );
    expect(links.cliCommand).toContain(`.org_id == "${orgId}"`);
  });

  it('marks a BlakPath-managed key as not queryable by the client', () => {
    expect(cloudTrailLinks(clientArn, orgId, 'blakpath_managed').clientCanQuery).toBe(
      false,
    );
  });

  it('rejects a value that is not a KMS key ARN', () => {
    expect(() => cloudTrailLinks('alias/blakpath', orgId, 'client_owned')).toThrow(/ARN/);
  });
});

describe('toHistoryEntries', () => {
  it('summarises platform key events without exposing more than metadata', () => {
    const entries = toHistoryEntries([
      {
        id: 'e3',
        action: 'key.health_checked',
        timestamp: new Date('2026-10-03T00:00:00Z'),
        result: 'success',
        reason: null,
        actorName: 'Admin Person',
        afterMeta: { keyVersion: 1, kmsKeyArn: clientArn },
      },
      {
        id: 'e2',
        action: 'key.status_changed',
        timestamp: new Date('2026-10-02T00:00:00Z'),
        result: 'success',
        reason: null,
        actorName: null,
        afterMeta: { keyVersion: 1, status: 'pending_deletion' },
      },
      {
        id: 'e1',
        action: 'key.unavailable',
        timestamp: new Date('2026-10-01T00:00:00Z'),
        result: 'failure',
        reason: 'DisabledException',
        actorName: null,
        afterMeta: null,
      },
    ]);
    expect(entries.map((e) => e.summary)).toEqual([
      'Health check passed',
      'Status changed to pending deletion',
      'KMS refused the key',
    ]);
    expect(entries[0]).toMatchObject({ actor: 'Admin Person', keyVersion: 1 });
    expect(entries[1]).toMatchObject({ actor: 'BlakPath system' });
    expect(entries[2]).toMatchObject({ detail: 'DisabledException', keyVersion: null });
  });
});
