import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function probeBlock(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}:\\n((?: {12}.+\\n)*)`));
  expect(match, `${name} block`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('probe manifests', () => {
  const deployment = readFileSync('infra/k8s/base/web-deployment.yaml', 'utf8');
  const ingress = readFileSync('infra/k8s/base/service-ingress.yaml', 'utf8');
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const prodCompose = readFileSync('docker-compose.prod.example.yml', 'utf8');

  it('uses dependency-free liveness and a bounded readiness probe', () => {
    for (const name of ['startupProbe', 'livenessProbe'] as const) {
      const block = probeBlock(deployment, name);
      expect(block).toContain('path: /api/live');
      expect(block).toContain('timeoutSeconds: 3');
    }
    const readiness = probeBlock(deployment, 'readinessProbe');
    expect(readiness).toContain('path: /api/ready');
    expect(readiness).toContain('timeoutSeconds: 3');
    expect(readiness).toContain('failureThreshold: 3');
    expect(probeBlock(deployment, 'livenessProbe')).toContain('failureThreshold: 3');
    expect(deployment).not.toContain('/api/health');
  });

  it('refuses detailed health at the edge and leaves the ALB on /api/ready', () => {
    expect(ingress).toContain('alb.ingress.kubernetes.io/healthcheck-path: /api/ready');
    expect(ingress).toContain('path: /api/health');
    expect(ingress).toContain('name: health-forbidden');
    expect(ingress).toContain('name: use-annotation');
    expect(ingress).toContain('"statusCode":"403"');
  });

  it('points container healthchecks at liveness', () => {
    expect(dockerfile).toContain('/api/live');
    expect(dockerfile).not.toContain('/api/health');
    expect(prodCompose).toContain('http://127.0.0.1:3000/api/live');
    expect(prodCompose).not.toContain('/api/health');
  });
});
