import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

const template = read('infra/aws/backup-plan.example.yaml');
const privacy = read('docs/privacy-architecture.md');
const offboarding = read('docs/offboarding.md');
const runbook = read('docs/operations-runbook.md');

function section(source: string, heading: string, next: string): string {
  const start = source.indexOf(heading);
  const end = source.indexOf(next, start + heading.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('BlakPath backup plan contract', () => {
  it('locks the vault in compliance mode for 35 to 90 days', () => {
    const lock = section(template, 'LockConfiguration:', 'AccessPolicy:');
    expect(lock).toContain('ChangeableForDays: 7');
    expect(lock).toContain('MinRetentionDays: 35');
    expect(lock).toContain('MaxRetentionDays: 90');
    expect(template).toContain('EncryptionKeyArn: !Ref BackupVaultKmsKeyArn');
    expect(template).toContain('DeletionPolicy: Retain');
    expect(template).toContain("Assert: !Equals [!Ref 'AWS::Region', 'ap-southeast-2']");
    expect(template).not.toContain('CopyActions');
    expect(template).not.toContain('MoveToColdStorageAfterDays');
    expect(template).toContain('backup:CopyFromBackupVault');
  });

  it('covers RDS continuously and snapshots RDS and both buckets daily', () => {
    const continuous = section(
      template,
      '- RuleName: continuous-pitr',
      '- RuleName: daily-snapshot',
    );
    const daily = section(template, '- RuleName: daily-snapshot', 'BackupSelection:');
    const selection = section(
      template,
      'SelectionName: blakpath-rds-and-buckets',
      'BackupJobFailedAlarm:',
    );

    expect(continuous).toContain('EnableContinuousBackup: true');
    expect(continuous).toContain('DeleteAfterDays: 35');
    expect(daily).not.toContain('EnableContinuousBackup');
    expect(daily).toContain('DeleteAfterDays: 90');
    expect(template.match(/EnableContinuousBackup: true/g)).toHaveLength(1);
    expect(selection).toContain('!Ref RdsInstanceArn');
    expect(selection).toContain('!Ref EvidenceBucketArn');
    expect(selection).toContain('!Ref QuarantineBucketArn');
    expect(template).toContain('ScheduleExpressionTimezone: Australia/Sydney');
    expect(template).toContain('AWSBackupServiceRolePolicyForS3Backup');
    expect(template).toContain('AWSBackupServiceRolePolicyForBackup');
  });

  it('pages on-call when a backup job fails, aborts or expires', () => {
    const alarm = section(template, 'BackupJobFailedAlarm:', 'Outputs:');
    expect(alarm).toContain('AlarmName: blakpath-backup-job-failed');
    expect(alarm).toContain('NumberOfBackupJobsFailed');
    expect(alarm).toContain('NumberOfBackupJobsAborted');
    expect(alarm).toContain('NumberOfBackupJobsExpired');
    expect(alarm).toContain('Expression: failed + aborted + expired');
    expect(alarm).toContain('AlarmActions: [!Ref OnCallTopicArn]');
    expect(alarm).toContain('TreatMissingData: notBreaching');
    expect(alarm).toContain('Name: BackupVaultName');
  });

  it('documents the same residual period for privacy and offboarding', () => {
    for (const doc of [privacy, offboarding]) {
      expect(doc).toContain('35 days');
      expect(doc).toContain('90 days');
      expect(doc).toContain('compliance mode');
      expect(doc).toContain('quarantine');
      expect(doc).toMatch(/7-day|7 days/);
      expect(doc).toMatch(
        /cannot be deleted sooner|can be deleted sooner|erasure request cannot be accelerated/,
      );
    }
    expect(offboarding).toContain('Redis is not backed up');
    expect(runbook).toContain('blakpath-backup-job-failed');
    expect(runbook).toContain('set-alarm-state');
    expect(runbook).toContain('list-protected-resources');
  });
});
