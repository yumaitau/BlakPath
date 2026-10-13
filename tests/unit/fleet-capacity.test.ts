import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALB_DRAIN_SECONDS,
  CONNECTION_BUDGET_RATIO,
  DATABASE_POOL_MAX,
  MIGRATION_CONNECTIONS,
  RDS_FLOOR_MEMORY_BYTES,
  RDS_MAX_CONNECTIONS_DIVISOR,
  TERMINATION_GRACE_PERIOD_SECONDS,
  WEB_MAX_SURGE,
  WEB_MIN_REPLICAS,
  WORKER_REPLICAS,
  WORKER_SHUTDOWN_GRACE_SECONDS,
  WORKER_TERMINATION_GRACE_PERIOD_SECONDS,
  maxWebReplicas,
  peakDbConnections,
  rdsDefaultMaxConnections,
} from '@/lib/fleet-capacity';

const root = fileURLToPath(new URL('../..', import.meta.url));

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

function documents(yaml: string): string[] {
  return yaml
    .split(/\n---\n/)
    .map((doc) => doc.trim())
    .filter((doc) => doc.includes('apiVersion:'));
}

function deployment(yaml: string, name: string): string {
  const doc = documents(yaml).find(
    (item) => item.includes('kind: Deployment') && item.includes(`\n  name: ${name}\n`),
  );
  if (!doc) throw new Error(`missing Deployment ${name}`);
  return doc;
}

function expectHardSpread(doc: string, appName: string) {
  for (const key of [
    'topologyKey: topology.kubernetes.io/zone',
    'topologyKey: kubernetes.io/hostname',
  ]) {
    const keyAt = doc.indexOf(key);
    expect(keyAt).toBeGreaterThan(-1);
    const block = doc.slice(Math.max(0, keyAt - 40), keyAt + 220);
    expect(block).toContain('maxSkew: 1');
    expect(block).toContain('whenUnsatisfiable: DoNotSchedule');
    expect(block).toContain(`app.kubernetes.io/name: ${appName}`);
  }
}

describe('database connection budget', () => {
  it('uses the RDS 1 GiB default max_connections', () => {
    expect(RDS_FLOOR_MEMORY_BYTES / RDS_MAX_CONNECTIONS_DIVISOR).toBeGreaterThan(112);
    expect(rdsDefaultMaxConnections(RDS_FLOOR_MEMORY_BYTES)).toBe(112);
    expect(rdsDefaultMaxConnections(2 * RDS_FLOOR_MEMORY_BYTES)).toBe(225);
  });

  it('sets web HPA max to the largest count that stays under 80%', () => {
    const maxConnections = rdsDefaultMaxConnections(RDS_FLOOR_MEMORY_BYTES);
    const webMax = maxWebReplicas();
    const peak = peakDbConnections(webMax);

    expect(webMax).toBe(4);
    expect(webMax).toBeGreaterThanOrEqual(WEB_MIN_REPLICAS);
    expect(peak).toBe(81);
    expect(peak).toBeLessThan(maxConnections * CONNECTION_BUDGET_RATIO);
    expect(peakDbConnections(webMax + 1)).toBeGreaterThanOrEqual(
      maxConnections * CONNECTION_BUDGET_RATIO,
    );
    // Steady state at HPA max, no rollout surge and no migrate job.
    expect((webMax + WORKER_REPLICAS) * DATABASE_POOL_MAX).toBe(60);
    expect(MIGRATION_CONNECTIONS).toBe(1);
  });

  it('keeps the web grace period longer than the ALB drain and the worker drain', () => {
    expect(ALB_DRAIN_SECONDS).toBe(15);
    expect(WORKER_SHUTDOWN_GRACE_SECONDS).toBe(25);
    expect(TERMINATION_GRACE_PERIOD_SECONDS).toBe(
      ALB_DRAIN_SECONDS + WORKER_SHUTDOWN_GRACE_SECONDS,
    );
    expect(WORKER_TERMINATION_GRACE_PERIOD_SECONDS).toBeGreaterThan(
      WORKER_SHUTDOWN_GRACE_SECONDS,
    );
  });
});

describe('k8s rollout manifests', () => {
  const web = deployment(read('infra/k8s/web-deployment.yaml'), 'blakpath-app');
  const workerYaml = read('infra/k8s/worker-deployment.yaml');
  const worker = deployment(workerYaml, 'blakpath-worker');
  const clamav = deployment(workerYaml, 'blakpath-clamav');

  it('injects the ALB readiness gate on the namespace', () => {
    expect(read('infra/k8s/namespace.yaml')).toContain(
      'elbv2.k8s.aws/pod-readiness-gate-inject: enabled',
    );
  });

  it('drains web for the same interval the ALB deregisters targets', () => {
    expect(web).toContain(
      `terminationGracePeriodSeconds: ${TERMINATION_GRACE_PERIOD_SECONDS}`,
    );
    expect(web).toContain(`sleep ${ALB_DRAIN_SECONDS}`);
    expect(web).toContain('preStop:');
    expect(web).toContain(`maxSurge: ${WEB_MAX_SURGE}`);
    expect(web).toContain('maxUnavailable: 0');
    expect(read('infra/k8s/service-ingress.yaml')).toContain(
      `deregistration_delay.timeout_seconds=${ALB_DRAIN_SECONDS}`,
    );
  });

  it('hard-spreads web, worker and ClamAV across zones and nodes', () => {
    expectHardSpread(web, 'blakpath-app');
    expectHardSpread(worker, 'blakpath-worker');
    expectHardSpread(clamav, 'blakpath-clamav');
    expect(worker).toContain(`replicas: ${WORKER_REPLICAS}`);
    expect(worker).toContain('maxSurge: 1');
    expect(worker).toContain('maxUnavailable: 0');
    expect(worker).not.toMatch(/^\s*preStop:/m);
    expect(worker).toContain(
      `terminationGracePeriodSeconds: ${WORKER_TERMINATION_GRACE_PERIOD_SECONDS}`,
    );
  });

  it('pins HPA max and the pool to the connection budget', () => {
    const hpa = documents(read('infra/k8s/autoscaling.yaml')).find((doc) =>
      doc.includes('kind: HorizontalPodAutoscaler'),
    );
    expect(hpa).toBeDefined();
    expect(hpa).toContain(`minReplicas: ${WEB_MIN_REPLICAS}`);
    expect(hpa).toContain(`maxReplicas: ${maxWebReplicas()}`);
    expect(read('infra/k8s/configmap.yaml')).toContain(
      `DATABASE_POOL_MAX: '${DATABASE_POOL_MAX}'`,
    );
    for (const doc of [web, worker]) {
      expect(doc).toContain('name: DATABASE_POOL_MAX');
      expect(doc).toContain('key: DATABASE_POOL_MAX');
    }
    expect(read('infra/k8s/secret.example.yaml')).not.toContain('DATABASE_POOL_MAX');
  });
});
