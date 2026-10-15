import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const scanner = readFileSync('infra/k8s/base/clamav.yaml', 'utf8');
const mirror = readFileSync('infra/k8s/base/clamav-mirror.yaml', 'utf8');
const worker = readFileSync('infra/k8s/base/worker-deployment.yaml', 'utf8');
const kustomization = readFileSync('infra/k8s/base/kustomization.yaml', 'utf8');

describe('ClamAV production manifests', () => {
  it('runs two replicas with a disruption budget and node anti-affinity', () => {
    expect(scanner).toContain('replicas: 2');
    expect(scanner).toContain('minAvailable: 1');
    expect(scanner).toContain('kubernetes.io/hostname');
    expect(scanner).toContain('requiredDuringSchedulingIgnoredDuringExecution');
  });

  it('keeps the Service empty until clamd answers PING', () => {
    expect(scanner).toContain('publishNotReadyAddresses: false');
    expect(scanner).toContain('startupProbe:');
    expect(scanner).toContain('failureThreshold: 180');
    expect(scanner).toContain('readinessProbe:');
    expect(scanner).toContain('echo PING | nc -w 2 127.0.0.1 3310 | grep -q PONG');
    expect(scanner).not.toContain('livenessProbe:');
  });

  it('avoids a reload OOM and a signature download on every start', () => {
    expect(scanner).toContain('ConcurrentDatabaseReload no');
    expect(scanner).toContain('memory: 4Gi');
    expect(scanner).toContain('volumeClaimTemplates:');
    expect(scanner).toContain('PrivateMirror http://blakpath-clamav-mirror:8080');
    expect(mirror).toContain('DatabaseMirror database.clamav.net');
    expect(mirror).toContain('claimName: blakpath-clamav-mirror');
  });

  it('pins images by digest and runs as the image clamav user', () => {
    expect(scanner).toMatch(/image: clamav\/clamav-debian:1\.4_base@sha256:[a-f0-9]{64}/);
    expect(mirror).toMatch(/image: nginxinc\/nginx-unprivileged:\S+@sha256:[a-f0-9]{64}/);
    expect(scanner).toContain('runAsNonRoot: true');
    expect(scanner).toContain('runAsUser: 1000');
    expect(scanner).toContain("command: ['/init-unprivileged']");
    expect(scanner).not.toContain('clamav/clamav-debian:1.4\n');
  });

  it('gives ClamAV its own ServiceAccount and no cloud credentials', () => {
    expect(scanner).toContain('name: blakpath-clamav');
    expect(scanner).toContain('serviceAccountName: blakpath-clamav');
    expect(scanner).toContain('automountServiceAccountToken: false');
    expect(scanner).not.toContain('eks.amazonaws.com/role-arn');
    expect(scanner).not.toContain('blakpath-runtime');
    expect(mirror).toContain('serviceAccountName: blakpath-clamav');
    expect(mirror).not.toContain('eks.amazonaws.com/role-arn');
    expect(worker).not.toContain('blakpath-clamav');
    expect(worker).not.toContain('clamav/clamav');
  });

  it('allows clamd only from web and worker, and blocks link-local metadata', () => {
    expect(scanner).toContain('kind: NetworkPolicy');
    expect(scanner).toContain('app.kubernetes.io/name: blakpath-app');
    expect(scanner).toContain('app.kubernetes.io/name: blakpath-worker');
    expect(scanner).toContain('port: 3310');
    expect(scanner).not.toContain('0.0.0.0/0');
    expect(scanner).not.toContain('169.254.169.254');
    expect(mirror).toContain('app.kubernetes.io/name: blakpath-clamav');
    expect(mirror).toContain('port: 8080');
    expect(mirror).toContain('169.254.0.0/16');
    expect(kustomization).toContain('clamav.yaml');
    expect(kustomization).toContain('clamav-mirror.yaml');
  });
});
