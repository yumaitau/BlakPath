import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildClientKeyPolicy,
  CLIENT_KEY_CRYPTO_ACTIONS,
  CLIENT_KEY_DESCRIBE_ACTION,
} from '@/lib/encryption/client-key-policy';

const ORG = '018f0000-0000-7000-8000-000000000002';
const ACCOUNT = '111122223333';
const ROLE = 'arn:aws:iam::111122223333:role/blakpath-worker';

describe('client key policy', () => {
  it('limits the workload role and keeps DescribeKey off the encryption context', () => {
    const policy = buildClientKeyPolicy({
      organisationId: ORG,
      workloadRoleArns: [ROLE],
      blakPathAccountId: ACCOUNT,
      adminRootArn: `arn:aws:iam::${ACCOUNT}:root`,
    });
    const crypto = policy.Statement.find(
      (statement) => statement.Sid === 'BlakPathEnvelope',
    );
    const describe = policy.Statement.find(
      (statement) => statement.Sid === 'BlakPathDescribe',
    );
    expect(crypto?.Action).toEqual([...CLIENT_KEY_CRYPTO_ACTIONS]);
    expect(crypto?.Condition?.StringEquals['kms:EncryptionContext:org_id']).toBe(ORG);
    expect(crypto?.Condition?.StringEquals['aws:SourceAccount']).toBe(ACCOUNT);
    expect(crypto?.Condition?.StringEquals).not.toHaveProperty('kms:ViaService');
    expect(describe?.Action).toBe(CLIENT_KEY_DESCRIBE_ACTION);
    expect(describe?.Condition?.StringEquals).not.toHaveProperty(
      'kms:EncryptionContext:org_id',
    );
    const granted = policy.Statement.filter((statement) =>
      statement.Sid.startsWith('BlakPath'),
    ).flatMap((statement) =>
      typeof statement.Action === 'string' ? [statement.Action] : [...statement.Action],
    );
    expect(granted).not.toContain('kms:*');
    expect(granted).not.toContain('kms:PutKeyPolicy');
    expect(granted).not.toContain('kms:ScheduleKeyDeletion');
  });
});

describe('key templates', () => {
  const required = [
    'kms:GenerateDataKey',
    'kms:Decrypt',
    'kms:Encrypt',
    'kms:DescribeKey',
    'kms:EncryptionContext:org_id',
    'aws:SourceAccount',
  ];

  it('ships the same conditions in CloudFormation and Terraform', () => {
    const files = [
      'infra/client-kms/cloudformation.yaml',
      'infra/client-kms/main.tf',
      'infra/aws/tenant-cmk/cloudformation.yaml',
      'infra/aws/tenant-cmk/main.tf',
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const token of required) expect(text, file).toContain(token);
    }
    expect(readFileSync('infra/client-kms/cloudformation.yaml', 'utf8')).toContain(
      'EnableKeyRotation: true',
    );
    expect(readFileSync('infra/client-kms/main.tf', 'utf8')).toContain(
      'enable_key_rotation',
    );
    expect(readFileSync('infra/aws/workload-roles.example.yaml', 'utf8')).toContain(
      'key_validation',
    );
    expect(readFileSync('infra/aws/workload-roles.example.yaml', 'utf8')).toContain(
      'kms:DescribeKey',
    );
  });
});
