import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_BUDGET_RATIO,
  DATA_TIER_CAPACITY,
  DATABASE_POOL_MAX,
  MIGRATE_POOL_MAX,
  ONE_SHOT_JOBS,
  REPLICA_WORKLOADS,
  connectionBudgetLimit,
  peakConnections,
  steadyReplicaConnections,
  withinConnectionBudget,
} from '@/lib/data-tier-capacity';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('data tier connection budget', () => {
  it('keeps steady and peak pools inside 70% of max_connections', () => {
    const steady = steadyReplicaConnections();
    const peak = peakConnections();

    expect(steady).toBe(60);
    expect(peak).toBe(91);
    expect(connectionBudgetLimit()).toBe(140);
    expect(CONNECTION_BUDGET_RATIO).toBe(0.7);
    expect(withinConnectionBudget(steady)).toBe(true);
    expect(withinConnectionBudget(peak)).toBe(true);
    expect(peak).toBeLessThanOrEqual(connectionBudgetLimit());
  });

  it('matches the pool and replica settings the manifests actually ship', () => {
    const web = REPLICA_WORKLOADS[0];
    const worker = REPLICA_WORKLOADS[1];
    const migrate = ONE_SHOT_JOBS[0];
    const seed = ONE_SHOT_JOBS[1];

    expect(web).toMatchObject({ name: 'blakpath-app', maxReplicas: 4, rolloutSurge: 1 });
    expect(worker).toMatchObject({
      name: 'blakpath-worker',
      maxReplicas: 2,
      rolloutSurge: 1,
    });
    expect(migrate?.poolMax).toBe(MIGRATE_POOL_MAX);
    expect(seed?.poolMax).toBe(DATABASE_POOL_MAX);

    expect(source('infra/k8s/autoscaling.yaml')).toContain(
      `maxReplicas: ${web?.maxReplicas}`,
    );
    expect(source('infra/k8s/web-deployment.yaml')).toContain(
      `maxSurge: ${web?.rolloutSurge}`,
    );
    expect(source('infra/k8s/worker-deployment.yaml')).toContain(
      `replicas: ${worker?.maxReplicas}`,
    );
    expect(source('infra/k8s/worker-deployment.yaml')).not.toContain('maxSurge:');
    expect(source('infra/k8s/configmap.yaml')).toContain(
      `DATABASE_POOL_MAX: '${DATABASE_POOL_MAX}'`,
    );
    expect(source('src/db/client.ts')).toContain('max: env.DATABASE_POOL_MAX');
    expect(source('src/db/client.ts')).toContain('prepare: true');
    expect(source('src/db/migrate.ts')).toContain(`max: ${MIGRATE_POOL_MAX}`);
    expect(source('src/lib/env.ts')).toContain(
      `DATABASE_POOL_MAX: z.coerce.number().int().positive().default(${DATABASE_POOL_MAX})`,
    );
  });
});

describe('data tier CloudFormation example', () => {
  const template = source('infra/aws/data-tier.example.yaml');

  it('encodes the RDS controls from issue 53', () => {
    const postgres = DATA_TIER_CAPACITY.postgres;
    expect(template).toContain(`Default: ${postgres.instanceClass}`);
    expect(template).toContain(`Default: '${postgres.engineVersion}'`);
    expect(template).toContain(`Family: ${postgres.parameterGroupFamily}`);
    expect(template).toMatch(
      new RegExp(`max_connections:\\s+['"]${postgres.maxConnections}['"]`),
    );
    expect(template).toMatch(/rds\.force_ssl:\s+['"]1['"]/);
    expect(template).toContain(`BackupRetentionPeriod: ${postgres.backupRetentionDays}`);
    expect(template).toContain('MultiAZ: true');
    expect(template).toContain('DeletionProtection: true');
    expect(template).toContain('PubliclyAccessible: false');
    expect(template).toContain('StorageEncrypted: true');
    expect(template).toContain('EnablePerformanceInsights: true');
    expect(template).toContain('ManageMasterUserPassword: true');
    expect(template).toContain('KmsKeyId: !GetAtt RdsKey.Arn');
    expect(template).not.toMatch(/Type:\s*AWS::RDS::DBProxy/);
    expect(template).not.toContain('alias/aws/rds');
    expect(template).not.toMatch(/KmsKeyId:.*aws\/rds/);
    expect(template).not.toContain('PubliclyAccessible: true');
    expect(template).not.toContain('DeletionProtection: false');
    expect(template).not.toContain('MultiAZ: false');
  });

  it('encodes TLS, AUTH, failover and noeviction for Redis', () => {
    const redis = DATA_TIER_CAPACITY.redis;
    expect(template).toContain(`Default: ${redis.nodeType}`);
    expect(template).toContain(`Default: '${redis.engineVersion}'`);
    expect(template).toContain(
      `CacheParameterGroupFamily: ${redis.parameterGroupFamily}`,
    );
    expect(template).toContain(`NumCacheClusters: ${redis.nodeCount}`);
    expect(template).toContain(`maxmemory-policy: ${redis.maxmemoryPolicy}`);
    expect(template).toContain(`SnapshotRetentionLimit: ${redis.snapshotRetentionLimit}`);
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

  it('points the runtime secret example at TLS endpoints', () => {
    const example = source('infra/k8s/secret.example.yaml');
    expect(example).toContain('sslmode=require');
    expect(example).toContain('rediss://:CHANGEME@');
    expect(example).not.toContain('redis://');
  });
});
