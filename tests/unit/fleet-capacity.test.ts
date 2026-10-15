import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALB_DRAIN_SECONDS,
  WEB_MAX_SURGE,
  WEB_TERMINATION_GRACE_PERIOD_SECONDS,
  WORKER_REPLICAS,
  WORKER_SHUTDOWN_GRACE_SECONDS,
  WORKER_TERMINATION_GRACE_PERIOD_SECONDS,
} from '@/db/connection-budget';

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

function workload(yaml: string, kind: string, name: string): string {
  const doc = documents(yaml).find(
    (item) => item.includes(`kind: ${kind}`) && item.includes(`\n  name: ${name}\n`),
  );
  if (!doc) throw new Error(`missing ${kind} ${name}`);
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

describe('rollout drain', () => {
  const web = workload(
    read('infra/k8s/base/web-deployment.yaml'),
    'Deployment',
    'blakpath-app',
  );
  const worker = workload(
    read('infra/k8s/base/worker-deployment.yaml'),
    'Deployment',
    'blakpath-worker',
  );
  const clamav = workload(
    read('infra/k8s/base/clamav.yaml'),
    'StatefulSet',
    'blakpath-clamav',
  );

  it('keeps the web grace period longer than the ALB drain and the worker drain', () => {
    expect(ALB_DRAIN_SECONDS).toBe(15);
    expect(WORKER_SHUTDOWN_GRACE_SECONDS).toBe(25);
    expect(WEB_TERMINATION_GRACE_PERIOD_SECONDS).toBe(
      ALB_DRAIN_SECONDS + WORKER_SHUTDOWN_GRACE_SECONDS,
    );
    expect(WORKER_TERMINATION_GRACE_PERIOD_SECONDS).toBeGreaterThan(
      WORKER_SHUTDOWN_GRACE_SECONDS,
    );
  });

  it('injects the ALB readiness gate on both namespace overlays', () => {
    for (const overlay of ['production', 'staging']) {
      expect(read(`infra/k8s/overlays/${overlay}/namespace.yaml`)).toContain(
        'elbv2.k8s.aws/pod-readiness-gate-inject: enabled',
      );
    }
  });

  it('drains web for the same interval the ALB deregisters targets', () => {
    expect(web).toContain(
      `terminationGracePeriodSeconds: ${WEB_TERMINATION_GRACE_PERIOD_SECONDS}`,
    );
    expect(web).toContain(`sleep ${ALB_DRAIN_SECONDS}`);
    expect(web).toContain('preStop:');
    expect(web).toContain(`maxSurge: ${WEB_MAX_SURGE}`);
    expect(web).toContain('maxUnavailable: 0');
    expect(read('infra/k8s/base/service-ingress.yaml')).toContain(
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
});
