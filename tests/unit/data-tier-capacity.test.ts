import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RDS_MAX_CONNECTIONS } from '@/db/connection-budget';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

/** Instance memory (GiB) for classes the template may default to. */
const INSTANCE_MEMORY_GIB: Record<string, number> = {
  'db.t4g.small': 2,
  'db.t4g.medium': 4,
  'db.m7g.large': 8,
  'db.r7g.large': 16,
};

/** RDS PostgreSQL default: LEAST({DBInstanceClassMemory/9531392}, 5000). */
function defaultMaxConnections(memoryGib: number): number {
  return Math.min(Math.floor((memoryGib * 1024 ** 3) / 9531392), 5000);
}

const template = source('infra/aws/data-tier.example.yaml');

function parameterDefault(name: string): string {
  const match = template.match(
    new RegExp(`^  ${name}:\\n(?:    .*\\n)*?    Default: '?([^'\\n]+)'?$`, 'm'),
  );
  if (!match?.[1]) throw new Error(`missing default for ${name}`);
  return match[1].trim();
}

describe('data tier CloudFormation example', () => {
  it('fits the production connection budget', () => {
    const instanceClass = parameterDefault('DbInstanceClass');
    const memory = INSTANCE_MEMORY_GIB[instanceClass];
    expect(memory, `unknown class ${instanceClass}`).toBeDefined();
    expect(defaultMaxConnections(memory ?? 0)).toBeGreaterThanOrEqual(
      RDS_MAX_CONNECTIONS,
    );
    // The budget assumes the instance-class default. A pin would override it.
    expect(template).not.toMatch(/^\s*max_connections:/m);
  });

  it('encodes the RDS controls from issue 53', () => {
    expect(parameterDefault('DbInstanceClass')).toBe('db.m7g.large');
    expect(parameterDefault('PostgresEngineVersion')).toMatch(/^16\./);
    expect(template).toContain('Family: postgres16');
    expect(template).toMatch(/rds\.force_ssl:\s+['"]1['"]/);
    expect(template).toContain('BackupRetentionPeriod: 21');
    expect(template).toContain('MultiAZ: true');
    expect(template).toContain('DeletionProtection: true');
    expect(template).toContain('PubliclyAccessible: false');
    expect(template).toContain('StorageEncrypted: true');
    expect(template).toContain('EnablePerformanceInsights: true');
    expect(template).toContain('PerformanceInsightsKMSKeyId: !GetAtt RdsKey.Arn');
    expect(template).toContain('ManageMasterUserPassword: true');
    expect(template).toContain('KmsKeyId: !GetAtt RdsKey.Arn');
    expect(template).not.toContain('alias/aws/rds');
    expect(template).not.toMatch(/KmsKeyId:.*aws\/rds/);
    expect(template).not.toContain('PubliclyAccessible: true');
    expect(template).not.toContain('DeletionProtection: false');
    expect(template).not.toContain('MultiAZ: false');
  });

  it('encodes TLS, AUTH, failover and noeviction for Redis', () => {
    expect(parameterDefault('RedisNodeType')).toBe('cache.m7g.large');
    expect(parameterDefault('RedisEngineVersion')).toMatch(/^7\./);
    expect(template).toContain('CacheParameterGroupFamily: redis7');
    expect(template).toContain('NumCacheClusters: 2');
    expect(template).toContain('maxmemory-policy: noeviction');
    expect(template).toContain('SnapshotRetentionLimit: 0');
    expect(template).toContain('TransitEncryptionEnabled: true');
    expect(template).toContain('AtRestEncryptionEnabled: true');
    expect(template).toContain('AuthToken:');
    expect(template).toContain('AutomaticFailoverEnabled: true');
    expect(template).toContain('MultiAZEnabled: true');
    expect(template).toContain('KmsKeyId: !GetAtt RedisKey.Arn');
    expect(template).not.toContain('UserGroupIds:');
    expect(template).not.toContain('maxmemory-policy: allkeys');
    expect(template).not.toContain('NumNodeGroups:');
  });

  it('points the runtime secret example at verified TLS endpoints', () => {
    const example = source('infra/k8s/secret.example.yaml');
    expect(example).toContain('sslmode=verify-full');
    expect(example).not.toContain('sslmode=require');
    expect(example).toContain('rediss://:CHANGEME@');
    expect(example).not.toContain('redis://');
  });
});
