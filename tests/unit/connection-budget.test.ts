import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueueName } from '@/lib/queues';
import {
  clientConnections,
  connectionBudgetLimit,
  RDS_MAX_CONNECTIONS,
  WEB_HPA_MAX_REPLICAS,
  WEB_HPA_MIN_REPLICAS,
  WEB_MAX_SURGE,
  WEB_POOL_MAX,
  WORKER_MAX_SURGE,
  WORKER_POOL_MAX,
  WORKER_QUEUE_CONCURRENCY,
  WORKER_REPLICAS,
} from '@/db/connection-budget';

const root = join(import.meta.dirname, '../..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function documents(path: string): string[] {
  return read(path).split(/^---$/m);
}

function documentNamed(path: string, name: string): string {
  const doc = documents(path).find((entry) =>
    new RegExp(`^\\s*name:\\s*${name}\\s*$`, 'm').test(entry),
  );
  if (!doc) throw new Error(`${path} has no document named ${name}`);
  return doc;
}

function field(doc: string, key: string): string {
  const match = doc.match(new RegExp(`^\\s*${key}:\\s*'?([^'\\n#]+)`, 'm'));
  if (!match?.[1]) throw new Error(`missing ${key}`);
  return match[1].trim();
}

function envValue(doc: string, name: string): string {
  const match = doc.match(new RegExp(`- name: ${name}\\s+value: '?([^'\\n]+)'?`));
  if (!match?.[1]) throw new Error(`missing env ${name}`);
  return match[1].trim();
}

describe('database connection budget', () => {
  it('keeps HPA max and rollout surge within 70% of max_connections', () => {
    const steady = clientConnections({
      webReplicas: WEB_HPA_MAX_REPLICAS,
      workerReplicas: WORKER_REPLICAS,
    });
    const surge = clientConnections({
      webReplicas: WEB_HPA_MAX_REPLICAS + WEB_MAX_SURGE,
      workerReplicas: WORKER_REPLICAS + WORKER_MAX_SURGE,
    });
    const limit = connectionBudgetLimit();

    expect(steady).toBeLessThanOrEqual(limit);
    expect(surge).toBeLessThanOrEqual(limit);
    expect(limit).toBe(Math.floor(RDS_MAX_CONNECTIONS * 0.7));
    expect(WORKER_POOL_MAX).toBeGreaterThanOrEqual(
      Object.keys(QueueName).length * WORKER_QUEUE_CONCURRENCY,
    );
  });

  it('matches the EKS manifests', () => {
    const hpa = documentNamed('infra/k8s/autoscaling.yaml', 'blakpath-app');
    const web = documentNamed('infra/k8s/web-deployment.yaml', 'blakpath-app');
    const worker = documentNamed('infra/k8s/worker-deployment.yaml', 'blakpath-worker');
    const config = read('infra/k8s/configmap.yaml');

    expect(field(hpa, 'minReplicas')).toBe(String(WEB_HPA_MIN_REPLICAS));
    expect(field(hpa, 'maxReplicas')).toBe(String(WEB_HPA_MAX_REPLICAS));
    expect(field(web, 'maxSurge')).toBe(String(WEB_MAX_SURGE));
    expect(field(worker, 'replicas')).toBe(String(WORKER_REPLICAS));
    expect(field(worker, 'maxSurge')).toBe(String(WORKER_MAX_SURGE));
    expect(field(config, 'DATABASE_POOL_MAX')).toBe(String(WEB_POOL_MAX));
    expect(envValue(worker, 'BLAKPATH_PROCESS')).toBe('worker');
    expect(envValue(worker, 'DATABASE_WORKER_POOL_MAX')).toBe(String(WORKER_POOL_MAX));
    expect(read('Dockerfile')).toContain('certs/rds-global-bundle.pem');
  });
});
