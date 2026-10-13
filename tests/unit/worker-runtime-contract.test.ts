import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUEUE_PREFIX, QueueName } from '@/lib/queues';
import {
  LONGEST_JOB_MS,
  SHUTDOWN_GRACE_MS,
  TERMINATION_GRACE_SECONDS,
} from '../../worker/runtime';

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function workerStage(dockerfile: string): string {
  const stage = dockerfile
    .split(/\n(?=FROM )/)
    .find((part) => part.startsWith('FROM runtime AS worker'));
  if (!stage) throw new Error('worker runtime stage missing');
  return stage
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

describe('worker runtime contract', () => {
  it('keeps the drain longer than the longest job and the pod grace longer than the drain', () => {
    expect(SHUTDOWN_GRACE_MS).toBeGreaterThan(LONGEST_JOB_MS);
    expect(TERMINATION_GRACE_SECONDS).toBeGreaterThan(SHUTDOWN_GRACE_MS / 1000);

    const deployment = read('infra/k8s/worker-deployment.yaml');
    expect(deployment).toContain(
      `terminationGracePeriodSeconds: ${TERMINATION_GRACE_SECONDS}`,
    );
    const workerContainer =
      deployment.split('- name: worker')[1]?.split('envFrom:')[0] ?? '';
    // Probe `command:` keys come later. This is the container command, which
    // would replace tini if set.
    expect(workerContainer).not.toMatch(/^\s*command:/m);
    expect(deployment).not.toContain('tsx');
    expect(deployment).toContain('/app/scripts/worker-liveness.sh');
    expect(deployment).toContain('livenessProbe:');
    expect(deployment).toContain('startupProbe:');

    for (const compose of ['docker-compose.yml', 'docker-compose.prod.example.yml']) {
      const text = read(compose);
      expect(text).toContain(`stop_grace_period: ${TERMINATION_GRACE_SECONDS}s`);
      expect(text).toContain('/app/scripts/worker-liveness.sh');
    }
  });

  it('runs the bundled worker under tini without dev tooling in the runtime stage', () => {
    const stage = workerStage(read('Dockerfile'));
    expect(stage).toContain('ENTRYPOINT ["/sbin/tini", "--"]');
    expect(stage).toContain('CMD ["node", "dist/worker.js"]');
    expect(stage).toContain('scripts/worker-liveness.sh');
    for (const forbidden of ['pnpm', 'npm', 'tsx', 'vitest', 'eslint']) {
      expect(stage).not.toContain(forbidden);
    }
  });

  it('publishes a worker PDB and scales every queue wait list', () => {
    const autoscaling = read('infra/k8s/autoscaling.yaml');
    expect(autoscaling).toContain('name: blakpath-worker');
    expect(autoscaling).toMatch(/kind: PodDisruptionBudget[\s\S]*name: blakpath-worker/);

    const scaled = read('infra/k8s/worker-scaledobject.yaml');
    expect(read('infra/k8s/kustomization.yaml')).toContain('worker-scaledobject.yaml');
    for (const name of Object.values(QueueName)) {
      expect(scaled).toContain(`listName: ${QUEUE_PREFIX}:${name}:wait`);
    }
  });

  it('scans the worker image in CI as well as the web image', () => {
    const workflow = read('.github/workflows/security.yml');
    expect(workflow).toContain('target: runner');
    expect(workflow).toContain('target: worker');
    expect(workflow).toContain('image-ref: blakpath:ci');
    expect(workflow).toContain('image-ref: blakpath-worker:ci');
    expect(workflow.match(/exit-code: '1'/g)).toHaveLength(2);
  });
});
