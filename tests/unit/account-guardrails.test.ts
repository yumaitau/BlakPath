import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('account guardrails template', () => {
  const template = read('infra/aws/account-guardrails.example.yaml');

  it('subscribes Security Hub to FSBP and CIS without a default bundle', () => {
    expect(template).toContain('Type: AWS::SecurityHub::Hub');
    expect(template).toContain('EnableDefaultStandards: false');
    expect(template).toContain('ControlFindingGenerator: SECURITY_CONTROL');
    expect(template).toContain(
      'standards/aws-foundational-security-best-practices/v/1.0.0',
    );
    expect(template).toContain('standards/cis-aws-foundations-benchmark/v/5.0.0');
  });

  it('records every supported Config resource in ap-southeast-2', () => {
    expect(template).toContain("!Equals [!Ref 'AWS::Region', 'ap-southeast-2']");
    expect(template).toContain('Type: AWS::Config::ConfigurationRecorder');
    expect(template).toContain('AllSupported: true');
    expect(template).toContain('IncludeGlobalResourceTypes: true');
    expect(template).toContain('RecordingFrequency: CONTINUOUS');
    expect(template).toContain('Type: AWS::Config::DeliveryChannel');
  });

  it('encrypts CloudTrail, delivers it to CloudWatch, and selects BlakPath buckets', () => {
    expect(template).toContain('Type: AWS::CloudTrail::Trail');
    expect(template).toContain('KMSKeyId: !GetAtt SecurityLogsKey.Arn');
    expect(template).toContain('CloudWatchLogsLogGroupArn: !GetAtt TrailLogGroup.Arn');
    expect(template).toContain('CloudWatchLogsRoleArn: !GetAtt CloudTrailLogsRole.Arn');
    expect(template).toContain('EnableLogFileValidation: true');
    expect(template).toContain('IsMultiRegionTrail: true');
    expect(template).toContain('AWS::S3::Object');
    expect(template).toContain('arn:${AWS::Partition}:s3:::${EvidenceBucketName}/');
    expect(template).toContain('arn:${AWS::Partition}:s3:::${QuarantineBucketName}/');
    expect(template).toContain('alias/blakpath-security-logs');
  });

  it('enables external and unused-access analyzers plus GuardDuty S3 and RDS', () => {
    expect(template).toContain('Type: ACCOUNT');
    expect(template).toContain('Type: ACCOUNT_UNUSED_ACCESS');
    expect(template).toContain('UnusedAccessAge: 90');
    expect(template).toContain('S3_DATA_EVENTS');
    expect(template).toContain('RDS_LOGIN_EVENTS');
  });

  it('keeps S3 malware protection off and outside the promotion gate', () => {
    expect(template).toContain("Default: 'false'");
    expect(template).toContain('Type: AWS::GuardDuty::MalwareProtectionPlan');
    expect(template).toContain('S3MalwareProtectionEnabled');
    expect(template).toContain('must not promote or reject evidence');
    expect(template).toContain('ClamAV remains the only evidence');
    expect(template).not.toContain('auto-approve');
    expect(template).not.toContain('auto-reject');
  });
});

describe('EKS guardrails', () => {
  it('creates the secrets CMK and log group without a second cluster', () => {
    const template = read('infra/aws/eks-guardrails.example.yaml');

    expect(template).toContain('alias/blakpath-eks-secrets');
    expect(template).toContain('/aws/eks/${ClusterName}/cluster');
    expect(template).toContain('RetentionInDays: 365');
    expect(template).toContain("!Equals [!Ref 'AWS::Region', 'ap-southeast-2']");
    expect(template).not.toContain('Type: AWS::EKS::Cluster');
  });

  it('requires control-plane logs, deletion protection and a secrets CMK', () => {
    const guardrails = JSON.parse(read('infra/aws/eks-cluster-guardrails.json')) as {
      region: string;
      deletionProtection: boolean;
      logging: { clusterLogging: { enabled: boolean; types: string[] }[] };
      encryptionConfig: { resources: string[]; provider: { keyArn: string } }[];
    };

    expect(guardrails.region).toBe('ap-southeast-2');
    expect(guardrails.deletionProtection).toBe(true);
    expect(guardrails.logging.clusterLogging).toEqual([
      {
        enabled: true,
        types: ['api', 'audit', 'authenticator', 'controllerManager', 'scheduler'],
      },
    ]);
    expect(guardrails.encryptionConfig).toEqual([
      {
        resources: ['secrets'],
        provider: { keyArn: '${SecretsKeyArn}' },
      },
    ]);
  });
});
